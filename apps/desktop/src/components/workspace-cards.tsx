import type {
  ConnectorManifest,
  KnowledgeCitation,
  RunContextReceipt,
  ThreadSummary,
  WorkspaceDirective
} from "@fable/protocol";

export function citationsForRun(
  runId: string,
  receipts: Readonly<Record<string, RunContextReceipt>>
) {
  return receipts[runId]?.citations ?? [];
}

const CONTEXT_REASON_LABELS = {
  "system-instruction": "Instructions",
  conversation: "Conversation",
  "project-context": "Project context",
  pinned: "Pinned context",
  "memory-approved": "Approved memory",
  "memory-pinned": "Pinned memory",
  retrieved: "Retrieved source",
  "tool-result": "Tool result"
} as const;

/** Concise evidence labels only; never hidden reasoning or model chain-of-thought. */
export function RunContextSummary({ receipt }: { receipt: RunContextReceipt }) {
  const counts = new Map<string, number>();
  for (const contribution of receipt.contributions) {
    const label = CONTEXT_REASON_LABELS[contribution.reason];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0 && receipt.citations.length === 0) return null;
  return (
    <details className="run-context-summary" aria-label="Context used">
      <summary>
        <strong>Context used</strong>
        <span>
          {receipt.citations.length > 0
            ? `${receipt.citations.length} ${receipt.citations.length === 1 ? "source" : "sources"}`
            : "Memory and context"}
        </span>
      </summary>
      <ul className="run-context-summary__reasons" aria-label="Context reasons">
        {[...counts].map(([label, count]) => (
          <li key={label}>{label}{count > 1 ? ` (${count})` : ""}</li>
        ))}
      </ul>
      {receipt.citations.length > 0 ? (
        <ul className="run-context-summary__sources" aria-label="Response sources">
          {receipt.citations.map((citation) => {
            const contribution = receipt.contributions.find((entry) =>
              entry.citationId === (citation.chunkId ?? citation.sourceId) || entry.id === citation.sourceId
            );
            const reason = contribution ? CONTEXT_REASON_LABELS[contribution.reason] : "Retrieved source";
            return (
              <li key={`${citation.sourceId}:${citation.chunkId ?? "source"}`}>
                <strong>{citation.title}</strong>
                <span>{citation.provenance} - {citation.freshness} - {reason}</span>
                <p>{citation.snippet}</p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </details>
  );
}

/**
 * Composer-adjacent presentational components: directive prompt starters,
 * citation results, and the active thread context strip.
 *
 * Directive cards are Google AI Studio-style curved chips: a short task title
 * with a trailing connector (plugin) pill so each starter advertises the tool
 * it will use.
 */

export function DirectiveCards({
  directives,
  connectors,
  onUseDirective
}: {
  directives: WorkspaceDirective[];
  connectors: ConnectorManifest[];
  onUseDirective: (directive: WorkspaceDirective) => void;
}) {
  const connectorName = (id: string) =>
    connectors.find((connector) => connector.id === id)?.name ?? id;

  return (
    <section className="directives" aria-label="Workspace directives">
      {directives.map((directive) => {
        const primary = connectorName(directive.connectorIds[0]);
        return (
          <button
            className="directive-card"
            key={directive.id}
            type="button"
            onClick={() => onUseDirective(directive)}
          >
            <span className="directive-copy">
              <strong>{directive.label}</strong>
              <small>{directive.source}</small>
            </span>
            <span className="directive-pill" aria-label={`Uses ${primary}`}>
              {primary}
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function CitationResults({
  citations,
  mode
}: {
  citations: KnowledgeCitation[];
  mode: string;
}) {
  if (citations.length === 0) {
    return null;
  }

  return (
    <section className="citation-results" aria-label="Composer citations">
      <div className="citation-results__top">
        <strong>Sources used</strong>
        <span>{mode}</span>
      </div>
      <div className="citation-list">
        {citations.map((citation) => (
          <article className="citation-card" key={citation.sourceId}>
            <div>
              <strong>{citation.title}</strong>
              <small>
                {citation.provenance} - {citation.freshness} - {citation.trust}
              </small>
            </div>
            <p>{citation.snippet}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ThreadContext({ thread }: { thread?: ThreadSummary }) {
  if (!thread) {
    return null;
  }

  return (
    <section className="thread-context" aria-label="Selected thread context">
      <span>{thread.kind === "project" ? "Project thread" : "Chat"}</span>
      <strong>{thread.title}</strong>
      <p>{thread.description}</p>
      <small>{thread.updatedAt}</small>
    </section>
  );
}
