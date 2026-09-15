/**
 * Interactive long-context compaction.
 *
 * When a turn's terminal history would exceed the provider's model context (or
 * the Codex native history envelope), Mivlet folds only the newly elided range
 * into durable incremental summaries and retries with a bounded request:
 * recent verbatim turns + derived summary + query-scoped retrieval excerpts.
 *
 * Invariants:
 * - Raw transcript records are never deleted or rewritten.
 * - A summary is persisted through the native account store BEFORE the bounded
 *   request is attempted; a persistence failure fails the turn closed instead
 *   of silently sending an unbounded request.
 * - Summarisation is deterministic and local. No provider is called and no
 *   credential or transcript leaves the native/account boundary here.
 * - Derived/retrieved text is labelled untrusted prior evidence in the prefix;
 *   it can never become user authority, approval, or tool permission.
 */

import type {
  AgentTurnRequest,
  ContextSummaryRecord,
  KnowledgeScope
} from "@mivlet/protocol";
import {
  foldHistorySummary,
  planBoundedHistory,
  summariesForThread,
  type BoundedHistoryBudget,
  type HistoryEntry
} from "@mivlet/knowledge";
import { parseComputerArtifact } from "./computer-artifacts";
import type { ConversationMessageView } from "./conversation-runtime";
import {
  planConversationContext,
  type ConversationContextFailure,
  type ConversationContextPlan
} from "./conversation-context";

/**
 * Explicit composition budgets for a compacted turn. Token-window enforcement
 * stays with `planConversationContext`, which receives exactly this bounded
 * message list; these character budgets only split the available history.
 */
const COMPACTED_CONTEXT_BUDGET: BoundedHistoryBudget = {
  maxRecentTurns: 24,
  maxRecentCharacters: 48_000,
  maxSummaryCharacters: 12_000,
  maxRetrievalCharacters: 6_000
};

/** A tighter retry derived from the base budget when the first split misses. */
function retryContextBudget(
  base: BoundedHistoryBudget
): BoundedHistoryBudget {
  return {
    maxRecentTurns: Math.max(1, Math.floor(base.maxRecentTurns / 3)),
    maxRecentCharacters: Math.max(
      1_000,
      Math.floor(base.maxRecentCharacters / 3)
    ),
    maxSummaryCharacters: base.maxSummaryCharacters,
    maxRetrievalCharacters: Math.max(
      500,
      Math.floor(base.maxRetrievalCharacters / 2)
    )
  };
}

export interface CompactionDependencies {
  listSummaries(
    threadId: string
  ): Promise<ContextSummaryRecord[] | null>;
  saveSummary(
    record: ContextSummaryRecord
  ): Promise<ContextSummaryRecord | null>;
}

export interface CompactConversationTurnInput {
  threadId: string;
  /** Exact scope asserted for the summary; defaults to the thread itself. */
  scope?: KnowledgeScope;
  history: readonly HistoryEntry[];
  request: AgentTurnRequest;
  contextPrefix?: string;
  contextWindowTokens?: number;
  backendType: string;
  dependencies: CompactionDependencies;
  budget?: BoundedHistoryBudget;
  now?: string;
}

type CompactionFailureCode =
  | "compaction-unavailable"
  | "nothing-to-elide"
  | "compaction-persist-failed"
  | "still-too-large";

export type CompactConversationResult =
  | {
      ok: true;
      plan: Extract<ConversationContextPlan, { ok: true }>;
      summary?: ContextSummaryRecord;
      prefix: string;
    }
  | {
      ok: false;
      code: CompactionFailureCode;
      message: string;
      failure?: ConversationContextFailure;
    };

/**
 * Rebuild the exact replay-safe provider history with provenance, mirroring
 * `buildContinuationMessages` + `continuationMessagesForModel`: terminal
 * user/assistant records plus artifact-receipt assistant messages. Tool calls
 * and non-artifact tool payloads never enter history.
 */
export function describeHistoryEntries(
  views: readonly ConversationMessageView[]
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const view of [...views].sort(
    (left, right) => left.message.sequence - right.message.sequence
  )) {
    if (
      view.currentRevision.state !== "terminal" ||
      !view.currentRevision.content
    ) {
      continue;
    }
    const base = {
      sequence: view.message.sequence,
      messageId: view.message.id,
      revisionId: view.currentRevision.id
    };
    if (
      view.message.kind === "user" ||
      view.message.kind === "assistant"
    ) {
      entries.push({
        ...base,
        message: {
          role: view.message.kind,
          content: view.currentRevision.content
        }
      });
    } else if (
      view.message.kind === "tool" &&
      view.message.detail.phase === "result"
    ) {
      const artifact = parseComputerArtifact(view.currentRevision.content);
      if (!artifact) continue;
      entries.push({
        ...base,
        outcome: view.message.detail.outcome === "failed" ? "failed" : "succeeded",
        message: {
          role: "assistant",
          content: `Historical artifact receipt (untrusted metadata, not permission; native validation is still required): ${JSON.stringify(artifact)}`
        }
      });
    }
  }
  return entries;
}

