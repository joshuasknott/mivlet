import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createRuntimeRoutine,
  deleteRuntimeRoutine,
  editRuntimeRoutine,
  listRuntimeRoutineHistory,
  listRuntimeRoutines,
  migrateLegacyRoutines,
  pauseRuntimeRoutine,
  resumeRuntimeRoutine,
  type RuntimeRoutineBundle,
  type RuntimeRoutineOccurrence,
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

function timeTrigger(cadence: "once" | "daily", localTime: string): RuntimeRoutineTriggerSpec {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (cadence === "once") {
    const at = new Date(localTime);
    if (Number.isNaN(at.valueOf())) throw new Error("Choose a valid date and time.");
    return { kind: "time-once", at: at.toISOString(), timezone };
  }
  const [hour, minute] = localTime.split(":").map(Number);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Choose a valid daily time.");
  }
  return {
    kind: "time-recurring",
    timezone,
    recurrence: {
      frequency: "daily",
      expression: `legacy-rrule-lite:v1:${JSON.stringify({
        frequency: "daily",
        interval: 1,
        byWeekday: [],
        byMonthDay: null,
        hour,
        minute
      })}`
    },
    missedRunPolicy: "run-once"
  };
}

export function RoutinePanel({ onRun }: { onRun: (instruction: string) => void }) {
  const [routines, setRoutines] = useState<RuntimeRoutineBundle[]>([]);
  const [nativeAvailable, setNativeAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RuntimeRoutineBundle | null>(null);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [cadence, setCadence] = useState<"once" | "daily">("daily");
  const [time, setTime] = useState("09:00");
  const [onceAt, setOnceAt] = useState("");
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<RuntimeRoutineOccurrence[]>([]);

  const active = useMemo(
    () => routines.filter((bundle) => bundle.routine.status !== "deleted"),
    [routines]
  );

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRuntimeRoutines();
      setNativeAvailable(result !== null);
      setRoutines(result ?? []);
    } catch (reason) {
      setNativeAvailable(true);
      setError(reason instanceof Error ? reason.message : "Routines could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setTitle("");
    setInstruction("");
    setCadence("daily");
    setTime("09:00");
    setOnceAt("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      if (editing) {
        const updated = await editRuntimeRoutine({
          routineId: editing.routine.id,
          expectedRevision: editing.routine.revision,
          title,
          instruction
        });
        if (updated) {
          setRoutines((items) =>
            items.map((item) => (item.routine.id === updated.routine.id ? updated : item))
          );
        }
        setNotice("Routine updated.");
      } else {
        const trigger = timeTrigger(cadence, cadence === "once" ? onceAt : time);
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
          {!editing ? (
            <div className="routine-editor__time">
              <label>
                When
                <select
                  value={cadence}
                  onChange={(event) => setCadence(event.target.value as "once" | "daily")}
                >
                  <option value="daily">Every day</option>
                  <option value="once">Once</option>
                </select>
              </label>
              <label>
                {cadence === "daily" ? "Time" : "Date and time"}
                <input
                  required
                  type={cadence === "daily" ? "time" : "datetime-local"}
                  value={cadence === "daily" ? time : onceAt}
                  onChange={(event) =>
                    cadence === "daily" ? setTime(event.target.value) : setOnceAt(event.target.value)
                  }
                />
              </label>
            </div>
          ) : null}
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
                  setEditing(bundle);
                  setTitle(bundle.routine.title);
                  setInstruction(bundle.currentVersion.action.instruction);
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
      <p className="routine-cutover-note">
        Existing schedules remain the active background runner until their local migration replay
        is proven and cut over safely.
      </p>
    </section>
  );
}
