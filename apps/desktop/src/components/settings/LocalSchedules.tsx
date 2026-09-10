import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SettingsRuntime } from "./settings-runtime";
import { resolveProviderModelOption } from "../../lib/provider-models";
import {
  createLocalSchedule, listLocalSchedules, listLocalScheduleOccurrences,
  setLocalScheduleStatus, updateLocalSchedule,
  type LocalSchedule, type LocalScheduleTrigger,
} from "../../runtime/domains/local-schedules";

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "The schedule could not be saved.";

export function LocalSchedules({ runtime, onOpenResult, initialAgentId }: { runtime: SettingsRuntime; initialAgentId?: string; onOpenResult?: (agentId: string, threadId: string) => Promise<void> }) {
  const workspaceId = runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  return <SchedulesWorkspace key={workspaceId} workspaceId={workspaceId} runtime={runtime} initialAgentId={initialAgentId} onOpenResult={onOpenResult} />;
}

function SchedulesWorkspace({ workspaceId, runtime, onOpenResult, initialAgentId }: { workspaceId: string; runtime: SettingsRuntime; initialAgentId?: string; onOpenResult?: (agentId: string, threadId: string) => Promise<void> }) {
  const queryClient = useQueryClient();
  const queryKey = ["local-schedules", workspaceId];
  const schedules = useQuery({ queryKey, queryFn: () => listLocalSchedules(workspaceId), retry: false, refetchInterval: 30_000 });
  const [filterAgentId, setFilterAgentId] = useState(initialAgentId ?? "");
  const [editing, setEditing] = useState<LocalSchedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey }); };
  const act = async (operation: () => Promise<unknown>, success: string) => {
    setPending(true);
    setStatus("");
    try { await operation(); await refresh(); setStatus(success); }
    catch (error) { setStatus(errorText(error)); }
    finally { setPending(false); }
  };
  return <div className="settings-page__body local-schedules">
    <div className="settings-section-heading"><p>Run web research with a named agent at a set time. Keep Mivlet open and this computer awake.</p></div>
    <details className="schedule-limits"><summary>What scheduled runs can do</summary><p>Scheduled runs use the saved Codex provider and model. They cannot use your apps or computer tools. Anything requiring permission stops for your attention.</p></details>
    <div className="schedules-toolbar"><label className="settings-field"><span>Show schedules for</span><select aria-label="Filter schedules by agent" value={filterAgentId} onChange={(event) => { setFilterAgentId(event.target.value); setCreating(false); setEditing(null); }}><option value="">All agents</option>{runtime.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    <button type="button" className="button button--primary" disabled={pending || schedules.isPending || !!schedules.error} onClick={() => { setEditing(null); setCreating(true); }}>New schedule</button></div>
    {schedules.isPending ? <p role="status">Loading schedules…</p> : null}
    {schedules.error ? <p role="alert">{errorText(schedules.error)}</p> : null}
    {creating || editing ? <ScheduleEditor key={editing?.id ?? "new"} runtime={runtime} initialAgentId={filterAgentId} schedule={editing} pending={pending}
      onCancel={() => { setEditing(null); setCreating(false); }}
      onSave={(input) => void act(async () => {
        if (editing) await updateLocalSchedule({ ...input, workspaceId, id: editing.id, expectedRevision: editing.revision });
        else await createLocalSchedule({ ...input, workspaceId, id: crypto.randomUUID(), status: "enabled" });
        setEditing(null); setCreating(false);
      }, editing ? "Schedule updated." : "Schedule created.")} /> : null}
    {schedules.data?.filter((schedule) => schedule.status !== "cancelled" && (!filterAgentId || schedule.agentId === filterAgentId)).map((schedule) => <article className="profile-section" key={schedule.id}>
      <strong>{runtime.agents.find((agent) => agent.id === schedule.agentId)?.name ?? "Unavailable agent"}</strong>
      <p className="local-schedules__prompt">{schedule.prompt}</p>
      <small>{describeTrigger(schedule.trigger)} · {schedule.timezone} · {schedule.status === "paused" ? "Paused" : schedule.nextRunAt ? `Next: ${new Date(schedule.nextRunAt).toLocaleString()}` : "No future run"}</small>
      <small>{schedule.providerId} · {schedule.model}</small>
      <div className="profile-action-row">
        <button type="button" className="button button--secondary" disabled={pending} onClick={() => { setCreating(false); setEditing(schedule); }}>Edit</button>
        <button type="button" className="button button--secondary" disabled={pending} onClick={() => void act(() => setLocalScheduleStatus({ workspaceId, id: schedule.id, expectedRevision: schedule.revision, status: schedule.status === "paused" ? "enabled" : "paused" }), schedule.status === "paused" ? "Schedule resumed." : "Schedule paused.")}>{schedule.status === "paused" ? "Resume" : "Pause"}</button>
        <button type="button" className="button button--secondary" disabled={pending} onClick={() => void act(() => setLocalScheduleStatus({ workspaceId, id: schedule.id, expectedRevision: schedule.revision, status: "cancelled" }), "Schedule cancelled.")}>Cancel schedule</button>
      </div>
      <ScheduleResults workspaceId={workspaceId} scheduleId={schedule.id} onOpenResult={onOpenResult ? (threadId) => onOpenResult(schedule.agentId, threadId) : undefined} />
    </article>)}
    {schedules.data && !schedules.data.some((schedule) => schedule.status !== "cancelled" && (!filterAgentId || schedule.agentId === filterAgentId)) ? <p>No schedules yet.</p> : null}
    {status ? <p role="status">{status}</p> : null}
  </div>;
}

