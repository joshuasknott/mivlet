import type { CollaborationWorkItem } from "@mivlet/protocol";
import "./conversation-recap.css";

/** An extract of saved public outcomes, never an invented/model-generated recap. */
export function ConversationRecap({
  work,
  onInspect,
}: {
  work: CollaborationWorkItem[];
  onInspect?: (id: string) => void;
}) {
  const roots = work.filter((item) => !item.parentId);
  if (roots.length < 5) return null;
  const results = [...roots]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((item) => item.outputs.length)
    .slice(0, 3);
  const unresolved = roots
    .filter((item) =>
      ["awaiting-user", "awaiting-approval", "blocked", "failed"].includes(
        item.status,
      ),
    )
    .slice(-5);
  return (
    <details className="conversation-recap">
      <summary>Where this conversation left off</summary>
      <p>
        From saved public results and unresolved work. External outcomes may
        still need verification.
      </p>
      {results.length ? (
        <ul>
          {results.map((item) => (
            <li key={item.id}>
              <strong>{item.agentName}</strong>
              <p>
                {item.outputs.at(-1)!.text.slice(0, 280)}
                {item.outputs.at(-1)!.text.length > 280 ? "…" : ""}
              </p>
              {onInspect ? (
                <button type="button" onClick={() => onInspect(item.id)}>
                  Inspect saved result
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {unresolved.length ? (
        <>
          <strong>Needs attention</strong>
          <ul>
            {unresolved.map((item) => (
              <li key={item.id}>
                {item.agentName}: {item.reason || item.prompt.slice(0, 200)}
                {onInspect ? (
                  <button type="button" onClick={() => onInspect(item.id)}>
                    Review
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
