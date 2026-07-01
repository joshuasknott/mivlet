import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  CalendarPlus,
  Clock,
  PencilSimple,
  Play,
  Spinner,
  Trash,
  WarningCircle
} from "@phosphor-icons/react";
import type {
  ConnectorManifest,
  MissedRunPolicy,
  ScheduledJob,
  SchedulerQueueEntry,
  ScheduleWeekday,
  WorkflowRun
} from "@fable/protocol";
import { nextOccurrence, validateScheduleTrigger } from "@fable/connectors";
import {
  DEFAULT_FORM_VALUE,
  ScheduleFormValue,
  ScheduleListState,
  ScheduleFormRecurrence,
  RecurrenceFrequency,
  summarizeConnectorPermissions,
  summarizeRecurrence,
  summarizeRoute,
  validateForm,
  buildTrigger,
  classifySchedule,
  attentionRuns
} from "../lib/schedule-client";

const WEEKDAYS: ScheduleWeekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Schedules management panel.
 *
 * One create form (name / prompt / recurrence) and a list of saved schedules.
 * Recurrence covers daily / weekly / monthly / once, matching the /schedule
 * command vocabulary. The captured backend/model/permission route is shown
 * read-only per schedule (it is auto-captured at create time). Pause/resume
 * requires a confirmation step so an enabled schedule is not paused by accident.
 *
 * The runtime stays the single mutation boundary: every change flows through
 * the callbacks the hook owns. This component only shapes the form value and
 * classifies jobs for display.
 */
