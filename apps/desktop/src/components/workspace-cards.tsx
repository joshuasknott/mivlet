import { useState } from "react";
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

export function ParallelMissionPlanSummary({ plan }: { plan: {
  title: string; summary: string; executionLabel: string;
  steps: Array<{ title: string; objective: string; output: string }>;
  acceptance: string[];
  budget: { maxWorkers: number; maxDurationMs: number; maxOutputTokens: number; maxAttempts: number };
} }) {
  return (
    <details className="run-context-summary run-context-summary--plan" aria-label="Parallel mission plan">
      <summary><strong>Plan</strong><span>{plan.executionLabel}</span></summary>
      <p className="run-context-summary__audience"><strong>Goal</strong><span>{plan.title}</span></p>
      <p className="run-context-summary__audience"><strong>Request</strong><span>{plan.summary}</span></p>
      <ol className="run-context-summary__sources" aria-label="Parallel plan steps">
        {plan.steps.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <span>{step.objective}</span>
            <p>Produces: {step.output}</p>
          </li>
        ))}
      </ol>
      <ul className="run-context-summary__reasons" aria-label="Parallel plan acceptance and limits">
        {plan.acceptance.map((criterion) => <li key={criterion}>Accepted when: {criterion}</li>)}
        <li>{plan.budget.maxWorkers} workers total</li>
        <li>{plan.budget.maxOutputTokens} output tokens per worker</li>
        <li>Up to {Math.round(plan.budget.maxDurationMs / 1000)} seconds per worker</li>
        <li>{plan.budget.maxAttempts} attempt per worker</li>
      </ul>
    </details>
  );
}

