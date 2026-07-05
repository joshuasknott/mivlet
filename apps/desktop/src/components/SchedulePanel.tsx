import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus } from "@phosphor-icons/react/dist/csr/CalendarPlus";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type {
  ConnectorManifest,
  MissedRunPolicy,
  ScheduledJob,
  SchedulerQueueEntry,
  ScheduleWeekday,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import { validateScheduleTrigger } from "@fable/connectors";
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
const CREATE_FORM_VALUE: ScheduleFormValue = {
  ...DEFAULT_FORM_VALUE,
  recurrence: {
    ...DEFAULT_FORM_VALUE.recurrence,
    frequency: "daily"
  }
};

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
  definitions = [],
  loading = false,
  loadError = null,
  isCreateModalOpen = false,
  onRequestCloseCreateModal,
  onRetryLoad,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onCancelRun,
  onViewRuns
}: {
  jobs?: ScheduledJob[];
  runs?: WorkflowRun[];
  queue?: SchedulerQueueEntry[];
  /** Connected connector manifests the form may compose into the workflow. */
  connectors?: ConnectorManifest[];
  definitions?: WorkflowDefinition[];
  /** True while persisted jobs are being hydrated from the Rust store. */
  loading?: boolean;
  loadError?: string | null;
  isCreateModalOpen?: boolean;
  onRequestCloseCreateModal?: () => void;
  onRetryLoad?: () => void;
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
  /** Open Run History pre-filtered to this schedule's executions. */
  onViewRuns?: (job: ScheduledJob) => void;
}) {
  const [form, setForm] = useState<ScheduleFormValue>(CREATE_FORM_VALUE);
  const [submitted, setSubmitted] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const validation = useMemo(() => validateForm(form), [form]);
  const draftTrigger = useMemo(() => buildTrigger(form, TIMEZONE), [form]);

  const resetForm = () => {
    setForm(CREATE_FORM_VALUE);
    setSubmitted(false);
  };

  useEffect(() => {
    if (isCreateModalOpen) {
      resetForm();
      window.setTimeout(() => nameInputRef.current?.focus(), 0);
    }
  }, [isCreateModalOpen]);

  useEffect(() => {
    if (!isCreateModalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onRequestCloseCreateModal) {
        onRequestCloseCreateModal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCreateModalOpen, onRequestCloseCreateModal]);

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget && onRequestCloseCreateModal) {
      onRequestCloseCreateModal();
    }
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
    if (onRequestCloseCreateModal) {
      onRequestCloseCreateModal();
    }
  };

  const filteredJobs = useMemo(() => {
    if (!searchTerm.trim()) return jobs;
    const term = searchTerm.toLowerCase();
    return jobs.filter(
      (job) =>
        job.name.toLowerCase().includes(term) ||
        job.description.toLowerCase().includes(term)
    );
  }, [jobs, searchTerm]);

  return (
    <section className="schedule-panel" aria-label="Schedules">
      <div className="schedule-search">
        <MagnifyingGlass size={16} className="schedule-search__icon" aria-hidden="true" />
        <input
          type="text"
          placeholder="Search tasks..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          className="schedule-search__input"
          aria-label="Search tasks"
        />
        {searchTerm ? (
          <button
            type="button"
            className="schedule-search__clear"
            onClick={() => setSearchTerm("")}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {isCreateModalOpen && (
        <div
          className="schedule-modal-overlay"
          onClick={handleBackdropClick}
          data-testid="schedule-modal-overlay"
        >
          <div
            className="schedule-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-schedule-title"
          >
            <div className="schedule-modal__header">
              <h2 id="new-schedule-title" className="schedule-modal__title">
                New Scheduled Task
              </h2>
              <button
                type="button"
                className="schedule-modal__close"
                aria-label="Close dialog"
                onClick={onRequestCloseCreateModal}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={submit} className="schedule-modal__form">
              <div className="schedule-modal__row">
                <label htmlFor="schedule-name" className="schedule-modal__label">Name</label>
                <input
                  ref={nameInputRef}
                  id="schedule-name"
                  className="schedule-modal__input"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Enter scheduled task name..."
                  aria-label="Schedule task name"
                  aria-invalid={submitted && validation.errors.name ? "true" : undefined}
                />
                {submitted && validation.errors.name ? (
                  <span className="schedule-modal__error" role="alert">{validation.errors.name}</span>
                ) : null}
              </div>

              <div className="schedule-modal__row">
                <div className="schedule-modal__label" id="schedule-modal-schedule-label">Schedule</div>
                <CompactScheduleControls
                  form={form}
                  onChange={setForm}
                  labelledBy="schedule-modal-schedule-label"
                />
                {submitted && validation.errors.trigger ? (
                  <span className="schedule-modal__error" role="alert">{validation.errors.trigger}</span>
                ) : null}
              </div>

              <div className="schedule-modal__row">
                <label htmlFor="schedule-prompt" className="schedule-modal__label">Prompt</label>
                <textarea
                  id="schedule-prompt"
                  className="schedule-modal__textarea"
                  value={form.prompt}
                  onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                  placeholder="Enter a prompt for the agent to run..."
                  aria-label="Schedule description"
                  rows={4}
                />
                {submitted && validation.errors.prompt ? (
                  <span className="schedule-modal__error" role="alert">{validation.errors.prompt}</span>
                ) : null}
              </div>

              <div className="schedule-modal__actions">
                <button
                  type="submit"
                  className="button button--primary schedule-modal__submit"
                  disabled={!validation.valid}
                >
                  Add Scheduled Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loadError ? (
        <div className="page-loading page-loading--error" role="alert">
          <WarningCircle size={16} aria-hidden="true" />
          <span>Could not load schedules.</span>
          {onRetryLoad ? (
            <button type="button" onClick={onRetryLoad}>
              Retry
            </button>
          ) : null}
        </div>
      ) : loading ? (
        <div className="page-loading" role="status" aria-live="polite">
          <Spinner size={16} aria-hidden="true" />
          <span>Loading schedules…</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="schedule-empty" data-testid="schedule-empty">
          <CalendarPlus size={28} weight="duotone" aria-hidden="true" />
          <p>No schedules yet. Create one with New.</p>
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="schedule-empty schedule-empty--search" data-testid="schedule-no-results">
          <MagnifyingGlass size={28} weight="duotone" aria-hidden="true" />
          <p>No tasks match your search.</p>
        </div>
      ) : (
        <ul className="schedule-list" aria-label="Saved schedules">
          {filteredJobs.map((job) => (
            <ScheduleRow
              key={job.id}
              job={job}
              runs={runs}
              queue={queue}
              connectors={connectors}
              definitions={definitions}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
              onRunNow={onRunNow}
              onCancelRun={onCancelRun}
              onViewRuns={onViewRuns}
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
  recurrenceSummary,
  nextRunPreview,
  connectors,
  onSubmit,
  onCancel
}: {
  form: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
  submitted: boolean;
  validation: ReturnType<typeof validateForm>;
  recurrenceSummary: string | null;
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

      {recurrenceSummary || nextRunPreview ? (
        <p className="schedule-form__summary" aria-live="polite">
          {recurrenceSummary ? (
            <span className="schedule-form__summary-pattern">{recurrenceSummary}</span>
          ) : null}
          {nextRunPreview ? (
            <span className="schedule-form__summary-next"> · Next {nextRunPreview}</span>
          ) : null}
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

function CompactScheduleControls({
  form,
  onChange,
  labelledBy
}: {
  form: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
  labelledBy: string;
}) {
  const { recurrence } = form;
  const scheduleKind = form.triggerKind === "once" ? "once" : recurrence.frequency;

  const setRecurrence = (patch: Partial<ScheduleFormRecurrence>) =>
    onChange({ ...form, recurrence: { ...recurrence, ...patch } });

  const setScheduleKind = (value: "daily" | "weekly" | "monthly" | "once") => {
    if (value === "once") {
      onChange({ ...form, triggerKind: "once" });
      return;
    }
    onChange({
      ...form,
      triggerKind: "recurring",
      recurrence: {
        ...recurrence,
        frequency: value,
        weekdays:
          value === "weekly" && recurrence.weekdays.length === 0
            ? ["Mon"]
            : recurrence.weekdays
      }
    });
  };

  return (
    <fieldset className="schedule-compact" aria-labelledby={labelledBy}>
      <div className="schedule-compact__primary">
        <select
          className="schedule-compact__select"
          value={scheduleKind}
          onChange={(event) =>
            setScheduleKind(event.target.value as "daily" | "weekly" | "monthly" | "once")
          }
          aria-label="Schedule frequency"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="once">Once</option>
        </select>

        {scheduleKind === "once" ? (
          <>
            <span className="schedule-compact__joiner">on</span>
            <input
              className="schedule-compact__datetime"
              type="datetime-local"
              value={form.onceAt}
              onChange={(event) => onChange({ ...form, onceAt: event.target.value })}
              aria-label="Run at"
            />
          </>
        ) : (
          <>
            {scheduleKind === "monthly" ? (
              <>
                <span className="schedule-compact__joiner">on day</span>
                <input
                  className="schedule-compact__day"
                  type="number"
                  min={1}
                  max={31}
                  value={recurrence.monthDay}
                  onChange={(event) => setRecurrence({ monthDay: Number(event.target.value) })}
                  aria-label="Day of month"
                />
              </>
            ) : null}
            <span className="schedule-compact__joiner">at</span>
            <input
              className="schedule-compact__time"
              type="time"
              value={recurrence.time}
              onChange={(event) => setRecurrence({ time: event.target.value })}
              aria-label="Time"
            />
          </>
        )}
      </div>

      {scheduleKind === "weekly" ? (
        <div className="schedule-compact__weekdays" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((weekday) => {
            const active = recurrence.weekdays.includes(weekday);
            return (
              <button
                key={weekday}
                type="button"
                className={active ? "is-active" : undefined}
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
    </fieldset>
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
    (connector) => connector.status === "connected" && connector.supportsSearch === true
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
  definitions = [],
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  onCancelRun,
  onViewRuns
}: {
  job: ScheduledJob;
  runs: WorkflowRun[];
  queue: SchedulerQueueEntry[];
  connectors: ConnectorManifest[];
  definitions?: WorkflowDefinition[];
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
  onViewRuns?: (job: ScheduledJob) => void;
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
            definitions={definitions}
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
            <div className="schedule-row__timing">
              <span className="schedule-row__when">{summarizeRecurrence(job.trigger)}</span>
              {job.nextRunAt && job.status === "active" ? (
                <span className="schedule-row__next">
                  · Next {new Date(job.nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
            </div>
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
          {onViewRuns ? (
            <button type="button" onClick={() => onViewRuns(job)}>
              View runs
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
  definitions = [],
  onSave,
  onCancel
}: {
  job: ScheduledJob;
  connectors: ConnectorManifest[];
  definitions?: WorkflowDefinition[];
  onSave: (value: ScheduleFormValue) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduleFormValue>(() => jobToForm(job, definitions));
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
function jobToForm(job: ScheduledJob, definitions: WorkflowDefinition[]): ScheduleFormValue {
  const definition = definitions.find((d) => d.id === job.workflowDefinitionId);
  const connectorIds = definition
    ? definition.steps.flatMap((step) =>
        step.kind === "connector-read" ? [step.connectorId] : []
      )
    : [];

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
      missedRunPolicy: job.missedRunPolicy,
      connectorIds
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
    missedRunPolicy: job.missedRunPolicy,
    connectorIds
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