export function SchedulePanel({
  jobs = [],
  runs = [],
  queue = [],
  connectors = [],
  loading = false,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onCancelRun
}: {
  jobs?: ScheduledJob[];
  runs?: WorkflowRun[];
  queue?: SchedulerQueueEntry[];
  /** Connected connector manifests the form may compose into the workflow. */
  connectors?: ConnectorManifest[];
  /** True while persisted jobs are being hydrated from the Rust store. */
  loading?: boolean;
  onCreate: (input: {
    name: string;
    description: string;
    trigger: SchedulePanelTrigger;
    missedRunPolicy?: MissedRunPolicy;
    connectorIds?: string[];
  }) => void;
  onEdit: (input: {
    jobId: string;
    name: string;
    description: string;
    trigger: SchedulePanelTrigger;
    missedRunPolicy?: MissedRunPolicy;
    connectorIds?: string[];
  }) => void;
  onToggle: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onRunNow?: (job: ScheduledJob) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const [form, setForm] = useState<ScheduleFormValue>(DEFAULT_FORM_VALUE);
  const [submitted, setSubmitted] = useState(false);

  const validation = useMemo(() => validateForm(form), [form]);
  const draftTrigger = useMemo(() => buildTrigger(form, TIMEZONE), [form]);
  // The next-run preview runs the recurrence scan, which is comparatively
  // expensive. Memoize on the trigger-relevant fields only (not the text the
  // user is typing) so filling in the name/prompt never re-scans. Validate
  // first — nextOccurrence throws on an invalid trigger, and the user passes
  // through invalid states while editing (e.g. clearing the monthly day).
  const triggerKey = `${form.triggerKind}|${form.onceAt}|${form.recurrence.frequency}|${form.recurrence.time}|${form.recurrence.weekdays.join(",")}|${form.recurrence.monthDay}`;
  const nextRunPreview = useMemo(() => {
    if (!draftTrigger || validateScheduleTrigger(draftTrigger)) return null;
    const next = nextOccurrence(draftTrigger, new Date());
    return next ? next.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey]);

  const resetForm = () => {
    setForm(DEFAULT_FORM_VALUE);
    setSubmitted(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!validation.valid || !draftTrigger) return;
    onCreate({
      name: form.name.trim(),
      description: form.prompt.trim(),
      trigger: draftTrigger,
      missedRunPolicy: form.missedRunPolicy,
      connectorIds: form.connectorIds
    });
    resetForm();
  };

  return (
    <section className="schedule-panel" aria-label="Schedules">
      <ScheduleForm
        form={form}
        onChange={setForm}
        submitted={submitted}
        validation={validation}
        nextRunPreview={nextRunPreview}
        connectors={connectors}
        onSubmit={submit}
        onCancel={resetForm}
      />

      {loading ? (
        <div className="page-loading" role="status" aria-live="polite">
          <Spinner size={16} aria-hidden="true" />
          <span>Loading schedules…</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="schedule-empty">
          <CalendarPlus size={28} weight="duotone" aria-hidden="true" />
          <p>No schedules yet. Create one above.</p>
        </div>
      ) : (
        <ul className="schedule-list" aria-label="Saved schedules">
          {jobs.map((job) => (
            <ScheduleRow
              key={job.id}
              job={job}
              runs={runs}
              queue={queue}
              connectors={connectors}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
              onRunNow={onRunNow}
              onCancelRun={onCancelRun}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Local trigger alias so the page can pass the runtime's wire trigger type. */
export type SchedulePanelTrigger =
  | { kind: "once"; at: string }
  | { kind: "recurring"; rule: import("@fable/protocol").RecurrenceRule };

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

function ScheduleForm({
  form,
  onChange,
  submitted,
  validation,
  nextRunPreview,
  connectors,
  onSubmit,
  onCancel
}: {
  form: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
  submitted: boolean;
  validation: ReturnType<typeof validateForm>;
  nextRunPreview: string | null;
  connectors: ConnectorManifest[];
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const showErrors = submitted;
  return (
    <form className="schedule-form" onSubmit={onSubmit} aria-label="Create a schedule">
      <div className="schedule-form__row">
        <FieldLabel htmlFor="schedule-name">Task name</FieldLabel>
        <input
          id="schedule-name"
          className="schedule-form__input"
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          placeholder="Weekly digest"
          aria-label="Schedule task name"
          aria-invalid={showErrors ? !validation.valid : undefined}
        />
        {showErrors && validation.errors.name ? (
          <FieldError>{validation.errors.name}</FieldError>
        ) : null}
      </div>

      <div className="schedule-form__row">
        <FieldLabel htmlFor="schedule-prompt">What should the agent do?</FieldLabel>
        <textarea
          id="schedule-prompt"
          className="schedule-form__textarea"
          value={form.prompt}
          onChange={(event) => onChange({ ...form, prompt: event.target.value })}
          placeholder="Summarize active projects, new memory, and approvals into a digest."
          aria-label="Schedule description"
          rows={3}
        />
        {showErrors && validation.errors.prompt ? (
          <FieldError>{validation.errors.prompt}</FieldError>
        ) : null}
      </div>

      <RecurrenceControls form={form} onChange={onChange} />
      {showErrors && validation.errors.trigger ? (
        <FieldError>{validation.errors.trigger}</FieldError>
      ) : null}

      <ConnectorControls form={form} onChange={onChange} connectors={connectors} />

      {nextRunPreview ? (
        <p className="schedule-form__preview" aria-live="polite">
          Next run {nextRunPreview}
        </p>
      ) : null}

      <div className="schedule-form__actions">
        <button
          type="submit"
          className="schedule-form__submit button button--primary"
          disabled={submitted && !validation.valid}
        >
          Create schedule
        </button>
        {form.name || form.prompt ? (
          <button type="button" className="schedule-form__cancel" onClick={onCancel}>
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );
}

function RecurrenceControls({
  form,
  onChange
}: {
  form: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
}) {
  const { recurrence, triggerKind, onceAt } = form;

  const setRecurrence = (patch: Partial<ScheduleFormRecurrence>) =>
    onChange({ ...form, recurrence: { ...recurrence, ...patch } });

  return (
    <fieldset className="schedule-form__recurrence">
      <legend className="schedule-form__legend">When</legend>
      <div className="schedule-form__row schedule-form__row--inline">
        <label className="schedule-form__field">
          <span className="schedule-form__label">Repeat</span>
          <select
            className="schedule-form__select"
            value={triggerKind}
            onChange={(event) =>
              onChange({ ...form, triggerKind: event.target.value as typeof triggerKind })
            }
            aria-label="Repeat"
          >
            <option value="recurring">Recurring</option>
            <option value="once">Once</option>
          </select>
        </label>

        {triggerKind === "once" ? (
          <label className="schedule-form__field">
            <span className="schedule-form__label">Run at</span>
            <input
              className="schedule-form__input"
              type="datetime-local"
              value={onceAt}
              onChange={(event) => onChange({ ...form, onceAt: event.target.value })}
              aria-label="Run at"
            />
          </label>
        ) : (
          <>
            <label className="schedule-form__field">
              <span className="schedule-form__label">Frequency</span>
              <select
                className="schedule-form__select"
                value={recurrence.frequency}
                onChange={(event) =>
                  setRecurrence({ frequency: event.target.value as RecurrenceFrequency })
                }
                aria-label="Frequency"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="schedule-form__field">
              <span className="schedule-form__label">Time</span>
              <input
                className="schedule-form__input schedule-form__input--time"
                type="time"
                value={recurrence.time}
                onChange={(event) => setRecurrence({ time: event.target.value })}
                aria-label="Time"
              />
            </label>
          </>
        )}
      </div>

      {triggerKind === "recurring" && recurrence.frequency === "weekly" ? (
        <div className="schedule-form__weekdays" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((weekday) => {
            const active = recurrence.weekdays.includes(weekday);
            return (
              <button
                key={weekday}
                type="button"
                className={`schedule-form__weekday${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() =>
                  setRecurrence({
                    weekdays: active
                      ? recurrence.weekdays.filter((day) => day !== weekday)
                      : [...recurrence.weekdays, weekday]
                  })
                }
              >
                {weekday}
              </button>
            );
          })}
        </div>
      ) : null}

      {triggerKind === "recurring" && recurrence.frequency === "monthly" ? (
        <label className="schedule-form__field schedule-form__field--inline">
          <span className="schedule-form__label">Day of month</span>
          <input
            className="schedule-form__input schedule-form__input--narrow"
            type="number"
            min={1}
            max={31}
            value={recurrence.monthDay}
            onChange={(event) =>
              setRecurrence({ monthDay: Number(event.target.value) })
            }
            aria-label="Day of month"
          />
        </label>
      ) : null}
    </fieldset>
  );
}

/**
 * Connector selection for the workflow. Only connected connectors with a read
 * capability are offered; selecting one adds a connector-read step that runs
 * before the prompt. Each chip shows a readable permission summary drawn from
 * the connector's manifest metadata. Hidden entirely when no connectors are
 * connected so the form stays minimal.
 */
function ConnectorControls({
  form,
  onChange,
  connectors
}: {
  form: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
  connectors: ConnectorManifest[];
}) {
  const selectable = connectors.filter(
    (connector) => connector.status === "connected" && connector.supportedActions?.length
  );
  if (selectable.length === 0) return null;
  const toggle = (connectorId: string) =>
    onChange({
      ...form,
      connectorIds: form.connectorIds.includes(connectorId)
        ? form.connectorIds.filter((id) => id !== connectorId)
        : [...form.connectorIds, connectorId]
    });
  return (
    <fieldset className="schedule-form__connectors">
      <legend className="schedule-form__legend">Data sources (optional)</legend>
      <div className="schedule-form__connector-list" role="group" aria-label="Connector data sources">
        {selectable.map((connector) => {
          const active = form.connectorIds.includes(connector.id);
          return (
            <button
              key={connector.id}
              type="button"
              className={`schedule-form__connector${active ? " is-active" : ""}`}
              aria-pressed={active}
              title={summarizeConnectorPermissions(connector.id, connectors)}
              onClick={() => toggle(connector.id)}
            >
              {connector.name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Schedule list row
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<ScheduleListState, string> = {
  enabled: "Enabled",
  paused: "Paused",
  invalid: "Invalid trigger",
  attention: "Needs attention"
};

function ScheduleRow({
  job,
  runs,
  queue,
  connectors,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onCancelRun
}: {
  job: ScheduledJob;
  runs: WorkflowRun[];
  queue: SchedulerQueueEntry[];
  connectors: ConnectorManifest[];
  onEdit: (input: {
    jobId: string;
    name: string;
    description: string;
    trigger: SchedulePanelTrigger;
    missedRunPolicy?: MissedRunPolicy;
    connectorIds?: string[];
  }) => void;
  onToggle: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onRunNow?: (job: ScheduledJob) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingPause, setConfirmingPause] = useState(false);
  const state = classifySchedule(job, runs);
  const triggerError =
    state === "invalid" ? (validateScheduleTrigger(job.trigger) ?? "Invalid trigger") : null;
  const attention = state === "attention" ? attentionRuns(job, runs)[0] : null;

  const liveEntry = useMemo(() => {
    return queue
      .filter((entry) => entry.jobId === job.id)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
      .find((entry) => ["queued", "leased", "running", "blocked-auth"].includes(entry.state));
  }, [queue, job.id]);

  return (
    <li className={`schedule-row schedule-row--${state}`} aria-label={`Schedule ${job.name}`}>
      <span className="schedule-row__icon" aria-hidden="true">
        <Clock size={18} />
      </span>
      <div className="schedule-row__body">
        {editing ? (
          <ScheduleEditForm
            job={job}
            connectors={connectors}
            onSave={(value) => {
              onEdit({
                jobId: job.id,
                name: value.name.trim(),
                description: value.prompt.trim(),
                trigger: buildTrigger(value, TIMEZONE) as SchedulePanelTrigger,
                missedRunPolicy: value.missedRunPolicy,
                connectorIds: value.connectorIds
              });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="schedule-row__heading">
              <strong>{job.name}</strong>
              <span className={`schedule-row__badge schedule-row__badge--${state}`}>
                {STATE_LABEL[state]}
              </span>
            </div>
            <span className="schedule-row__when">{summarizeRecurrence(job.trigger)}</span>
            {job.nextRunAt && job.status === "active" ? (
              <span className="schedule-row__next">
                Next {new Date(job.nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </span>
            ) : null}
            <p className="schedule-row__description">{job.description}</p>

            {job.execution ? (
              <span className="schedule-row__route">{summarizeRoute(job.execution)}</span>
            ) : null}

            {triggerError ? (
              <span className="schedule-row__problem">
                <WarningCircle size={14} weight="fill" aria-hidden="true" />
                {triggerError}
              </span>
            ) : null}
            {attention ? (
              <span className="schedule-row__problem">
                <WarningCircle size={14} weight="fill" aria-hidden="true" />
                Last run {attention.status === "blocked-auth" ? "blocked — backend reconnecting" : "failed"}
                {attention.failureReason ? `: ${attention.failureReason}` : ""}
              </span>
            ) : null}

            {liveEntry ? (
              <span className={`schedule-row__state schedule-row__state--${liveEntry.state}`}>
                {liveEntry.state === "blocked-auth"
                  ? "Blocked — waiting for backend to reconnect"
                  : liveEntry.state === "running"
                    ? "Running"
                    : "Queued"}
                {onCancelRun && liveEntry.state !== "blocked-auth" ? (
                  <button
                    type="button"
                    className="schedule-row__cancel"
                    onClick={() => onCancelRun(liveEntry.runId)}
                  >
                    Cancel
                  </button>
                ) : null}
              </span>
            ) : null}
          </>
        )}
      </div>

      {!editing ? (
        <div className="schedule-row__actions">
          <button
            type="button"
            aria-label={`Edit schedule ${job.name}`}
            onClick={() => setEditing(true)}
          >
            <PencilSimple size={15} />
          </button>
          {onRunNow && job.status === "active" ? (
            <button type="button" onClick={() => onRunNow(job)} aria-label={`Run ${job.name} now`}>
              <Play size={15} />
            </button>
          ) : null}
          {confirmingPause ? (
            <>
              <button
                type="button"
                className="schedule-row__confirm"
                onClick={() => {
                  onToggle(job);
                  setConfirmingPause(false);
                }}
              >
                {job.status === "paused" ? "Confirm resume" : "Confirm pause"}
              </button>
              <button type="button" onClick={() => setConfirmingPause(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className={job.status === "paused" ? "schedule-row__resume" : "schedule-row__pause"}
              onClick={() => {
                // Resuming is always safe; pausing needs a confirmation step.
                if (job.status === "paused") onToggle(job);
                else setConfirmingPause(true);
              }}
            >
              {job.status === "paused" ? "Resume" : "Pause"}
            </button>
          )}
          <button
            type="button"
            className="schedule-row__delete button button--destructive"
            aria-label={`Delete schedule ${job.name}`}
            onClick={() => onDelete(job)}
          >
            <Trash size={15} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** Inline edit form, pre-filled from the job, reusing the create-form controls. */
function ScheduleEditForm({
  job,
  connectors,
  onSave,
  onCancel
}: {
  job: ScheduledJob;
  connectors: ConnectorManifest[];
  onSave: (value: ScheduleFormValue) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduleFormValue>(() => jobToForm(job));
  const validation = useMemo(() => validateForm(form), [form]);
  return (
    <form
      className="schedule-edit"
      aria-label={`Edit schedule ${job.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.valid) onSave(form);
      }}
    >
      <input
        aria-label="Edit schedule task name"
        value={form.name}
        onChange={(event) => setForm({ ...form, name: event.target.value })}
      />
      <textarea
        aria-label="Edit schedule description"
        value={form.prompt}
        onChange={(event) => setForm({ ...form, prompt: event.target.value })}
      />
      <RecurrenceControls form={form} onChange={setForm} />
      <ConnectorControls form={form} onChange={setForm} connectors={connectors} />
      <div className="schedule-edit__actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Map a saved job back into the form value it would produce. */
function jobToForm(job: ScheduledJob): ScheduleFormValue {
  if (job.trigger.kind === "once") {
    const date = new Date(job.trigger.at);
    const pad = (value: number) => value.toString().padStart(2, "0");
    const local = Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
      : "";
    return {
      ...DEFAULT_FORM_VALUE,
      name: job.name,
      prompt: job.description,
      triggerKind: "once",
      onceAt: local,
      missedRunPolicy: job.missedRunPolicy
    };
  }
  const { rule } = job.trigger;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return {
    ...DEFAULT_FORM_VALUE,
    name: job.name,
    prompt: job.description,
    triggerKind: "recurring",
    recurrence: {
      frequency: rule.frequency,
      weekdays: rule.byWeekday ?? [],
      monthDay: rule.byMonthDay ?? 1,
      time: `${pad(rule.hour)}:${pad(rule.minute)}`
    },
    missedRunPolicy: job.missedRunPolicy
  };
}

// ---------------------------------------------------------------------------
// Small shared form primitives
// ---------------------------------------------------------------------------

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label className="schedule-form__label" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <span className="schedule-form__error" role="alert">
      {children}
    </span>
  );
}