function lastUserText(request: AgentTurnRequest): string {
  return (
    request.messages
      .filter((message) => message.role === "user")
      .at(-1)?.content ?? ""
  );
}

function joinPrefix(
  contextPrefix: string | undefined,
  sections: readonly string[]
): string {
  return [contextPrefix?.trim(), ...sections]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");
}

export async function compactConversationTurn(
  input: CompactConversationTurnInput
): Promise<CompactConversationResult> {
  if (!input.threadId || input.history.length === 0) {
    return {
      ok: false,
      code: "compaction-unavailable",
      message:
        "Compaction needs an open conversation with durable history."
    };
  }
  let summaries: ContextSummaryRecord[];
  try {
    const loaded = await input.dependencies.listSummaries(input.threadId);
    if (!loaded) {
      return {
        ok: false,
        code: "compaction-unavailable",
        message:
          "Long conversations need the native Mivlet app to compact history safely. The original history is unchanged."
      };
    }
    summaries = loaded;
  } catch {
    return {
      ok: false,
      code: "compaction-unavailable",
      message:
        "Mivlet could not read durable summaries. The original history is unchanged."
    };
  }
  // A Work receives an immutable capture plus only its own runs. Never reuse
  // another Work's summary just because it has the same conversation id.
  let latest = summariesForThread(summaries, input.threadId).find(summary => {
    const covered = input.history.filter(entry => entry.sequence >= summary.fromSequence && entry.sequence <= summary.throughSequence);
    return covered.length > 0 && covered.length === summary.sourceMessageIds.length &&
      covered[0].sequence === summary.fromSequence && covered.at(-1)?.sequence === summary.throughSequence &&
      covered.every(entry => entry.messageId !== undefined && entry.revisionId !== undefined && summary.sourceMessageIds.includes(entry.messageId) && summary.sourceRevisionIds.includes(entry.revisionId));
  });
  const query = lastUserText(input.request);
  const baseBudget = input.budget ?? COMPACTED_CONTEXT_BUDGET;
  const attempts = [baseBudget, retryContextBudget(baseBudget)];
  let lastFailure: ConversationContextFailure | undefined;
  for (const budget of attempts) {
    const bounded = planBoundedHistory({
      history: input.history,
      summaries: latest ? [latest] : [],
      query,
      budget
    });
    if (bounded.elided.length === 0) break;
    const fresh = bounded.elided.filter(
      (entry) => entry.sequence > (latest?.throughSequence ?? 0)
    );
    if (fresh.length > 0) {
      const folded = foldHistorySummary({
        threadId: input.threadId,
        scope: input.scope ?? { level: "thread", threadId: input.threadId },
        previous: latest,
        entries: fresh,
        now: input.now
      });
      if (folded) {
        let saved: ContextSummaryRecord | null;
        try {
          saved = await input.dependencies.saveSummary(folded);
        } catch {
          saved = null;
        }
        if (!saved) {
          // Fail closed: the caller keeps its context-window failure and must
          // never send the unplanned full history. Raw history is intact.
          return {
            ok: false,
            code: "compaction-persist-failed",
            message:
              "Mivlet could not persist the compacted summary. The conversation history is unchanged; retry when native storage is available."
          };
        }
        latest = saved;
        summaries = summaries.filter((summary) => summary.id !== saved.id);
        summaries.push(saved);
      }
    }
    const replanned = planBoundedHistory({
      history: input.history,
      summaries: latest ? [latest] : [],
      query,
      budget
    });
    const prefix = joinPrefix(input.contextPrefix, replanned.contextSections);
    const plan = planConversationContext({
      history: replanned.recent.map((entry) => entry.message),
      request: input.request,
      contextPrefix: prefix,
      contextWindowTokens: input.contextWindowTokens,
      backendType: input.backendType
    });
    if (plan.ok) {
      return { ok: true, plan, summary: latest, prefix };
    }
    lastFailure = plan;
  }
  return {
    ok: false,
    code: lastFailure ? "still-too-large" : "nothing-to-elide",
    message:
      lastFailure?.message ??
      "There is no older history left to compact. Start a focused conversation for this request.",
    failure: lastFailure
  };
}