function ScheduleResults({ workspaceId, scheduleId, onOpenResult }: { workspaceId: string; scheduleId: string; onOpenResult?: (threadId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const results = useQuery({ queryKey: ["local-schedule-results", workspaceId, scheduleId], queryFn: () => listLocalScheduleOccurrences(workspaceId, scheduleId), enabled: open, retry: false, refetchInterval: open ? 15_000 : false });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Recent runs</summary>
    {results.isFetching && !results.data ? <p>Loading results…</p> : null}
    {results.error ? <p role="alert">{errorText(results.error)}</p> : null}
    {results.data?.length === 0 ? <p>No runs yet.</p> : null}
    {results.data?.map((run) => <div key={run.id}><p>{new Date(run.scheduledFor).toLocaleString()} · {run.state}{run.detail ? ` — ${run.detail}` : ""}</p>{run.threadId && onOpenResult ? <button type="button" className="button button--secondary" onClick={() => void onOpenResult(run.threadId!).catch((failure) => setError(errorText(failure)))}>Open conversation</button> : null}</div>)}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}

type EditorInput = Pick<LocalSchedule, "agentId" | "providerId" | "model" | "prompt" | "timezone" | "trigger">;
export function ScheduleEditor({ runtime, schedule, pending, onSave, onCancel, initialAgentId }: { runtime: SettingsRuntime; initialAgentId?: string; schedule: LocalSchedule | null; pending: boolean; onSave: (input: EditorInput) => void; onCancel: () => void }) {
  const [agentId, setAgentId] = useState(schedule?.agentId ?? initialAgentId ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [kind, setKind] = useState<LocalScheduleTrigger["kind"]>(schedule?.trigger.kind ?? "daily");
  const [time, setTime] = useState(schedule?.trigger.kind !== "once" ? schedule?.trigger.localTime ?? "09:00" : "09:00");
  const [dateTime, setDateTime] = useState(schedule?.trigger.kind === "once" ? schedule.trigger.localDateTime : "");
  const [weekday, setWeekday] = useState(schedule?.trigger.kind === "weekly" ? schedule.trigger.weekday : "monday");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const agent = runtime.agents.find((item) => item.id === agentId);
  const route = schedule && agentId === schedule.agentId
    ? runtime.allModelOptions.find((model) => model.providerId === schedule.providerId && model.modelId === schedule.model && model.available)
    : agent ? resolveProviderModelOption(runtime.allModelOptions, agent.modelId) : undefined;
  const provider = runtime.backendProviders.find((item) => item.id === route?.providerId);
  const supported = route && provider?.backendType === "codex-app-server" && provider.authState === "connected";
  const [invalid, setInvalid] = useState("");
  return <form className="profile-section local-schedules__editor" onSubmit={(event) => {
    event.preventDefault();
    if (!route || !supported || !agent) return;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { setInvalid("Enter a valid time zone, such as Europe/London."); return; }
    const trigger: LocalScheduleTrigger = kind === "once" ? { kind, localDateTime: dateTime } : kind === "daily" ? { kind, localTime: time } : { kind, weekday, localTime: time };
    onSave({ agentId, providerId: route.providerId, model: route.modelId, prompt: prompt.trim(), timezone, trigger });
  }}>
    <label>Agent<select className="input" required value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">Choose an agent</option>{runtime.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {agent ? <small>{supported ? `Uses ${provider.label} · ${route.modelId}` : "This agent needs an available model from a connected Codex provider."}</small> : null}
    <label>Research task<textarea className="input" required maxLength={32000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the agent research?" /></label>
    <label>Repeat<select className="input" value={kind} onChange={(event) => setKind(event.target.value as LocalScheduleTrigger["kind"])}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
    {kind === "weekly" ? <label>Day<select className="input" value={weekday} onChange={(event) => setWeekday(event.target.value)}>{weekdays.map((day) => <option key={day} value={day}>{day}</option>)}</select></label> : null}
    {kind === "once" ? <label>Date and time<input className="input" type="datetime-local" required value={dateTime} onChange={(event) => setDateTime(event.target.value)} /></label> : <label>Time<input className="input" type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>}
    <label>Time zone<input className="input" required value={timezone} onChange={(event) => { setTimezone(event.target.value); setInvalid(""); }} /></label>
    {invalid ? <p role="alert">{invalid}</p> : null}
    <div className="profile-action-row"><button type="submit" className="button button--primary" disabled={pending || !supported || !prompt.trim()}>{pending ? "Saving…" : "Save schedule"}</button><button type="button" className="button button--secondary" disabled={pending} onClick={onCancel}>Close</button></div>
  </form>;
}

function describeTrigger(trigger: LocalScheduleTrigger) {
  return trigger.kind === "once" ? trigger.localDateTime.replace("T", " ") : trigger.kind === "daily" ? `Daily at ${trigger.localTime}` : `${trigger.weekday} at ${trigger.localTime}`;
}
