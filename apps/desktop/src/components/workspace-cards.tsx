import type {
  ConnectorManifest,
  KnowledgeCitation,
  PersistedAgentRun,
  ProviderRouteExecutionBinding,
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

export function runContextAudienceLabel(receipt: RunContextReceipt): string {
  if (receipt.version === 1) return "Audience not recorded";
  return receipt.audience.visibility === "member-private" ? "Only you" : "Workspace";
}

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
      <p className="run-context-summary__audience">
        <strong>Audience</strong>
        <span>{runContextAudienceLabel(receipt)}</span>
      </p>
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

export function MissionRunReceipt({ receipt }: { receipt: {
  acceptanceStatus: "accepted" | "not-accepted"; acceptanceSummary: string;
  provider: string; model: string; routeReason: string; inputTokens: number;
  outputTokens: number; toolCalls: number; durationMs: number; attemptNumber: number; sourceCount: number; trust: string;
  maxInputTokens: number; maxOutputTokens: number; maxToolCalls: number; maxDurationMs: number; maxAttempts: number;
  costAmount?: string; costCurrency?: string; pricingReference?: string;
} }) {
  const provider = receipt.provider === "openai" ? "OpenAI" : receipt.provider;
  const reviewed = receipt.pricingReference?.match(/(?:^|\|)reviewed=(\d{4})-(\d{2})-(\d{2})(?:\||$)/);
  const pricingLabel = reviewed
    ? `Standard API list price · reviewed ${Number(reviewed[3])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(reviewed[2]) - 1]} ${reviewed[1]}`
    : "Source-attributed API price";
  const providerSeconds = (receipt.durationMs / 1000).toFixed(receipt.durationMs % 1000 === 0 ? 0 : 1);
  return (
    <details className="run-context-summary" aria-label="Run receipt">
      <summary><strong>Run receipt</strong><span>{provider} · {receipt.inputTokens + receipt.outputTokens} tokens</span></summary>
      <p className="run-context-summary__audience"><strong>Route</strong><span>{receipt.routeReason}</span></p>
      <ul className="run-context-summary__reasons" aria-label="Run facts">
        <li>{receipt.acceptanceStatus === "accepted" ? "Policy acceptance met" : "Policy acceptance not met"}</li>
        <li>{receipt.acceptanceSummary}</li>
        <li>{receipt.model}</li>
        <li>{receipt.inputTokens} / {receipt.maxInputTokens} input tokens</li>
        <li>{receipt.outputTokens} / {receipt.maxOutputTokens} output tokens</li>
        <li>{receipt.toolCalls} / {receipt.maxToolCalls} read {receipt.maxToolCalls === 1 ? "action" : "actions"}</li>
        <li>Provider time {providerSeconds}s / {Math.round(receipt.maxDurationMs / 1000)}s · attempt {receipt.attemptNumber} / {receipt.maxAttempts}</li>
        <li>{receipt.costAmount && receipt.costCurrency ? `${receipt.costCurrency} ${receipt.costAmount}` : "Cost unavailable"}</li>
        {receipt.pricingReference ? <li>{pricingLabel}</li> : null}
        <li>{receipt.sourceCount} cited {receipt.sourceCount === 1 ? "source" : "sources"}</li>
        <li>{receipt.trust === "provider-generated-with-external-evidence" ? "External evidence kept untrusted" : receipt.trust}</li>
      </ul>
    </details>
  );
}

export function MissionPlanSummary({ plan }: { plan: {
  title: string; summary: string; executionLabel: string;
  step: { title: string; objective: string; capability: string; output: string };
  acceptance: string[];
  budget: { maxInputTokens: number; maxOutputTokens: number; maxToolCalls: number; maxDurationMs: number; maxAttempts: number };
} }) {
  return (
    <details className="run-context-summary run-context-summary--plan" aria-label="Mission plan">
      <summary><strong>Plan</strong><span>{plan.executionLabel}</span></summary>
      <p className="run-context-summary__audience"><strong>Goal</strong><span>{plan.title}</span></p>
      <p className="run-context-summary__audience"><strong>Question</strong><span>{plan.summary}</span></p>
      <ol className="run-context-summary__sources" aria-label="Plan steps">
        <li>
          <strong>{plan.step.title}</strong>
          <span>{plan.step.objective}</span>
          <p>Uses: {plan.step.capability}</p>
          <p>Produces: {plan.step.output}</p>
        </li>
      </ol>
      <ul className="run-context-summary__reasons" aria-label="Plan acceptance and limits">
        {plan.acceptance.map((criterion) => <li key={criterion}>Accepted when: {criterion}</li>)}
        <li>{plan.budget.maxInputTokens} input tokens</li>
        <li>{plan.budget.maxOutputTokens} output tokens</li>
        <li>{plan.budget.maxToolCalls} read action</li>
        <li>Up to {Math.round(plan.budget.maxDurationMs / 1000)} seconds</li>
        <li>{plan.budget.maxAttempts} attempts including restart recovery</li>
      </ul>
    </details>
  );
}

export function MissionPlanUnavailable() {
  return (
    <p className="run-context-summary__audience" aria-label="Mission plan unavailable">
      <strong>Plan</strong><span>Unavailable</span>
    </p>
  );
}

export function NewCitedMissionAction({
  disabled,
  starting,
  onStart
}: {
  disabled: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <div className="mission-new-run" aria-label="New mission option">
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        aria-busy={starting || undefined}
        onClick={onStart}
      >
        {starting ? "Starting new mission..." : "Run again as a new mission"}
      </button>
      <span>Starts fresh with the current scope, provider route, access, and approvals.</span>
    </div>
  );
}

type AgentRunUsage = NonNullable<PersistedAgentRun["usage"]>;

function observedCost(usage: AgentRunUsage): string {
  if (usage.costUnknown) return "Unknown";
  return `$${usage.costUsd.toFixed(6)}${usage.costEstimated ? " estimated" : ""}`;
}

function costCeiling(route: ProviderRouteExecutionBinding): string | null {
  const cost = route.selection.cost;
  if (!cost) return null;
  return `${cost.currencyCode} ${(cost.estimatedCostMinorUnits / 100).toFixed(2)}`;
}

export function ProviderRouteSummary({
  route,
  usage
}: {
  route: ProviderRouteExecutionBinding;
  usage?: AgentRunUsage;
}) {
  const cost = route.selection.cost;
  return (
    <details className="run-context-summary" aria-label="Route receipt">
      <summary><strong>Route</strong><span>Checked before connecting</span></summary>
      <p className="run-context-summary__audience"><strong>Why</strong><span>{route.selection.reason}</span></p>
      <p className="run-context-summary__audience"><strong>Scope</strong><span>This workspace</span></p>
      {cost ? (
        <>
          <p className="run-context-summary__audience">
            <strong>Token ceiling</strong>
            <span>{cost.estimatedInputTokens} input estimate · {cost.estimatedOutputTokens} output max</span>
          </p>
          <p className="run-context-summary__audience">
            <strong>Cost ceiling</strong>
            <span>{costCeiling(route)} estimated maximum</span>
          </p>
        </>
      ) : (
        <p className="run-context-summary__audience"><strong>Cost ceiling</strong><span>Unknown for this model</span></p>
      )}
      {usage ? (
        <>
          <p className="run-context-summary__audience">
            <strong>Used</strong>
            <span>{usage.inputTokens} input · {usage.outputTokens} output</span>
          </p>
          <p className="run-context-summary__audience"><strong>Cost</strong><span>{observedCost(usage)}</span></p>
        </>
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
