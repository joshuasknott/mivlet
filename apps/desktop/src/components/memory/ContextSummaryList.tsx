import { useId } from "react";
import type { ContextSummaryRecord } from "@fable/protocol";

/**
 * Reusable, presentational Memory control for durable derived conversation
 * summaries. It never fetches or mutates by itself: P3/P4/P5 pass records from
 * the shared runtime and route any action through their own callbacks. Derived
 * text is shown as prior evidence and stale summaries are excluded, matching
 * the context boundary that decides what may enter a model turn.
 */
export interface ContextSummaryListProps {
  summaries: readonly ContextSummaryRecord[];
  /** Optional narrower action: forget a memory that a summary was derived from. */
  onForgetMemory?: (memoryId: string) => void;
  emptyLabel?: string;
}

function coverageLabel(summary: ContextSummaryRecord): string {
  if (summary.fromSequence === summary.throughSequence) {
    return `message ${summary.fromSequence}`;
  }
  return `messages ${summary.fromSequence}–${summary.throughSequence}`;
}

export function ContextSummaryList({
  summaries,
  onForgetMemory,
  emptyLabel = "No compacted conversation history yet.",
}: ContextSummaryListProps) {
  const headingId = useId();
  const live = summaries.filter((summary) => !summary.staleAt);
  return (
    <section className="context-summary-list" aria-labelledby={headingId}>
      <h4 id={headingId}>Derived conversation summaries</h4>
      {live.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <ul>
          {live.map((summary) => (
            <li key={summary.id}>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {summary.text}
              </p>
              <small>
                {coverageLabel(summary)} · revision {summary.revision} · updated{" "}
                {summary.updatedAt}
              </small>
              {summary.derivedMemoryIds.length > 0 ? (
                <div className="profile-action-row">
                  {summary.derivedMemoryIds.map((memoryId) =>
                    onForgetMemory ? (
                      <button
                        key={memoryId}
                        className="button button--secondary"
                        type="button"
                        onClick={() => onForgetMemory(memoryId)}
                      >
                        Forget memory {memoryId}
                      </button>
                    ) : (
                      <small key={memoryId}>Derived from memory {memoryId}</small>
                    ),
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
