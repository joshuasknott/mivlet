import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ScheduleWeekday } from "@fable/protocol";
import {
  beginRuntimeRoutineSchedulerShadow,
  createRuntimeRoutine,
  cutoverRuntimeRoutineScheduler,
  deleteRuntimeRoutine,
  editRuntimeRoutine,
  getRuntimeRoutineSchedulerStatus,
  listRuntimeRoutineHistory,
  listRuntimeRoutines,
  migrateLegacyRoutines,
  pauseRuntimeRoutine,
  rollbackRuntimeRoutineScheduler,
  resumeRuntimeRoutine,
  type RuntimeRoutineBundle,
  type RuntimeRoutineOccurrence,
  type RuntimeRoutineSchedulerStatus,
  type RuntimeRoutineTriggerSpec
} from "../runtime";

function describeTrigger(trigger: RuntimeRoutineBundle["triggers"][number] | undefined) {
  if (!trigger) return "No active time";
  const spec = trigger.spec;
  if (spec.kind === "time-once") {
    return `Once · ${new Date(spec.at).toLocaleString()}`;
  }
  if (spec.kind === "time-recurring") {
    return `${spec.recurrence.frequency[0]?.toUpperCase()}${spec.recurrence.frequency.slice(1)} · ${spec.timezone}`;
  }
  return spec.kind.replaceAll("-", " ");
}

const ROUTINE_WEEKDAYS: ScheduleWeekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
type RoutineCadence = "once" | "daily" | "weekly" | "monthly";

interface RoutineTimeDraft {
  cadence: RoutineCadence;
  time: string;
  onceAt: string;
  weekday: ScheduleWeekday;
  monthDay: number;
}

function localDateTimeValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function routineTimeDraft(
  trigger: RuntimeRoutineBundle["triggers"][number] | undefined
): RoutineTimeDraft | null {
  if (!trigger) return null;
  if (trigger.spec.kind === "time-once") {
    return {
      cadence: "once",
      time: "09:00",
      onceAt: localDateTimeValue(trigger.spec.at),
      weekday: "Mon",
      monthDay: 1
    };
  }
  if (trigger.spec.kind !== "time-recurring") return null;
  const prefix = "legacy-rrule-lite:v1:";
  if (!trigger.spec.recurrence.expression.startsWith(prefix)) return null;
  try {
    const rule = JSON.parse(trigger.spec.recurrence.expression.slice(prefix.length)) as {
      frequency?: unknown;
      interval?: unknown;
      byWeekday?: unknown;
      byMonthDay?: unknown;
      hour?: unknown;
      minute?: unknown;
    };
    if (
      !["daily", "weekly", "monthly"].includes(String(rule.frequency)) ||
      rule.interval !== 1 ||
      !Number.isInteger(rule.hour) ||
      !Number.isInteger(rule.minute)
    ) {
      return null;
    }
    const ruleWeekdays = Array.isArray(rule.byWeekday) ? rule.byWeekday : [];
    const weekday = ROUTINE_WEEKDAYS.find((day) => ruleWeekdays.includes(day)) ?? "Mon";
    const monthDay =
      Number.isInteger(rule.byMonthDay) &&
      Number(rule.byMonthDay) >= 1 &&
      Number(rule.byMonthDay) <= 31
        ? Number(rule.byMonthDay)
        : 1;
    return {
      cadence: rule.frequency as Exclude<RoutineCadence, "once">,
      time: `${String(Number(rule.hour)).padStart(2, "0")}:${String(Number(rule.minute)).padStart(2, "0")}`,
      onceAt: "",
      weekday,
      monthDay
    };
  } catch {
    return null;
  }
}

function routineDraftKey(draft: RoutineTimeDraft) {
  return JSON.stringify(draft);
}

function routineTimeTrigger(draft: RoutineTimeDraft): RuntimeRoutineTriggerSpec {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (draft.cadence === "once") {
    const at = new Date(draft.onceAt);
    if (Number.isNaN(at.valueOf())) throw new Error("Choose a valid date and time.");
    return { kind: "time-once", at: at.toISOString(), timezone };
  }
  const [hour, minute] = draft.time.split(":").map(Number);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Choose a valid time.");
  }
  if (draft.cadence === "monthly" && (draft.monthDay < 1 || draft.monthDay > 31)) {
    throw new Error("Choose a day from 1 to 31.");
  }
  return {
    kind: "time-recurring",
    timezone,
    recurrence: {
      frequency: draft.cadence,
      expression: `legacy-rrule-lite:v1:${JSON.stringify({
        frequency: draft.cadence,
        interval: 1,
        byWeekday: draft.cadence === "weekly" ? [draft.weekday] : [],
        byMonthDay: draft.cadence === "monthly" ? draft.monthDay : null,
        hour,
        minute
      })}`
    },
    missedRunPolicy: "run-once"
  };
}

