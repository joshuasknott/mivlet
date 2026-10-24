import { lazy, Suspense, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Target } from "@phosphor-icons/react/dist/csr/Target";
import { ListBullets } from "@phosphor-icons/react/dist/csr/ListBullets";
import type { CollaborationWorkItem, OutcomeGoalInput } from "@mivlet/protocol";
import type { WorkspaceExecution } from "../../lib/workspace-execution";
import { editableQueue } from "../../lib/work-queue";
import { SidebarMenu } from "../agents/SidebarMenu";
import "./conversation-work-controls.css";

const goalLabels = { active: "In progress", paused: "Paused", completed: "Agent reports achieved", blocked: "Needs your input", "budget-exhausted": "Budget reached" };
const HostedTaskControls = lazy(() => import("../hosted/HostedTaskControls").then(module => ({ default: module.HostedTaskControls })));

/** Compact controls over native Work, never a second queue or execution owner. */
export function ConversationWorkControls({ work, conversationId, service, goalDraft, onGoalDraftChange, disabled = false }: {
  work: CollaborationWorkItem[];
  conversationId: string;
  service: WorkspaceExecution;
  goalDraft?: OutcomeGoalInput;
  onGoalDraftChange: (goal: OutcomeGoalInput | undefined) => void;
  disabled?: boolean;
}) {
  const queue = editableQueue(work, conversationId);
  const roots = work.filter(item => item.conversationId === conversationId && !item.parentId);
  const cloudTasks = roots.filter(item => item.hostedTask && item.hostedTask.phase !== "reconciled");
  const [cloudReviewId, setCloudReviewId] = useState<string>();
  const goalWork = [...roots].reverse().find(item => item.outcomeGoal && item.status !== "cancelled");
  const active = [...roots].reverse().find(item => item.status === "running" || item.status === "awaiting-approval");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string>();
  const [editText, setEditText] = useState("");
  const [page, setPage] = useState(0);
  const [goalForm, setGoalForm] = useState(false);
  const [details, setDetails] = useState(false);
  const [objective, setObjective] = useState(goalDraft?.objective ?? "");
  const [criteria, setCriteria] = useState(goalDraft?.successCriteria ?? "");
  const [turns, setTurns] = useState(goalDraft?.maxTurns ?? 6);
  const [tokens, setTokens] = useState(goalDraft?.maxTokens ?? 128000);
  const busy = pending || disabled;
  const action = async (operation: () => Promise<unknown>, done?: () => void) => {
    if (busy) return;
    setPending(true); setError("");
    try { await operation(); done?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This Work changed. Refresh before trying again."); }
    finally { setPending(false); }
  };
  const goal = goalDraft ?? goalWork?.outcomeGoal;
  const canStartGoal = !goalDraft && goalWork && (
    !["queued", "running", "waiting", "awaiting-approval"].includes(goalWork.status)
    || !["active", "paused"].includes(goalWork.outcomeGoal!.status)
  );
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(queue.length / 6) - 1));
  const lastLive = active?.liveSteering?.at(-1);
  const hasControls = Boolean(goal || goalForm || queue.length || cloudTasks.length || lastLive || error);
  if (!hasControls) return null;
  return <section className="conversation-work-controls" aria-label="Goal and queued requests">
    {goal ? <div className="conversation-goal-row">
      <Target size={20} aria-hidden="true" />
      <div className="conversation-goal-name"><span>{goalDraft ? "Next request goal" : "Goal"}: {goal.objective}</span>
        <small>{goalDraft ? `${goalDraft.maxTurns} turns · ${goalDraft.maxTokens.toLocaleString()} tokens` : goalLabels[goalWork!.outcomeGoal!.status]}</small>
      </div>
      <div className="conversation-work-actions">
        {goalDraft ? <button type="button" disabled={busy} onClick={() => onGoalDraftChange(undefined)} aria-label="Remove goal from next request"><Trash size={16} aria-hidden="true" /></button>
          : goalWork && ["active", "paused"].includes(goalWork.outcomeGoal!.status) && ["queued", "running", "waiting", "awaiting-approval"].includes(goalWork.status)
            ? <button type="button" disabled={busy} onClick={() => void action(() => service.command({ action: "set-goal-paused", id: goalWork.id, expectedGeneration: goalWork.generation, paused: goalWork.outcomeGoal!.status !== "paused" }))}>
              {goalWork.outcomeGoal!.status === "paused" ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
              {goalWork.outcomeGoal!.status === "paused" ? "Resume" : "Pause"}
            </button> : null}
        <button type="button" aria-expanded={details} onClick={() => setDetails(!details)}><ListBullets size={16} aria-hidden="true" />Details</button>
        {canStartGoal ? <button type="button" disabled={busy} aria-expanded={goalForm} onClick={() => { setObjective(""); setCriteria(""); setGoalForm(true); }}>New goal for next request</button> : null}
      </div>
    </div> : null}
    {details && goal ? <div className="conversation-work-detail">
      <p>{goal.successCriteria}</p>
      {goalWork && !goalDraft ? <><p>{goalWork.turnCount}/{goalWork.maxTurns} turns · {goalWork.tokenUsage.toLocaleString()}/{goalWork.maxTokens.toLocaleString()} reported tokens. Pause takes effect after the current turn.</p>
        {goalWork.outcomeGoal?.report ? <p>{goalWork.outcomeGoal.report.text}</p> : null}
        <p>Progress and completion are the agent’s reports. Saved results retain their source; approvals remain exact.</p></> : <p>This goal starts when you send the next request.</p>}
    </div> : null}
    {goalForm ? <form className="conversation-work-form" onSubmit={event => {
      event.preventDefault();
      onGoalDraftChange({ objective: objective.trim(), successCriteria: criteria.trim(), maxTurns: turns, maxTokens: tokens });
      setGoalForm(false);
    }}>
      <label>Outcome<input value={objective} onChange={event => setObjective(event.target.value)} required maxLength={2000} placeholder="What should be true when the work is finished?" /></label>
      <label>Success criteria<textarea value={criteria} onChange={event => setCriteria(event.target.value)} required maxLength={4000} rows={2} placeholder="Evidence the agent should check before reporting success" /></label>
      <div className="conversation-goal-budgets"><label>Turn limit<input type="number" min={1} max={24} required value={turns} onChange={event => setTurns(event.target.valueAsNumber)} /></label>
        <label>Token limit<input type="number" min={1000} max={512000} step={1000} required value={tokens} onChange={event => setTokens(event.target.valueAsNumber)} /></label></div>
      <div className="conversation-work-actions"><button type="submit" disabled={busy || !objective.trim() || !criteria.trim()}>Use for next request</button><button type="button" onClick={() => setGoalForm(false)}>Cancel</button></div>
    </form> : null}
    {queue.length ? <div className="conversation-work-queue">
      <ol aria-label="Queued requests" start={pageIndex * 6 + 1}>
        {queue.slice(pageIndex * 6, pageIndex * 6 + 6).map((item, offset) => {
          const index = pageIndex * 6 + offset;
          return <li key={item.id}>
            <ListBullets className="conversation-queue-icon" size={15} aria-hidden="true" />
            {editing === item.id ? <form className="conversation-work-form" onSubmit={event => { event.preventDefault(); void action(() => service.command({ action: "edit-queued-work", id: item.id, expectedGeneration: item.generation, prompt: editText }), () => setEditing(undefined)); }}>
              <label>Edit queued request<textarea autoFocus required maxLength={32000} rows={2} value={editText} onChange={event => setEditText(event.target.value)} /></label>
              <div className="conversation-work-actions"><button type="submit" disabled={busy || !editText.trim()}>Save</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button></div>
            </form> : <>
              <div className="conversation-queue-message"><span title={item.userRequest}>{item.userRequest}</span>
                {item.queue?.held ? <small>Paused</small> : null}
                {item.attachments?.length ? <small>{item.attachments.length} attached</small> : null}
              </div>
              <div className="conversation-queue-actions">
                <button type="button" className="conversation-queue-steer" aria-label={`Steer with queued request ${index + 1}`}
                  title={item.attachments?.length || item.outcomeGoal ? "Requests with files or goals stay queued" : item.userRequest.length > 2000 ? "Live steering supports up to 2,000 characters" : "Send to this agent’s active foreground Codex turn"}
                  disabled={busy || Boolean(item.attachments?.length || item.outcomeGoal) || item.userRequest.length > 2000 || !roots.some(root => root.agentId === item.agentId && root.status === "running" && root.currentRunId && root.modelOptionId.startsWith("codex::") && !root.executionOwner)}
                  onClick={() => void action(() => service.steerQueued(item.id, item.generation))}><ArrowRight size={15} aria-hidden="true" />Steer</button>
                <button type="button" title="Remove" aria-label={`Remove queued request ${index + 1}`} disabled={busy} onClick={() => void action(() => service.stop(item.id))}><Trash size={16} aria-hidden="true" /></button>
                <SidebarMenu label={`Options for queued request ${index + 1}`} triggerClassName="conversation-queue-more" items={[
                  { label: "Edit", disabled: busy, run: () => { setEditText(item.userRequest); setEditing(item.id); } },
                  { label: "Move up", disabled: busy || index === 0, run: () => void action(() => service.command({ action: "move-queued-work", id: item.id, expectedGeneration: item.generation, beforeId: queue[index - 1].id })) },
                  { label: "Move down", disabled: busy || index === queue.length - 1, run: () => void action(() => service.command({ action: "move-queued-work", id: item.id, expectedGeneration: item.generation, beforeId: queue[index + 2]?.id })) },
                  { label: item.queue?.held ? "Resume" : "Pause", disabled: busy, run: () => void action(() => service.command({ action: "set-work-held", id: item.id, expectedGeneration: item.generation, held: !item.queue?.held })) },
                  ...(!item.hostedTask ? [{ label: "Cloud options", disabled: busy, run: () => setCloudReviewId(item.id) }] : []),
                ]} />
              </div>
            </>}
          </li>;
        })}
      </ol>
      {queue.length > 6 ? <div className="conversation-work-actions"><button type="button" disabled={!pageIndex} onClick={() => setPage(pageIndex - 1)}>Previous</button><span>{pageIndex + 1}/{Math.ceil(queue.length / 6)}</span><button type="button" disabled={(pageIndex + 1) * 6 >= queue.length} onClick={() => setPage(pageIndex + 1)}>Next</button></div> : null}
    </div> : null}
    {roots.filter(item => item.id === cloudReviewId || cloudTasks.includes(item)).map(item => <Suspense key={item.id} fallback={<p role="status">Loading cloud task…</p>}>
      <HostedTaskControls item={item} onChanged={service.refresh} disabled={busy} />
    </Suspense>)}
    {lastLive ? <p className="conversation-work-receipt" role="status">Live guidance: {lastLive.delivery === "accepted" ? "accepted by Codex" : lastLive.delivery === "rejected" ? "not accepted; review the paused request" : lastLive.delivery === "uncertain" ? "delivery uncertain; review before continuing" : "waiting for receipt"}.</p> : null}
    {error ? <p className="conversation-work-error" role="alert">{error}</p> : null}
  </section>;
}
