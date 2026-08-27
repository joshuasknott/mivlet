import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HostedAgentRoutineRunSnapshot, HostedAgentRoutineSnapshot, HostedProcessScheduleRunSnapshot, HostedProcessScheduleSnapshot, HostedProcessSnapshot } from "@fable/protocol";
import type { HostedScheduleFormInput } from "../lib/hosted-schedule-creation";
import type { HostedAgentRoutineFormInput } from "../lib/hosted-agent-routine";
import { HostedAgentRoutinesPanel } from "./HostedAgentRoutinesPanel";

export interface HostedSchedulesPageState {
  scopeKey: string;
  agentName: string;
  available: boolean;
  status?: "provisioning" | "ready" | "degraded" | "destroyed";
  keepAlive: boolean;
  loading: boolean;
  provisioning: boolean;
  schedules: HostedProcessScheduleSnapshot[];
  schedulesLoading: boolean;
  schedulesRefreshing: boolean;
  schedulesError: string | null;
  scheduleRuns: HostedProcessScheduleRunSnapshot[];
  scheduleRunsLoading: boolean;
  scheduleRunsError: string | null;
  agentRoutines: HostedAgentRoutineSnapshot[];
  agentRoutinesLoading: boolean;
  agentRoutinesError: string | null;
  agentRoutineRuns: HostedAgentRoutineRunSnapshot[];
  agentRoutineRunsLoading: boolean;
  agentRoutineRunsError: string | null;
  onProvision: () => void;
  onRefresh: () => Promise<unknown> | void;
  onCreate: (input: HostedScheduleFormInput) => Promise<unknown>;
  onCancel: (scheduleId: string) => Promise<unknown>;
  onPause: (scheduleId: string) => Promise<unknown>;
  onResume: (scheduleId: string) => Promise<unknown>;
  onInspectRun: (processId: string) => Promise<HostedProcessSnapshot>;
  onCreateAgentRoutine: (input: HostedAgentRoutineFormInput) => Promise<unknown>;
  onCancelAgentRoutine: (routineId: string) => Promise<unknown>;
  onPauseAgentRoutine: (routineId: string) => Promise<unknown>;
  onResumeAgentRoutine: (routineId: string) => Promise<unknown>;
}