export function RoutinePanel({
  onRun,
  draft,
  onDraftConsumed
}: {
  onRun: (instruction: string) => void;
  draft?: { title: string; instruction: string } | null;
  onDraftConsumed?: () => void;
}) {
  const [routines, setRoutines] = useState<RuntimeRoutineBundle[]>([]);
  const [nativeAvailable, setNativeAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RuntimeRoutineBundle | null>(null);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [cadence, setCadence] = useState<RoutineCadence>("daily");
  const [time, setTime] = useState("09:00");
  const [onceAt, setOnceAt] = useState("");
  const [weekday, setWeekday] = useState<ScheduleWeekday>("Mon");
  const [monthDay, setMonthDay] = useState(1);
  const [originalTimeDraft, setOriginalTimeDraft] = useState<string | null>(null);
  const [triggerEditable, setTriggerEditable] = useState(true);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<RuntimeRoutineOccurrence[]>([]);
  const [schedulerStatus, setSchedulerStatus] =
    useState<RuntimeRoutineSchedulerStatus | null>(null);

  const active = useMemo(
    () => routines.filter((bundle) => bundle.routine.status !== "deleted"),
    [routines]
  );

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, status] = await Promise.all([
        listRuntimeRoutines(),
        getRuntimeRoutineSchedulerStatus()
      ]);
      setNativeAvailable(result !== null);
      setRoutines(result ?? []);
      setSchedulerStatus(status);
    } catch (reason) {
      setNativeAvailable(true);
      setError(reason instanceof Error ? reason.message : "Routines could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const handleChange = () => void refresh();
    window.addEventListener("fable:routines-changed", handleChange);
    return () => window.removeEventListener("fable:routines-changed", handleChange);
  }, []);

  useEffect(() => {
    if (!draft) return;
    setEditing(null);
    setCreating(true);
    setTitle(draft.title);
    setInstruction(draft.instruction);
    setCadence("daily");
    setTime("09:00");
    setOnceAt("");
    setWeekday("Mon");
    setMonthDay(1);
    setOriginalTimeDraft(null);
    setTriggerEditable(true);
    setNotice("Choose when this should run, then save it.");
    onDraftConsumed?.();
  }, [draft, onDraftConsumed]);

  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setTitle("");
    setInstruction("");
    setCadence("daily");
    setTime("09:00");
    setOnceAt("");
    setWeekday("Mon");
    setMonthDay(1);
    setOriginalTimeDraft(null);
    setTriggerEditable(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const draft = { cadence, time, onceAt, weekday, monthDay };
      if (editing) {
        const trigger =
          triggerEditable && originalTimeDraft !== routineDraftKey(draft)
            ? routineTimeTrigger(draft)
            : undefined;
        const updated = await editRuntimeRoutine({
          routineId: editing.routine.id,
          expectedRevision: editing.routine.revision,
          title,
          instruction,
          ...(trigger ? { trigger } : {})
        });
        if (updated) {
          setRoutines((items) =>
            items.map((item) => (item.routine.id === updated.routine.id ? updated : item))
          );
        }
        setNotice("Routine updated.");
      } else {
        const trigger = routineTimeTrigger(draft);
        const created = await createRuntimeRoutine({ title, instruction, trigger });
        if (created) setRoutines((items) => [created, ...items]);
        setNotice("Routine saved locally.");
      }
      closeEditor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Routine could not be saved.");
    }
  };

  const changeStatus = async (
    bundle: RuntimeRoutineBundle,
    action: "pause" | "resume" | "delete"
  ) => {
    if (action === "delete" && !window.confirm(`Delete “${bundle.routine.title}”?`)) return;
    setError(null);
    try {
      const input = {
        routineId: bundle.routine.id,
        expectedRevision: bundle.routine.revision,
        reason: action === "pause" ? "Paused from Routines." : undefined
      };
      const updated =
        action === "pause"
          ? await pauseRuntimeRoutine(input)
          : action === "resume"
            ? await resumeRuntimeRoutine(input)
            : await deleteRuntimeRoutine(input);
      if (updated) {
        setRoutines((items) =>
          items.map((item) => (item.routine.id === updated.routine.id ? updated : item))
        );
      }
      setNotice(action === "delete" ? "Routine deleted." : `Routine ${action}d.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Routine could not be changed.");
    }
  };

  const showHistory = async (bundle: RuntimeRoutineBundle) => {
    setHistoryFor(bundle.routine.id);
    setError(null);
    try {
      setHistory((await listRuntimeRoutineHistory(bundle.routine.id)) ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Routine history could not be loaded.");
    }
  };

  const migrate = async () => {
    setError(null);
    setNotice(null);
    try {
      const result = await migrateLegacyRoutines();
      if (!result) return;
      setNotice(
        `Imported ${result.summary.candidateCount} routine${result.summary.candidateCount === 1 ? "" : "s"}.` +
          (result.summary.quarantineCount > 0
            ? ` ${result.summary.quarantineCount} ambiguous record${result.summary.quarantineCount === 1 ? " needs" : "s need"} review.`
            : "")
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Existing schedules could not be imported.");
    }
  };

  const changeScheduler = async (action: "shadow" | "cutover" | "rollback") => {
    if (
      action === "cutover" &&
      !window.confirm(
        "Use Routines for background work in this workspace? Existing schedules will become read-only but stay available for recovery."
      )
    ) {
      return;
    }
    if (
      action === "rollback" &&
      !window.confirm(
        "Restore the existing schedule runner? Fable will first preserve settled Routine history and will stop if anything is still running or no longer matches its migrated schedule."
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const status =
        action === "shadow"
          ? await beginRuntimeRoutineSchedulerShadow()
          : action === "cutover"
            ? await cutoverRuntimeRoutineScheduler()
            : await rollbackRuntimeRoutineScheduler();
      setSchedulerStatus(status);
      setNotice(
        action === "shadow"
          ? "Fable checked the local migration while existing schedules kept running."
          : action === "cutover"
            ? "Routines now own background work in this workspace."
            : "The existing schedule runner was restored."
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The background runner could not be changed."
      );
    }
  };

  if (nativeAvailable === false) {
    return (
      <section className="routine-panel" aria-labelledby="routines-title">
        <div className="routine-panel__heading">
          <div>
            <h2 id="routines-title">Routines</h2>
            <p>Reusable work that can run on a schedule.</p>
          </div>
        </div>
        <div className="routine-preview-note" role="note">
          Routines are unavailable in this browser preview. Open the Fable desktop app to save and
          run encrypted local routines.
        </div>
      </section>
    );
  }

  return (
    <section className="routine-panel" aria-labelledby="routines-title">
      <div className="routine-panel__heading">
        <div>
          <h2 id="routines-title">Routines</h2>
          <p>Reusable work, saved privately on this device.</p>
        </div>
        <div className="routine-panel__actions">
          <button type="button" className="secondary-button" onClick={() => void migrate()}>
            Import schedules
          </button>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            New routine
          </button>
        </div>
      </div>

      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="routine-notice" role="status">
          {notice}
        </div>
      ) : null}

      {creating || editing ? (
        <form className="routine-editor" onSubmit={(event) => void submit(event)}>
          <h3>{editing ? "Edit routine" : "New routine"}</h3>
          <label>
            Name
            <input
              required
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </label>
          <label>
            What should Fable do?
            <textarea
              required
              maxLength={8000}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          {!editing || triggerEditable ? (
            <div className="routine-editor__time">
              <label>
                When
                <select
                  value={cadence}
                  onChange={(event) => setCadence(event.target.value as RoutineCadence)}
                  aria-label="Routine frequency"
                >
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                  <option value="once">Once</option>
                </select>
              </label>
              {cadence === "weekly" ? (
                <label>
                  Day
                  <select
                    value={weekday}
                    onChange={(event) => setWeekday(event.target.value as ScheduleWeekday)}
                    aria-label="Routine weekday"
                  >
                    {ROUTINE_WEEKDAYS.map((day) => (
                      <option key={day} value={day}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {cadence === "monthly" ? (
                <label>
                  Day of month
                  <input
                    required
                    type="number"
                    min={1}
                    max={31}
                    value={monthDay}
                    onChange={(event) => setMonthDay(Number(event.target.value))}
                    aria-label="Routine day of month"
                  />
                </label>
              ) : null}
              <label>
                {cadence === "once" ? "Date and time" : "Time"}
                <input
                  required
                  type={cadence === "once" ? "datetime-local" : "time"}
                  value={cadence === "once" ? onceAt : time}
                  onChange={(event) =>
                    cadence === "once" ? setOnceAt(event.target.value) : setTime(event.target.value)
                  }
                  aria-label={cadence === "once" ? "Routine date and time" : "Routine time"}
                />
              </label>
            </div>
          ) : (
            <p className="routine-preview-note" role="note">
              This trigger type is preserved as-is and cannot be edited here yet.
            </p>
          )}
          <div className="routine-editor__actions">
            <button type="button" className="secondary-button" onClick={closeEditor}>
              Cancel
            </button>
            <button type="submit" className="primary-button">
              Save
            </button>
          </div>
        </form>
      ) : null}

      {loading ? <p className="routine-empty">Loading routines…</p> : null}
      {!loading && active.length === 0 ? (
        <div className="routine-empty">
          <strong>No routines yet</strong>
          <span>Create one here, or import compatible existing schedules.</span>
        </div>
      ) : null}
      <ul className="routine-list">
        {active.map((bundle) => (
          <li key={bundle.routine.id} className="routine-card">
            <div className="routine-card__main">
              <div>
                <h3>{bundle.routine.title}</h3>
                <p>{bundle.currentVersion.action.instruction}</p>
              </div>
              <span className={`routine-status routine-status--${bundle.routine.status}`}>
                {bundle.routine.status}
              </span>
            </div>
            <div className="routine-card__meta">
              <span>{describeTrigger(bundle.triggers.find((trigger) => trigger.status === "active"))}</span>
              <span>Saved locally</span>
            </div>
            <div className="routine-card__actions">
              <button
                type="button"
                onClick={() => onRun(bundle.currentVersion.action.instruction)}
                disabled={bundle.routine.status !== "active"}
              >
                Run this again
              </button>
              <button
                type="button"
                onClick={() => {
                  const draft = routineTimeDraft(
                    bundle.triggers.find((trigger) => trigger.status === "active")
                  );
                  setEditing(bundle);
                  setTitle(bundle.routine.title);
                  setInstruction(bundle.currentVersion.action.instruction);
                  setTriggerEditable(draft !== null);
                  if (draft) {
                    setCadence(draft.cadence);
                    setTime(draft.time);
                    setOnceAt(draft.onceAt);
                    setWeekday(draft.weekday);
                    setMonthDay(draft.monthDay);
                    setOriginalTimeDraft(routineDraftKey(draft));
                  } else {
                    setOriginalTimeDraft(null);
                  }
                }}
              >
                Edit
              </button>
              <button type="button" onClick={() => void showHistory(bundle)}>
                History
              </button>
              <button
                type="button"
                onClick={() =>
                  void changeStatus(
                    bundle,
                    bundle.routine.status === "paused" ? "resume" : "pause"
                  )
                }
              >
                {bundle.routine.status === "paused" ? "Resume" : "Pause"}
              </button>
              <button type="button" onClick={() => void changeStatus(bundle, "delete")}>
                Delete
              </button>
            </div>
            {historyFor === bundle.routine.id ? (
              <div className="routine-history">
                <div className="routine-history__heading">
                  <strong>History</strong>
                  <button type="button" onClick={() => setHistoryFor(null)}>
                    Close
                  </button>
                </div>
                {history.length === 0 ? (
                  <p>No recorded runs yet.</p>
                ) : (
                  <ul>
                    {history.map((occurrence) => (
                      <li key={occurrence.id}>
                        <span>{occurrence.status}</span>
                        <time dateTime={occurrence.observedAt}>
                          {new Date(occurrence.observedAt).toLocaleString()}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {schedulerStatus ? (
        <section className="routine-runner" aria-labelledby="routine-runner-title">
          <div>
            <h3 id="routine-runner-title">Background runner</h3>
            <p>
              {schedulerStatus.authority.writer === "routine"
                ? "Routines are running background work."
                : schedulerStatus.authority.phase === "shadow"
                  ? schedulerStatus.readyForCutover
                    ? "The local migration matches and is ready."
                    : "Existing schedules are still running while Fable checks the migration."
                  : "Existing schedules are still running."}
            </p>
          </div>
          {schedulerStatus.blockers.length > 0 ? (
            <ul className="routine-runner__blockers">
              {schedulerStatus.blockers.slice(0, 4).map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          <div className="routine-runner__actions">
            {schedulerStatus.authority.writer === "legacy" &&
            schedulerStatus.authority.phase === "legacy" ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void changeScheduler("shadow")}
              >
                Check migration
              </button>
            ) : null}
            {schedulerStatus.authority.phase === "shadow" ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void refresh()}
                >
                  Check again
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!schedulerStatus.readyForCutover}
                  onClick={() => void changeScheduler("cutover")}
                >
                  Use Routines
                </button>
              </>
            ) : null}
            {schedulerStatus.authority.writer === "routine" ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void changeScheduler("rollback")}
              >
                Restore existing schedules
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <p className="routine-cutover-note">
        Existing schedules stay available for recovery. Fable never runs both local schedulers as
        writers.
      </p>
    </section>
  );
}
