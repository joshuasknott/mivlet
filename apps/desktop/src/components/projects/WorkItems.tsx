import type { CollaborationWorkItem } from "@fable/protocol";
import { useState } from "react";
import { CopyButton } from "../CopyButton";
import {
  activeWork,
  type WorkspaceExecution,
} from "../../lib/workspace-execution";
import { WorkStatusBadge } from "../work/WorkStatusBadge";

export function WorkItems({
  work,
  service,
  onOpen,
}: {
  work: CollaborationWorkItem[];
  service: WorkspaceExecution;
  onOpen: (id: string) => void;
}) {
  if (!work.length)
    return (
      <p className="team-empty">
        Assignments and their results appear here when work starts.
      </p>
    );
  return (
    <ol className="team-work-list">
      {[...work]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 60)
        .map((item) => (
          <li
            key={item.id}
            className="team-work-item"
            data-status={item.status}
          >
            <header>
              <span>
                <strong>{item.agentName}</strong>
                <small>{item.parentId ? "Assignment" : "Request"}</small>
              </span>
              <WorkStatusBadge status={item.status} origin={item.origin} />
            </header>
            <WorkPrompt prompt={item.userRequest || item.prompt} />
            {item.reason ? (
              <p className="team-work-reason">{item.reason}</p>
            ) : null}
            {item.attachments?.length ? (
              <small className="team-work-attachments">
                {item.attachments.length} attached file
                {item.attachments.length === 1 ? "" : "s"}
                {item.attachments.some(
                  (ref) =>
                    ref.availability === "transient" ||
                    ref.availability === "image-input",
                )
                  ? " · in-memory inputs need reattaching after a restart"
                  : ""}
              </small>
            ) : null}
            {!item.parentId ? (
              <small>
                {item.turnCount} / {item.maxTurns} execution turns ·{" "}
                {item.tokenUsage.toLocaleString()} /{" "}
                {item.maxTokens.toLocaleString()} reported tokens
              </small>
            ) : null}
            {item.prerequisites.length ? (
              <small>
                Needs:{" "}
                {item.prerequisites
                  .map(
                    (id) =>
                      work.find((work) => work.id === id)?.agentName ?? id,
                  )
                  .join(", ")}
              </small>
            ) : null}
            {item.waitingFor.length && item.status === "waiting" ? (
              <small>
                Waiting for{" "}
                {item.waitingFor
                  .map(
                    (id) =>
                      work.find((work) => work.id === id)?.agentName ??
                      "a teammate",
                  )
                  .join(", ")}
              </small>
            ) : null}
            {item.outputs.length ? (
              <details>
                <summary>
                  {item.outputs.length} saved result
                  {item.outputs.length === 1 ? "" : "s"}
                </summary>
                {item.outputs.map((output) => (
                  <div key={output.runId}>
                    <p className="team-work-output">{output.text}</p>
                    <small>
                      Agent report ·{" "}
                      {new Date(output.createdAt).toLocaleString()}. External
                      outcomes require their own evidence.
                    </small>
                    <button
                      type="button"
                      onClick={() => onOpen(output.conversationId)}
                    >
                      Open result conversation
                    </button>
                  </div>
                ))}
              </details>
            ) : null}
            <div className="team-work-actions">
              <button type="button" onClick={() => onOpen(item.conversationId)}>
                Open conversation
              </button>
              {activeWork(item) ? (
                <button
                  type="button"
                  onClick={() =>
                    void service
                      .stop(item.id)
                      .catch((error) => service.report(error))
                  }
                >
                  Stop
                </button>
              ) : item.status !== "completed" ? (
                <WorkRecovery item={item} service={service} />
              ) : null}
              {item.status !== "completed" ? (
                <WorkSteer item={item} service={service} />
              ) : null}
            </div>
          </li>
        ))}
    </ol>
  );
}

function WorkPrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="team-work-prompt">
    <p>{expanded || prompt.length <= 220 ? prompt : `${prompt.slice(0, 220)}…`}</p>
    {prompt.length > 220 ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show full request"}</button> : null}
    <CopyButton text={prompt} label="Copy request" />
  </div>;
}

export function WorkRecovery({ item, service }: { item: CollaborationWorkItem; service: WorkspaceExecution }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const unstarted = item.runIds.length === 0 && item.turnCount === 0 && item.outputs.length === 0;
  const resume = async () => {
    if (pending) return;
    setPending(true); setError("");
    try {
      await service.command({ action: "continue-work", id: item.id, expectedGeneration: item.generation, reconcile: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not continue this request.");
    } finally { setPending(false); }
  };
  return <details className="work-recovery">
    <summary>{unstarted ? "Retry request…" : "Continue…"}</summary>
    <form onSubmit={(event) => { event.preventDefault(); if (event.currentTarget.checkValidity()) void resume(); }}>
      <p>{unstarted
        ? "No provider attempt started. Retry uses the current model and approvals. If Mivlet has restarted, restore the request and reattach its files before sending."
        : "Review saved results and any uncertain external actions first. Continuing starts a fresh attempt with current context and approvals."}</p>
      {!unstarted ? <label><input type="checkbox" required /> I have checked the previous outcome</label> : null}
      <button type="submit" disabled={pending}>{pending ? "Starting…" : unstarted ? "Retry with current model" : "Continue with current model"}</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  </details>;
}

/** Deliberate steering records an instruction at a safe native boundary.
 * Steering after provider activity moves Work to needs-review; nothing replays. */
export function WorkSteer({ item, service }: { item: CollaborationWorkItem; service: WorkspaceExecution }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const apply = async () => {
    const instruction = text.trim();
    if (pending || !instruction) return;
    setPending(true); setError("");
    try {
      await service.steer(item.id, item.generation, instruction);
      setText(""); setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not apply steering.");
    } finally { setPending(false); }
  };
  return <details className="work-recovery" open={open}>
    <summary onClick={(event) => { if (open) return; event.preventDefault(); setOpen(true); }}>
      Steer request…
    </summary>
    <form onSubmit={(event) => { event.preventDefault(); void apply(); }}>
      <p>Steering records a deliberate update applied at a safe boundary. If provider activity already started, the request moves to needs review before it continues; no external effect is replayed.</p>
      <label><textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} placeholder="Adjust the request…" /></label>
      <button type="submit" disabled={pending || !text.trim()}>{pending ? "Applying…" : "Apply steering"}</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  </details>;
}
