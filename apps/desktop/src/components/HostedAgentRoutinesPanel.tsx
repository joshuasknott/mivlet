import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useEffect, useMemo, useState } from "react";
import type { HostedAgentRoutineRunSnapshot, HostedAgentRoutineSnapshot } from "@fable/protocol";
import type { HostedAgentRoutineFormInput } from "../lib/hosted-agent-routine";

export interface HostedAgentRoutinesPanelState {
  scopeKey: string;
  agentName: string;
  ready: boolean;
  routines: HostedAgentRoutineSnapshot[];
  routinesLoading: boolean;
  routinesError: string | null;
  runs: HostedAgentRoutineRunSnapshot[];
  runsLoading: boolean;
  runsError: string | null;
  onRefresh: () => Promise<unknown> | void;
  onCreate: (input: HostedAgentRoutineFormInput) => Promise<unknown>;
  onCancel: (routineId: string) => Promise<unknown>;
  onPause: (routineId: string) => Promise<unknown>;
  onResume: (routineId: string) => Promise<unknown>;
}

const lifecycleRank = { active: 0, paused: 1, stale: 2, cancelled: 3 } as const;

export function HostedAgentRoutinesPanel({ state }: { state: HostedAgentRoutinesPanelState }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [changing, setChanging] = useState<{ routineId: string; action: "pause" | "resume" | "cancel" } | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [form, setForm] = useState<HostedAgentRoutineFormInput>({
    title: "",
    instruction: "",
    firstRunAt: "",
    intervalSeconds: 86_400,
    allowWorkspaceWrite: true,
    allowProcessRun: false,
    maxSteps: 6
  });
  useEffect(() => {
    setCreateOpen(false);
    setCreateError(null);
    setChangeError(null);
    setConfirmCancelId(null);
  }, [state.scopeKey]);
  const routines = useMemo(() => [...state.routines].sort((left, right) => {
    const lifecycle = lifecycleRank[left.lifecycle] - lifecycleRank[right.lifecycle];
    return lifecycle || (left.nextRunAt ?? left.updatedAt).localeCompare(right.nextRunAt ?? right.updatedAt);
  }), [state.routines]);

  const openCreate = () => {
    setCreateError(null);
    setForm((current) => ({ ...current, firstRunAt: current.firstRunAt || defaultFirstRunInput() }));
    setCreateOpen(true);
  };
  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await state.onCreate(form);
      setCreateOpen(false);
      setForm({ title: "", instruction: "", firstRunAt: "", intervalSeconds: 86_400, allowWorkspaceWrite: true, allowProcessRun: false, maxSteps: 6 });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "The cloud routine could not be created.");
    } finally {
      setCreating(false);
    }
  };
  const change = async (routineId: string, action: "pause" | "resume" | "cancel") => {
    setChanging({ routineId, action });
    setChangeError(null);
    setConfirmCancelId(null);
    try {
      if (action === "pause") await state.onPause(routineId);
      else if (action === "resume") await state.onResume(routineId);
      else await state.onCancel(routineId);
    } catch (error) {
      setChangeError(error instanceof Error ? error.message : `The cloud routine could not be ${action}d.`);
    } finally {
      setChanging(null);
    }
  };

  if (!state.ready) return null;
  return (
    <section className="hosted-agent-routines" aria-labelledby="hosted-agent-routines-title">
      <header className="hosted-agent-routines__header">
        <span>
          <span className="hosted-schedules__eyebrow">Teammate work</span>
          <h3 id="hosted-agent-routines-title">Agent routines</h3>
          <p>Describe an outcome. {state.agentName} reasons over the cloud workspace at each run.</p>
        </span>
        <button type="button" onClick={openCreate} disabled={creating} aria-expanded={createOpen}>
          <Plus size={15} aria-hidden="true" />New agent routine
        </button>
      </header>

      {createOpen ? (
        <form className="hosted-schedule-create hosted-agent-routine-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <header>
            <span><strong>New agent routine</strong><small>Give {state.agentName} a recurring outcome, not a fixed script.</small></span>
            <button type="button" onClick={() => setCreateOpen(false)} disabled={creating} aria-label="Close agent routine form"><X size={16} /></button>
          </header>
          <div className="hosted-schedule-create__fields">
            <label>
              <span>Name</span>
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={120} placeholder="Weekly workspace review" required />
            </label>
            <label>
              <span>First run</span>
              <input type="datetime-local" value={form.firstRunAt} onChange={(event) => setForm({ ...form, firstRunAt: event.target.value })} min={defaultFirstRunInput(1)} required />
            </label>
            <label>
              <span>Repeat</span>
              <select value={form.intervalSeconds} onChange={(event) => setForm({ ...form, intervalSeconds: Number(event.target.value) })}>
                <option value={900}>Every 15 minutes</option>
                <option value={3600}>Every hour</option>
                <option value={86400}>Every day</option>
                <option value={604800}>Every week</option>
              </select>
            </label>
            <label>
              <span>Tool-step limit</span>
              <select value={form.maxSteps} onChange={(event) => setForm({ ...form, maxSteps: Number(event.target.value) })}>
                <option value={4}>4 steps</option>
                <option value={6}>6 steps</option>
                <option value={8}>8 steps</option>
              </select>
            </label>
            <label className="hosted-agent-routine-create__instruction">
              <span>Outcome and boundaries</span>
              <textarea value={form.instruction} onChange={(event) => setForm({ ...form, instruction: event.target.value })} rows={5} maxLength={12000} placeholder="Review the notes in /workspace/research, update /workspace/reports/weekly.md with evidence, and report any missing source rather than guessing." required />
            </label>
          </div>
          <fieldset className="hosted-agent-routine-create__authority">
            <legend>Standing cloud authority</legend>
            <label><input type="checkbox" checked readOnly /> Read workspace files</label>
            <label><input type="checkbox" checked={form.allowWorkspaceWrite} onChange={(event) => setForm({ ...form, allowWorkspaceWrite: event.target.checked })} /> Create or replace workspace files</label>
            <label><input type="checkbox" checked={form.allowProcessRun} onChange={(event) => setForm({ ...form, allowProcessRun: event.target.checked })} /> Run generated programs and commands in the isolated workspace</label>
          </fieldset>
          <p><WarningCircle size={15} aria-hidden="true" />This standing authority applies to every run. Fable will show the exact instruction and capabilities before enabling it.</p>
          {createError ? <span className="hosted-schedule-create__error" role="alert">{createError}</span> : null}
          <footer>
            <button type="button" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button>
            <button type="submit" disabled={creating}>{creating ? "Awaiting approval…" : "Review and enable"}</button>
          </footer>
        </form>
      ) : null}

      {state.routinesLoading ? (
        <p className="hosted-agent-routines__status" role="status">Checking agent routines…</p>
      ) : state.routinesError ? (
        <div className="hosted-schedules__error" role="alert"><WarningCircle size={18} /><span><strong>Agent routines could not be loaded</strong><small>{state.routinesError}</small></span><button type="button" onClick={() => void state.onRefresh()}>Retry</button></div>
      ) : routines.length === 0 ? (
        <div className="hosted-agent-routines__empty"><Brain size={20} aria-hidden="true" /><span><strong>No agent routines yet</strong><small>Start with a repeatable workspace outcome that does not need website logins.</small></span></div>
      ) : (
        <ul className="hosted-schedules__list hosted-agent-routines__list" aria-label={`${state.agentName} agent routines`}>
          {routines.map((routine) => {
            const runs = state.runs.filter((run) => run.routineId === routine.routineId).sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
            const working = changing?.routineId === routine.routineId;
            const attention = routine.lifecycle === "stale" || routine.lastRunLifecycle === "failed" || Boolean(routine.lastErrorCode);
            return (
              <li key={routine.routineId} className={`hosted-schedule hosted-agent-routine${attention ? " is-attention" : ""}${routine.lifecycle === "paused" ? " is-paused" : ""}${routine.lifecycle === "cancelled" || routine.lifecycle === "stale" ? " is-ended" : ""}`}>
                <span className="hosted-schedule__marker"><Brain size={17} aria-hidden="true" /></span>
                <span className="hosted-schedule__body">
                  <span className="hosted-schedule__title"><strong>{routine.title}</strong><span className={`hosted-schedule__badge hosted-schedule__badge--${routine.lifecycle}${attention ? " is-attention" : ""}`}>{attention && routine.lifecycle === "active" ? "Needs attention" : lifecycleLabel(routine)}</span></span>
                  <span className="hosted-schedule__timing">{formatInterval(routine.intervalSeconds)}{routine.nextRunAt ? <span> · Next <time dateTime={routine.nextRunAt}>{formatDate(routine.nextRunAt)}</time></span> : null}{routine.lastRunAt ? <span> · Last <time dateTime={routine.lastRunAt}>{formatDate(routine.lastRunAt)}</time></span> : null}</span>
                  <p className="hosted-agent-routine__instruction">{routine.instruction}</p>
                  <span className="hosted-agent-routine__capabilities">{routine.capabilities.map(capabilityLabel).join(" · ")} · {routine.maxSteps} tool steps</span>
                  {routine.lastResult ? <div className="hosted-agent-routine__result"><strong>Latest result</strong><p>{routine.lastResult}</p></div> : null}
                  {routine.lastErrorCode ? <span className="hosted-schedule__problem"><WarningCircle size={14} />Last run: {routine.lastErrorCode}</span> : null}
                  {runs.length > 0 ? <details className="hosted-schedule-history"><summary>{runs.length} recent run{runs.length === 1 ? "" : "s"}</summary><ol>{runs.slice(0, 20).map((run) => <RoutineRun key={run.occurrenceId} run={run} />)}</ol></details> : null}
                </span>
                {routine.lifecycle === "active" || routine.lifecycle === "paused" ? <span className="hosted-schedule__actions">
                  <button type="button" className="hosted-schedule__control" onClick={() => void change(routine.routineId, routine.lifecycle === "active" ? "pause" : "resume")} disabled={working} aria-label={`${routine.lifecycle === "active" ? "Pause" : "Resume"} ${routine.title}`}>{routine.lifecycle === "active" ? <Pause size={14} /> : <Play size={14} />}{working && changing?.action !== "cancel" ? "Awaiting approval…" : routine.lifecycle === "active" ? "Pause" : "Resume"}</button>
                  {confirmCancelId === routine.routineId ? <button type="button" className="hosted-schedule__cancel-confirm" onClick={() => void change(routine.routineId, "cancel")} disabled={working}>Confirm cancel</button> : <button type="button" className="hosted-schedule__cancel" onClick={() => setConfirmCancelId(routine.routineId)} disabled={working} aria-label={`Cancel ${routine.title}`}><X size={14} />Cancel</button>}
                </span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {changeError ? <p className="hosted-schedules__cancel-error" role="alert">{changeError}</p> : null}
      {state.runsLoading ? <p className="hosted-schedules__history-status" role="status">Checking recent teammate runs…</p> : null}
      {state.runsError ? <p className="hosted-schedules__history-status is-error" role="alert">Routine history unavailable: {state.runsError}</p> : null}
    </section>
  );
}

function RoutineRun({ run }: { run: HostedAgentRoutineRunSnapshot }) {
  return <li><span className="hosted-schedule-history__summary"><span className={`hosted-schedule-history__state is-${run.lifecycle}`}>{run.lifecycle === "completed" ? "Succeeded" : run.lifecycle === "failed" ? "Failed" : run.lifecycle === "stale" ? "Interrupted" : "Running"}</span><time dateTime={run.scheduledAt}>{formatDate(run.scheduledAt)}</time>{run.errorCode ? <small>{run.errorCode}</small> : null}</span>{run.result ? <p className="hosted-agent-routine-run__result">{run.result}</p> : null}{run.tools.length > 0 ? <ul className="hosted-agent-routine-run__tools">{run.tools.map((tool, index) => <li key={`${tool.tool}-${index}`} className={tool.status === "failed" ? "is-failed" : ""}>{tool.summary}</li>)}</ul> : null}</li>;
}

function lifecycleLabel(routine: HostedAgentRoutineSnapshot): string {
  if (routine.lifecycle === "stale") return "Computer changed";
  if (routine.lifecycle === "cancelled") return "Cancelled";
  if (routine.lifecycle === "paused") return "Paused";
  return routine.lastRunLifecycle === "failed" || routine.lastErrorCode ? "Needs attention" : "Active";
}

function capabilityLabel(value: string): string {
  if (value === "workspace-read") return "Read workspace";
  if (value === "workspace-write") return "Write workspace";
  return "Run programs";
}

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "Every day" : `Every ${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "Every hour" : `Every ${seconds / 3_600} hours`;
  return `Every ${Math.round(seconds / 60)} minutes`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

function defaultFirstRunInput(offsetMinutes = 60): string {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