export function MissionProgressSummary({
  progress,
  reviewBusyCriterion,
  reviewError,
  onReview
}: {
  progress: import("../runtime").RuntimeMissionProgress;
  reviewBusyCriterion?: string;
  reviewError?: string;
  onReview?: (criterionKey: string, passed: boolean) => void;
}) {
  const stateLabel = progress.state === "complete"
    ? "Finished"
    : progress.state === "cancelled"
      ? "Stopped"
      : progress.state === "blocked"
        ? "Needs attention"
        : progress.state === "running"
          ? "In progress"
          : progress.state === "ready"
            ? "Ready"
            : "Waiting";
  return (
    <details className="run-context-summary" aria-label="Mission progress">
      <summary>
        <strong>Plan &amp; progress</strong>
        <span>{progress.completedSteps} of {progress.totalSteps} steps · {stateLabel}</span>
      </summary>
      {progress.plan ? (
        <>
          <p className="run-context-summary__audience">
            <strong>Goal</strong><span>{progress.plan.title}</span>
          </p>
          <p className="run-context-summary__audience">
            <strong>Outcome</strong><span>{progress.plan.desiredOutcome}</span>
          </p>
          <p className="run-context-summary__audience">
            <strong>Approach</strong><span>{progress.plan.summary}</span>
          </p>
        </>
      ) : null}
      <p className="run-context-summary__audience">
        <strong>Status</strong><span>{progress.summary}</span>
      </p>
      <ol className="run-context-summary__sources" aria-label="Mission step progress">
        {progress.steps.map((step) => (
          <li key={step.stepKey}>
            <strong>{step.title}</strong>
            <span>{missionStepStateLabel(step.state)}</span>
            {step.objective ? <p>{step.objective}</p> : null}
            {step.dependsOnStepKeys?.length ? (
              <p>
                After {step.dependsOnStepKeys.length} earlier {step.dependsOnStepKeys.length === 1 ? "step" : "steps"}
              </p>
            ) : null}
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
      <ul className="run-context-summary__reasons" aria-label="Mission usage and acceptance">
        <li>{progress.usage.inputTokens + progress.usage.outputTokens} tokens observed</li>
        <li>{progress.usage.toolCalls} connected {progress.usage.toolCalls === 1 ? "action" : "actions"}</li>
        <li>{Math.round(progress.usage.durationMs / 1000)} seconds of provider time</li>
        {progress.acceptance.map((criterion) => (
          <li key={criterion.criterionKey}>
            {criterion.status === "met" ? "Met" : criterion.status === "not-met" ? "Not met" : criterion.status === "partially-met" ? "Partly met" : "Not evaluated"}: {criterion.description}
          </li>
        ))}
        <li>{progress.nextAction}</li>
      </ul>
      {progress.humanReview?.criteria.length && onReview ? (
        <section className="mission-approval-card" aria-label="Mission acceptance review">
          <div>
            <strong>Review the result</strong>
            <p>Only your decision can settle these acceptance checks. Fable records it against the exact durable result.</p>
          </div>
          {progress.humanReview.criteria.map((criterion) => {
            const busy = reviewBusyCriterion === criterion.criterionKey;
            return (
              <div key={criterion.criterionKey}>
                <p><strong>{criterion.description}</strong></p>
                <div className="mission-approval-card__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={Boolean(reviewBusyCriterion)}
                    onClick={() => onReview(criterion.criterionKey, true)}
                  >
                    {busy ? "Saving decision…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={Boolean(reviewBusyCriterion)}
                    onClick={() => onReview(criterion.criterionKey, false)}
                  >
                    Needs revision
                  </button>
                </div>
              </div>
            );
          })}
          {reviewError ? <p role="alert" className="mission-approval-card__error">{reviewError}</p> : null}
        </section>
      ) : null}
    </details>
  );
}

function missionStepStateLabel(state: import("../runtime").RuntimeMissionProgress["steps"][number]["state"]) {
  if (state === "completed") return "Complete";
  if (state === "partial") return "Partial";
  if (state === "blocked") return "Needs attention";
  if (state === "cancelled") return "Stopped";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function MissionPlanUnavailable() {
  return (
    <p className="run-context-summary__audience" aria-label="Mission plan unavailable">
      <strong>Plan</strong><span>Unavailable</span>
    </p>
  );
}

export function CitedApprovalCard({
  requestedAt,
  busy,
  error,
  onApprove,
  onKeepDraft
}: {
  requestedAt: string;
  busy: boolean;
  error?: string;
  onApprove: () => void;
  onKeepDraft: () => void;
}) {
  return (
    <section className="mission-approval-card" aria-label="Cited brief approval">
      <div>
        <strong>Ready for your approval</strong>
        <p>Policy checks passed. No artifact has been created yet.</p>
      </div>
      <div className="mission-approval-card__actions">
        <button type="button" className="button button--primary" disabled={busy} onClick={onApprove}>
          {busy ? "Saving…" : "Approve and save"}
        </button>
        <button type="button" className="button button--secondary" disabled={busy} onClick={onKeepDraft}>
          Keep as draft
        </button>
      </div>
      <small>Requested {new Date(requestedAt).toLocaleString()}</small>
      {error ? <p role="alert" className="mission-approval-card__error">{error}</p> : null}
    </section>
  );
}

export function MissionEffectApprovalCard({
  actionSummary,
  targetSummary,
  requestedAt,
  busy,
  error,
  onApprove,
  onDeny
}: {
  actionSummary: string;
  targetSummary: string;
  requestedAt: string;
  busy: boolean;
  error?: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <section className="mission-approval-card" aria-label="Mission action approval">
      <div>
        <strong>Review this action</strong>
        <p>{actionSummary}</p>
        <p><span className="sr-only">Target: </span>{targetSummary}</p>
        <p>Approval lets the mission continue. Fable will recheck this exact action before it can run.</p>
      </div>
      <div className="mission-approval-card__actions">
        <button type="button" className="button button--primary" disabled={busy} onClick={onApprove}>
          {busy ? "Saving decision..." : "Approve action"}
        </button>
        <button type="button" className="button button--secondary" disabled={busy} onClick={onDeny}>
          Don't approve
        </button>
      </div>
      <small>Requested {new Date(requestedAt).toLocaleString()}</small>
      {error ? <p role="alert" className="mission-approval-card__error">{error}</p> : null}
    </section>
  );
}

export type MissionHumanInputField = {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "number" | "boolean" | "choice" | "date-time" | "artifact";
  required: boolean;
  sensitive: false;
  choices?: string[];
};

export type MissionHumanInputValue = {
  fieldKey: string;
  value: string | number | boolean | { artifactId: string; artifactVersionId: string } | null;
};

export type MissionHumanInputArtifactOption = {
  artifactId: string;
  artifactVersionId: string;
  label: string;
  versionLabel: string;
};

export function MissionHumanInputCard({
  prompt,
  fields,
  requestedAt,
  busy,
  error,
  artifactOptions = [],
  artifactOptionsLoading = false,
  artifactOptionsError,
  onSubmit
}: {
  prompt: string;
  fields: MissionHumanInputField[];
  requestedAt: string;
  busy: boolean;
  error?: string;
  artifactOptions?: MissionHumanInputArtifactOption[];
  artifactOptionsLoading?: boolean;
  artifactOptionsError?: string;
  onSubmit: (values: MissionHumanInputValue[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.kind === "boolean" ? false : ""])) as Record<string, string | boolean>);
  const update = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const submit = () => {
    const supplied = fields.flatMap<MissionHumanInputValue>((field) => {
      const raw = values[field.key];
      if (field.kind === "boolean") {
        if (!field.required && raw !== true) return [];
        return [{ fieldKey: field.key, value: raw === true }];
      }
      const text = typeof raw === "string" ? raw : "";
      if (!field.required && text.length === 0) return [];
      if (field.kind === "artifact") {
        const selected = artifactOptions[Number(text)];
        return selected ? [{ fieldKey: field.key, value: {
          artifactId: selected.artifactId,
          artifactVersionId: selected.artifactVersionId
        } }] : [];
      }
      if (field.kind === "number") return [{ fieldKey: field.key, value: Number(text) }];
      if (field.kind === "date-time") return [{ fieldKey: field.key, value: new Date(text).toISOString() }];
      return [{ fieldKey: field.key, value: text }];
    });
    onSubmit(supplied);
  };

  return (
    <form className="mission-human-input-card" aria-label="Mission needs input" onSubmit={(event) => {
      event.preventDefault();
      submit();
    }}>
      <div className="mission-human-input-card__header">
        <strong>Mission needs your input</strong>
        <p>{prompt}</p>
      </div>
      <div className="mission-human-input-card__fields">
        {fields.map((field) => {
          const helpId = field.help ? `mission-input-${field.key}-help` : undefined;
          if (field.kind === "boolean") {
            return (
              <label key={field.key} className="mission-human-input-card__check">
                <input
                  type="checkbox"
                  checked={values[field.key] === true}
                  disabled={busy}
                  onChange={(event) => update(field.key, event.target.checked)}
                />
                <span><strong>{field.label}</strong>{field.help ? <small>{field.help}</small> : null}</span>
              </label>
            );
          }
          return (
            <label key={field.key}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              {field.kind === "choice" || field.kind === "artifact" ? (
                <select
                  value={String(values[field.key] ?? "")}
                  required={field.required}
                  disabled={busy || (field.kind === "artifact" && (artifactOptionsLoading || artifactOptions.length === 0))}
                  aria-describedby={helpId}
                  onChange={(event) => update(field.key, event.target.value)}
                >
                  <option value="">{field.kind === "artifact"
                    ? artifactOptionsLoading ? "Loading artifacts..." : artifactOptions.length === 0 ? "No artifacts available" : "Select an artifact"
                    : "Select an option"}</option>
                  {field.kind === "artifact"
                    ? artifactOptions.map((option, index) => (
                      <option key={`${option.artifactId}:${option.artifactVersionId}`} value={String(index)}>
                        {option.label} · {option.versionLabel}
                      </option>
                    ))
                    : field.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              ) : (
                <input
                  type={field.kind === "number" ? "number" : field.kind === "date-time" ? "datetime-local" : "text"}
                  value={String(values[field.key] ?? "")}
                  required={field.required}
                  disabled={busy}
                  step={field.kind === "number" ? "any" : field.kind === "date-time" ? "1" : undefined}
                  aria-describedby={helpId}
                  onChange={(event) => update(field.key, event.target.value)}
                />
              )}
              {field.help ? <small id={helpId}>{field.help}</small> : null}
            </label>
          );
        })}
      </div>
      <div className="mission-human-input-card__footer">
        <small>Requested {new Date(requestedAt).toLocaleString()}</small>
        <button type="submit" className="button button--primary" disabled={busy || fields.some((field) => field.kind === "artifact" && field.required && artifactOptions.length === 0)} aria-busy={busy || undefined}>
          {busy ? "Continuing..." : "Continue mission"}
        </button>
      </div>
      {artifactOptionsError ? <p role="alert" className="mission-human-input-card__error">{artifactOptionsError}</p> : null}
      {error ? <p role="alert" className="mission-human-input-card__error">{error}</p> : null}
    </form>
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
