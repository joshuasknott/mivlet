import { FormEvent, useState } from "react";
import { Clock, PencilSimple, Trash } from "@phosphor-icons/react";
import { WEEKDAYS, type Schedule, type Weekday } from "../lib/types";
import { formatScheduleWhen } from "../lib/helpers";
import type { ScheduledJob, SchedulerQueueEntry, WorkflowRun } from "@fable/protocol";

/**
 * Schedules context panel: a create form (name / description / day + time)
 * and the list of saved schedules with pause/resume and delete.
 *
 * No draft/active labels — a schedule either runs (enabled) or is paused.
 * Execution stays linked up to the agent runtime; nothing auto-runs here.
 */

const DEFAULT_DAY: Weekday = "Fri";
const DEFAULT_TIME = "09:00";

export function SchedulePanel({
  schedules,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
  jobs = [],
  runs = [],
  queue = [],
  onRunNow,
  onCancelRun,
  onViewRuns
}: {
  schedules: Schedule[];
  onCreate: (input: { name: string; description: string; day: Weekday; time: string }) => void;
  onEdit: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
  jobs?: ScheduledJob[];
  runs?: WorkflowRun[];
  queue?: SchedulerQueueEntry[];
  onRunNow?: (job: ScheduledJob) => void;
  onCancelRun?: (runId: string) => void;
  /** Open Run History pre-filtered to this schedule's executions. */
  onViewRuns?: (job: ScheduledJob) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [day, setDay] = useState<Weekday>(DEFAULT_DAY);
  const [time, setTime] = useState(DEFAULT_TIME);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setDay(DEFAULT_DAY);
    setTime(DEFAULT_TIME);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !description.trim()) {
      return;
    }
    onCreate({
      name: name.trim(),
      description: description.trim(),
      day,
      time
    });
    resetForm();
  };

  return (
    <section className="context-panel schedule-panel" aria-label="Schedules">
      <form className="schedule-form" onSubmit={submit} aria-label="Create a schedule">
        <div className="schedule-form__row">
          <label className="schedule-form__field">
            <span className="schedule-form__label">Task name</span>
            <input
              className="schedule-form__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Weekly digest"
              aria-label="Schedule task name"
            />
          </label>
        </div>
        <div className="schedule-form__row">
          <label className="schedule-form__field">
            <span className="schedule-form__label">What should the agent do?</span>
            <textarea
              className="schedule-form__textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Summarize active projects, new memory, and approvals into a digest."
              aria-label="Schedule description"
              rows={3}
            />
          </label>
        </div>
        <div className="schedule-form__row schedule-form__row--inline">
          <label className="schedule-form__field">
            <span className="schedule-form__label">Day</span>
            <select
              className="schedule-form__select"
              value={day}
              onChange={(event) => setDay(event.target.value as Weekday)}
              aria-label="Schedule day"
            >
              {WEEKDAYS.map((weekday) => (
                <option key={weekday} value={weekday}>
                  {weekday}
                </option>
              ))}
            </select>
          </label>
          <label className="schedule-form__field">
            <span className="schedule-form__label">Time</span>
            <input
              className="schedule-form__input schedule-form__input--time"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              aria-label="Schedule time"
            />
          </label>
          <button type="submit" className="schedule-form__submit button button--primary" disabled={!name.trim() || !description.trim()}>
            Create schedule
          </button>
        </div>
      </form>

      {schedules.length === 0 ? (
        <p className="schedule-empty">No schedules yet. Create one above.</p>
      ) : (
        <ul className="schedule-list">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="schedule-row">
              {(() => {
                const job = jobs.find((candidate) => candidate.id === schedule.id);
                const lastRun = runs.find((candidate) => candidate.id === job?.lastRunId);
                // The most recent queue entry for this schedule (by scheduledAt
                // descending) so the UI surfaces the live run state.
                const scheduleEntries = queue
                  .filter((entry) => entry.jobId === schedule.id)
                  .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
                const activeEntry = scheduleEntries.find((entry) =>
                  ["queued", "leased", "running", "blocked-auth"].includes(entry.state)
                );
                return (
                  <>
              <span className="schedule-row__icon" aria-hidden="true">
                <Clock size={18} />
              </span>
              <div className="schedule-row__body">
                {editing?.id === schedule.id ? (
                  <form
                    className="schedule-edit"
                    aria-label={`Edit schedule ${schedule.name}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!editing.name.trim() || !editing.description.trim()) return;
                      onEdit({
                        ...editing,
                        name: editing.name.trim(),
                        description: editing.description.trim()
                      });
                      setEditing(null);
                    }}
                  >
                    <input
                      aria-label="Edit schedule task name"
                      value={editing.name}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { ...current, name: event.target.value } : current
                        )
                      }
                    />
                    <textarea
                      aria-label="Edit schedule description"
                      value={editing.description}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { ...current, description: event.target.value } : current
                        )
                      }
                    />
                    <select
                      aria-label="Edit schedule day"
                      value={editing.day}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { ...current, day: event.target.value as Weekday } : current
                        )
                      }
                    >
                      {WEEKDAYS.map((weekday) => (
                        <option key={weekday} value={weekday}>{weekday}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Edit schedule time"
                      type="time"
                      value={editing.time}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { ...current, time: event.target.value } : current
                        )
                      }
                    />
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <strong>{schedule.name}</strong>
                    <span className="schedule-row__when">{formatScheduleWhen(schedule)}</span>
                  </>
                )}
                {job?.nextRunAt ? (
                  <span className="schedule-row__when">
                    Upcoming {new Date(job.nextRunAt).toLocaleString()}
                  </span>
                ) : null}
                <p className="schedule-row__description">{schedule.description}</p>
                {lastRun ? (
                  <details>
                    <summary>Last result · {lastRun.status}</summary>
                    <p>{lastRun.failureReason ?? "Workflow completed."}</p>
                  </details>
                ) : null}
                {activeEntry ? (
                  <span className={`schedule-row__state schedule-row__state--${activeEntry.state}`}>
                    {activeEntry.state === "blocked-auth"
                      ? "Blocked — waiting for backend to reconnect"
                      : activeEntry.state === "running"
                        ? "Running"
                        : "Queued"}
                    {onCancelRun && activeEntry.state !== "blocked-auth" ? (
                      <button
                        type="button"
                        className="schedule-row__cancel"
                        onClick={() => onCancelRun(activeEntry.runId)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div className="schedule-row__actions">
                <button
                  type="button"
                  aria-label={`Edit schedule ${schedule.name}`}
                  onClick={() => setEditing({ ...schedule })}
                >
                  <PencilSimple size={15} />
                </button>
                {job && onRunNow ? (
                  <button type="button" onClick={() => onRunNow(job)}>Run now</button>
                ) : null}
                {job && onViewRuns ? (
                  <button type="button" onClick={() => onViewRuns(job)}>View runs</button>
                ) : null}
                <button
                  type="button"
                  className={schedule.enabled ? "schedule-row__pause" : "schedule-row__resume"}
                  onClick={() => onToggle(schedule)}
                >
                  {schedule.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  className="schedule-row__delete button button--destructive"
                  aria-label={`Delete schedule ${schedule.name}`}
                  onClick={() => onDelete(schedule)}
                >
                  <Trash size={15} />
                </button>
              </div>
                  </>
                );
              })()}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