const lifecycleRank = { active: 0, paused: 1, stale: 2, cancelled: 3 } as const;

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `Every ${days === 1 ? "day" : `${days} days`}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `Every ${hours === 1 ? "hour" : `${hours} hours`}`;
  }
  const minutes = Math.round(seconds / 60);
  return `Every ${minutes} minutes`;
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

function lifecycleLabel(schedule: HostedProcessScheduleSnapshot): string {
  if (schedule.lifecycle === "stale") return "Computer changed";
  if (schedule.lifecycle === "cancelled") return "Cancelled";
  if (schedule.lifecycle === "paused") return "Paused";
  return schedule.lastErrorCode ? "Needs attention" : "Active";
}

export function HostedSchedulesPanel({ state }: { state: HostedSchedulesPageState }) {
  const [confirmScheduleId, setConfirmScheduleId] = useState<string | null>(null);
  const [cancellingScheduleId, setCancellingScheduleId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [changingSchedule, setChangingSchedule] = useState<{ scheduleId: string; action: "pause" | "resume" } | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    label: "",
    programPath: "",
    argumentsText: "",
    firstRunAt: "",
    intervalSeconds: 3_600
  });
  const [runOutputs, setRunOutputs] = useState<Record<string, {
    loading: boolean;
    error: string | null;
    snapshot: HostedProcessSnapshot | null;
  }>>({});
  const scopeKeyRef = useRef(state.scopeKey);
  scopeKeyRef.current = state.scopeKey;
  useEffect(() => {
    setRunOutputs({});
    setCreateOpen(false);
    setCreateError(null);
  }, [state.scopeKey]);
  const schedules = useMemo(
    () => [...state.schedules].sort((left, right) => {
      const lifecycle = lifecycleRank[left.lifecycle] - lifecycleRank[right.lifecycle];
      if (lifecycle !== 0) return lifecycle;
      return (left.nextRunAt ?? left.updatedAt).localeCompare(right.nextRunAt ?? right.updatedAt);
    }),
    [state.schedules]
  );
  const ready = state.status === "ready" && state.keepAlive;
  const cancel = async (scheduleId: string) => {
    setConfirmScheduleId(null);
    setCancellingScheduleId(scheduleId);
    setCancelError(null);
    try {
      await state.onCancel(scheduleId);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "The always-on schedule could not be cancelled.");
    } finally {
      setCancellingScheduleId(null);
    }
  };
  const inspectRun = async (run: HostedProcessScheduleRunSnapshot) => {
    if (!run.processId) return;
    const requestedScopeKey = state.scopeKey;
    setRunOutputs((current) => ({
      ...current,
      [run.occurrenceId]: { loading: true, error: null, snapshot: null }
    }));
    try {
      const snapshot = await state.onInspectRun(run.processId);
      if (scopeKeyRef.current !== requestedScopeKey) return;
      setRunOutputs((current) => ({
        ...current,
        [run.occurrenceId]: { loading: false, error: null, snapshot }
      }));
    } catch (error) {
      if (scopeKeyRef.current !== requestedScopeKey) return;
      setRunOutputs((current) => ({
        ...current,
        [run.occurrenceId]: {
          loading: false,
          error: error instanceof Error ? error.message : "That run output could not be loaded.",
          snapshot: null
        }
      }));
    }
  };
  const control = async (scheduleId: string, action: "pause" | "resume") => {
    setChangingSchedule({ scheduleId, action });
    setChangeError(null);
    try {
      await (action === "pause" ? state.onPause(scheduleId) : state.onResume(scheduleId));
    } catch (error) {
      setChangeError(error instanceof Error ? error.message : `The always-on schedule could not be ${action}d.`);
    } finally {
      setChangingSchedule(null);
    }
  };
  const openCreate = () => {
    setCreateError(null);
    setCreateForm((current) => ({
      ...current,
      firstRunAt: current.firstRunAt || defaultFirstRunInput()
    }));
    setCreateOpen(true);
  };
  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await state.onCreate({
        label: createForm.label,
        programPath: createForm.programPath,
        arguments: createForm.argumentsText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean),
        firstRunAt: createForm.firstRunAt,
        intervalSeconds: createForm.intervalSeconds
      });
      setCreateOpen(false);
      setCreateForm({ label: "", programPath: "", argumentsText: "", firstRunAt: "", intervalSeconds: 3_600 });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "The always-on schedule could not be created.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="hosted-schedules" aria-labelledby="hosted-schedules-title">
      <header className="hosted-schedules__header">
        <span className={`hosted-schedules__icon${ready ? " is-ready" : ""}`}>
          <Cloud size={20} weight={ready ? "fill" : "regular"} aria-hidden="true" />
        </span>
        <span className="hosted-schedules__heading">
          <span className="hosted-schedules__eyebrow">Cloud computer</span>
          <h2 id="hosted-schedules-title">Always-on work</h2>
          <p>{state.agentName} can reason through recurring outcomes or run approved programs while every client is closed.</p>
        </span>
        <span className="hosted-schedules__header-actions">
          {ready ? (
            <>
              <button type="button" onClick={openCreate} disabled={creating} aria-expanded={createOpen}>
                <Plus size={15} aria-hidden="true" />Schedule program
              </button>
              <button
                type="button"
                onClick={() => void state.onRefresh()}
                disabled={state.schedulesLoading || state.schedulesRefreshing}
                aria-label="Refresh always-on schedules"
              >
                <ArrowClockwise size={15} aria-hidden="true" />
                {state.schedulesRefreshing ? "Refreshing" : "Refresh"}
              </button>
            </>
          ) : state.available && state.status !== "provisioning" ? (
            <button type="button" onClick={state.onProvision} disabled={state.provisioning || state.loading}>
              {state.status === "degraded" ? "Retry setup" : "Set up computer"}
            </button>
          ) : null}
        </span>
      </header>

      <HostedAgentRoutinesPanel state={{
        scopeKey: state.scopeKey,
        agentName: state.agentName,
        ready,
        routines: state.agentRoutines,
        routinesLoading: state.agentRoutinesLoading,
        routinesError: state.agentRoutinesError,
        runs: state.agentRoutineRuns,
        runsLoading: state.agentRoutineRunsLoading,
        runsError: state.agentRoutineRunsError,
        onRefresh: state.onRefresh,
        onCreate: state.onCreateAgentRoutine,
        onCancel: state.onCancelAgentRoutine,
        onPause: state.onPauseAgentRoutine,
        onResume: state.onResumeAgentRoutine
      }} />

      {ready && createOpen ? (
        <form className="hosted-schedule-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <header>
            <span><strong>Schedule a program</strong><small>Advanced: repeat an exact program already saved in this cloud workspace.</small></span>
            <button type="button" onClick={() => setCreateOpen(false)} disabled={creating} aria-label="Close always-on schedule form"><X size={16} /></button>
          </header>
          <div className="hosted-schedule-create__fields">
            <label>
              <span>Name</span>
              <input value={createForm.label} onChange={(event) => setCreateForm({ ...createForm, label: event.target.value })} maxLength={80} placeholder="Weekly digest" required />
            </label>
            <label>
              <span>Program in /workspace</span>
              <input value={createForm.programPath} onChange={(event) => setCreateForm({ ...createForm, programPath: event.target.value })} placeholder="scripts/digest.mjs" spellCheck={false} required />
              <small>JavaScript, Python, or shell files only.</small>
            </label>
            <label>
              <span>First run</span>
              <input type="datetime-local" value={createForm.firstRunAt} onChange={(event) => setCreateForm({ ...createForm, firstRunAt: event.target.value })} min={defaultFirstRunInput(1)} required />
            </label>
            <label>
              <span>Repeat</span>
              <select value={createForm.intervalSeconds} onChange={(event) => setCreateForm({ ...createForm, intervalSeconds: Number(event.target.value) })}>
                <option value={900}>Every 15 minutes</option>
                <option value={3600}>Every hour</option>
                <option value={86400}>Every day</option>
                <option value={604800}>Every week</option>
              </select>
            </label>
            <label className="hosted-schedule-create__arguments">
              <span>Arguments <small>optional · one per line</small></span>
              <textarea value={createForm.argumentsText} onChange={(event) => setCreateForm({ ...createForm, argumentsText: event.target.value })} rows={3} placeholder={'--format\nmarkdown'} spellCheck={false} />
            </label>
          </div>
          <p><WarningCircle size={15} aria-hidden="true" />Do not put passwords, tokens, or other secrets in program arguments.</p>
          {createError ? <span className="hosted-schedule-create__error" role="alert">{createError}</span> : null}
          <footer>
            <button type="button" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button>
            <button type="submit" disabled={creating}>{creating ? "Awaiting approval…" : "Review and create"}</button>
          </footer>
        </form>
      ) : null}

      {ready ? (
        <header className="hosted-program-schedules__header">
          <span className="hosted-schedules__eyebrow">Advanced</span>
          <h3>Program schedules</h3>
          <p>Repeat an exact script without asking the teammate to reinterpret the outcome.</p>
        </header>
      ) : null}

      {!state.available ? (
        <div className="hosted-schedules__empty">
          <strong>Hosted workspace required</strong>
          <span>Sign in to a hosted Fable workspace to run schedules independently of this device.</span>
        </div>
      ) : state.loading || state.provisioning || state.status === "provisioning" ? (
        <div className="hosted-schedules__empty" role="status" aria-live="polite">
          <strong>Starting {state.agentName}&apos;s cloud computer…</strong>
          <span>Always-on schedules will appear after the isolated workspace is ready.</span>
        </div>
      ) : !ready ? (
        <div className="hosted-schedules__empty">
          <strong>{state.status === "degraded" ? "Cloud computer needs attention" : "No cloud computer yet"}</strong>
          <span>Set one up to let approved programs continue after you close Fable.</span>
        </div>
      ) : state.schedulesLoading ? (
        <div className="hosted-schedules__empty" role="status" aria-live="polite">
          <strong>Checking always-on work…</strong>
          <span>Reading the durable schedule state from {state.agentName}&apos;s computer.</span>
        </div>
      ) : state.schedulesError ? (
        <div className="hosted-schedules__error" role="alert">
          <WarningCircle size={18} aria-hidden="true" />
          <span><strong>Always-on schedules could not be loaded</strong><small>{state.schedulesError}</small></span>
          <button type="button" onClick={() => void state.onRefresh()}>Retry</button>
        </div>
      ) : schedules.length === 0 ? (
        <div className="hosted-schedules__empty">
          <strong>No program schedules</strong>
          <span>Use this only when the exact program is already saved in the hosted workspace.</span>
        </div>
      ) : (
        <ul className="hosted-schedules__list" aria-label={`${state.agentName} always-on schedules`}>
          {schedules.map((schedule) => {
            const nextRun = formatDate(schedule.nextRunAt);
            const lastRun = formatDate(schedule.lastRunAt);
            const cancelling = cancellingScheduleId === schedule.scheduleId;
            const confirming = confirmScheduleId === schedule.scheduleId;
            const recentRuns = state.scheduleRuns
              .filter((run) => run.scheduleId === schedule.scheduleId)
              .sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
            const latestRun = recentRuns[0];
            const latestFailed = latestRun?.lifecycle === "failed" || latestRun?.lifecycle === "stale";
            const attention = schedule.lifecycle === "stale" || Boolean(schedule.lastErrorCode) || latestFailed;
            return (
              <li key={schedule.scheduleId} className={`hosted-schedule${attention ? " is-attention" : ""}${schedule.lifecycle === "paused" ? " is-paused" : ""}${schedule.lifecycle === "cancelled" || schedule.lifecycle === "stale" ? " is-ended" : ""}`}>
                <span className="hosted-schedule__marker"><Clock size={17} aria-hidden="true" /></span>
                <span className="hosted-schedule__body">
                  <span className="hosted-schedule__title">
                    <strong>{schedule.runId}</strong>
                    <span className={`hosted-schedule__badge hosted-schedule__badge--${schedule.lifecycle}${schedule.lastErrorCode || latestFailed ? " is-attention" : ""}`}>
                      {latestFailed && schedule.lifecycle === "active" ? "Needs attention" : lifecycleLabel(schedule)}
                    </span>
                  </span>
                  <span className="hosted-schedule__timing">
                    {formatInterval(schedule.intervalSeconds)}
                    {nextRun ? <span> · Next <time dateTime={schedule.nextRunAt}>{nextRun}</time></span> : null}
                    {lastRun ? <span> · Last <time dateTime={schedule.lastRunAt}>{lastRun}</time></span> : null}
                  </span>
                  {schedule.lastErrorCode ? (
                    <span className="hosted-schedule__problem"><WarningCircle size={14} aria-hidden="true" />Last run: {schedule.lastErrorCode}</span>
                  ) : null}
                  <code title={schedule.scheduleId}>{schedule.scheduleId}</code>
                  {recentRuns.length > 0 ? (
                    <details className="hosted-schedule-history">
                      <summary>{recentRuns.length} recent run{recentRuns.length === 1 ? "" : "s"}</summary>
                      <ol>
                        {recentRuns.slice(0, 20).map((run) => {
                          const output = runOutputs[run.occurrenceId];
                          return (
                            <li key={run.occurrenceId}>
                              <span className="hosted-schedule-history__summary">
                                <span className={`hosted-schedule-history__state is-${run.lifecycle}`}>{runLifecycleLabel(run.lifecycle)}</span>
                                <time dateTime={run.scheduledAt}>{formatDate(run.scheduledAt)}</time>
                                {run.errorCode ? <small>{run.errorCode}</small>
                                  : run.exitCode !== undefined ? <small>Exit {run.exitCode}</small> : null}
                                {run.processId ? (
                                  <button type="button" onClick={() => void inspectRun(run)} disabled={output?.loading}>
                                    {output?.loading ? "Loading output…" : output?.snapshot ? "Refresh output" : "View output"}
                                  </button>
                                ) : null}
                              </span>
                              {output?.error ? <span className="hosted-schedule-output__error" role="alert">{output.error}</span> : null}
                              {output?.snapshot ? <RunOutput snapshot={output.snapshot} /> : null}
                            </li>
                          );
                        })}
                      </ol>
                    </details>
                  ) : null}
                </span>
                {schedule.lifecycle === "active" || schedule.lifecycle === "paused" ? (
                  <span className="hosted-schedule__actions">
                    <button
                      type="button"
                      className="hosted-schedule__control"
                      onClick={() => void control(schedule.scheduleId, schedule.lifecycle === "active" ? "pause" : "resume")}
                      disabled={changingSchedule !== null || cancellingScheduleId !== null}
                      aria-label={`${schedule.lifecycle === "active" ? "Pause" : "Resume"} ${schedule.runId}`}
                    >
                      {schedule.lifecycle === "active" ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                      {changingSchedule?.scheduleId === schedule.scheduleId
                        ? "Awaiting approval…"
                        : schedule.lifecycle === "active" ? "Pause" : "Resume"}
                    </button>
                    {confirming ? (
                      <button type="button" className="hosted-schedule__cancel-confirm" onClick={() => void cancel(schedule.scheduleId)}>
                        Confirm cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="hosted-schedule__cancel"
                        onClick={() => { setCancelError(null); setConfirmScheduleId(schedule.scheduleId); }}
                        disabled={cancellingScheduleId !== null}
                        aria-label={`Cancel ${schedule.runId}`}
                      >
                        <X size={14} aria-hidden="true" />
                        {cancelling ? "Awaiting approval…" : "Cancel"}
                      </button>
                    )}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {cancelError || changeError ? <p className="hosted-schedules__cancel-error" role="alert">{cancelError ?? changeError}</p> : null}
      {ready && state.scheduleRunsLoading ? <p className="hosted-schedules__history-status" role="status">Checking recent cloud runs…</p> : null}
      {ready && state.scheduleRunsError ? <p className="hosted-schedules__history-status is-error" role="alert">Run history unavailable: {state.scheduleRunsError}</p> : null}
      <p className="hosted-schedules__trust"><strong>Always-on means cloud execution.</strong> Local schedules below still require Fable to be running.</p>
    </section>
  );
}

function RunOutput({ snapshot }: { snapshot: HostedProcessSnapshot }) {
  const output = [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n").trim();
  return (
    <div className="hosted-schedule-output">
      <small>Fetched on request. Output is not stored in schedule history.</small>
      {output ? <pre>{output}</pre> : <em>This run produced no captured output.</em>}
      {snapshot.outputTruncated ? <strong>Output was truncated by the cloud computer.</strong> : null}
    </div>
  );
}

function runLifecycleLabel(lifecycle: HostedProcessScheduleRunSnapshot["lifecycle"]): string {
  if (lifecycle === "completed") return "Succeeded";
  if (lifecycle === "failed") return "Failed";
  if (lifecycle === "stale") return "Interrupted";
  if (lifecycle === "cancelling") return "Stopping";
  if (lifecycle === "running") return "Running";
  return "Starting";
}

function defaultFirstRunInput(offsetMinutes = 60): string {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
