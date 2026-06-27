import { FormEvent, useState } from "react";
import { Clock, Trash } from "@phosphor-icons/react";
import { WEEKDAYS, type Schedule, type Weekday } from "../lib/types";
import { formatScheduleWhen } from "../lib/helpers";

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
  onToggle,
  onDelete
}: {
  schedules: Schedule[];
  onCreate: (input: { name: string; description: string; day: Weekday; time: string }) => void;
  onToggle: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [day, setDay] = useState<Weekday>(DEFAULT_DAY);
  const [time, setTime] = useState(DEFAULT_TIME);

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
              <span className="schedule-row__icon" aria-hidden="true">
                <Clock size={18} />
              </span>
              <div className="schedule-row__body">
                <strong>{schedule.name}</strong>
                <span className="schedule-row__when">{formatScheduleWhen(schedule)}</span>
                <p className="schedule-row__description">{schedule.description}</p>
              </div>
              <div className="schedule-row__actions">
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
