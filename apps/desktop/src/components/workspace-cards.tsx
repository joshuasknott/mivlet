import type { KnowledgeCitation, ThreadSummary, WorkspaceDirective } from "@arden/protocol";

/**
 * Composer-adjacent presentational components: directive prompt starters,
 * citation results, and the active thread context strip.
 */

export function DirectiveCards({
  directives,
  onUseDirective
}: {
  directives: WorkspaceDirective[];
  onUseDirective: (directive: WorkspaceDirective) => void;
}) {
  return (
    <section className="directives" aria-label="Workspace directives">
      {directives.map((directive) => (
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
        </button>
      ))}
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
