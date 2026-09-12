import type { CollaborationWorkItem } from "@fable/protocol";
import {
  activeWork,
  type WorkspaceExecution,
} from "../../lib/workspace-execution";

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
              <span className="team-work-status">
                {item.status.replaceAll("-", " ")}
              </span>
            </header>
            <p>
              {item.prompt.slice(0, 220)}
              {item.prompt.length > 220 ? "…" : ""}
            </p>
            {item.reason ? (
              <p className="team-work-reason">{item.reason}</p>
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
                <details>
                  <summary>Continue…</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void service
                        .command({
                          action: "continue-work",
                          id: item.id,
                          expectedGeneration: item.generation,
                          reconcile: true,
                        })
                        .catch((error) => service.report(error));
                    }}
                  >
                    <p>
                      Read saved results and check any uncertain external
                      actions first. Continuing starts a fresh attempt with
                      current context and approvals.
                    </p>
                    <label>
                      <input type="checkbox" required /> I have checked the
                      previous outcome
                    </label>
                    <button type="submit">Continue with current model</button>
                  </form>
                </details>
              ) : null}
            </div>
          </li>
        ))}
    </ol>
  );
}
