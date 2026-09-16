import type { HistoryEntry } from "@mivlet/knowledge";
import type {
  AgentTurnRequest,
  BackendModel,
  BackendProvider,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import {
  compactConversationTurn,
  describeHistoryEntries,
} from "../../lib/conversation-compaction";
import {
  planConversationContext,
  type ConversationContextFailure,
  type ConversationContextPlan,
} from "../../lib/conversation-context";
import {
  buildContinuationMessages,
  continuationMessagesForModel,
} from "../../lib/agent-run";
import type { HydratedConversation } from "../../lib/conversation-runtime";
import {
  listRuntimeContextSummaries,
  saveRuntimeContextSummary,
} from "../../runtime/domains/memory";
import type { NativeAgentContextScope } from "./types";

export function nativeAgentContextScope(input: {
  workspaceId?: string;
  agentId?: string;
  threadId?: string;
  ownerInternalUserId?: string;
  ownerMemberId?: string;
}): NativeAgentContextScope {
  return {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    threadId: input.threadId,
    ownerInternalUserId: input.ownerInternalUserId,
    ownerMemberId: input.ownerMemberId,
  };
}

export function resolvePreparedAttemptContext(
  preparedContext: PreparedExecutionContext | string | undefined,
  generatedAttemptId: string,
  createdAt: string,
  threadId: string | undefined,
): PreparedExecutionContext {
  return typeof preparedContext === "object" && preparedContext?.receipt
    ? preparedContext
    : {
        systemPrefix:
          typeof preparedContext === "string" ? preparedContext : "",
        receipt: {
          version: 1 as const,
          attemptId: generatedAttemptId,
          assembledAt: createdAt,
          scope: threadId
            ? { level: "thread" as const, threadId }
            : { level: "global" as const },
          citations: [],
          contributions: [],
        },
      };
}

export async function loadContinuationHistory(input: {
  requestThreadId: string;
  parentAttemptId?: string;
  loadConversation: (threadId: string) => Promise<HydratedConversation | null>;
  attributeHistory?: (
    conversation: HydratedConversation,
  ) => HydratedConversation;
  isCurrentThread: () => boolean;
  isCurrentScope: () => boolean;
}): Promise<
  | { ok: true; history: AgentTurnRequest["messages"]; historyEntries: HistoryEntry[] }
  | { ok: false; error: unknown }
> {
  try {
    const conversation = await input.loadConversation(input.requestThreadId);
    if (
      !conversation ||
      conversation.thread.id !== input.requestThreadId ||
      !input.isCurrentThread() ||
      !input.isCurrentScope()
    ) {
      throw new Error(
        "The conversation changed before the message could be sent. Try again.",
      );
    }
    // Completed conversation only. Orphaned tool results and tool calls
    // must not be replayed as requests or duplicated in the transcript.
    const replaySafeViews = (
      input.attributeHistory?.(conversation) ?? conversation
    ).messages.filter(
      (view) =>
        !input.parentAttemptId || view.message.runId !== input.parentAttemptId,
    );
    return {
      ok: true,
      history: continuationMessagesForModel(
        buildContinuationMessages(replaySafeViews),
      ),
      historyEntries: describeHistoryEntries(replaySafeViews),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function planAttemptContext(input: {
  history: AgentTurnRequest["messages"];
  request: AgentTurnRequest;
  contextPrefix: string;
  selectedModel?: BackendModel;
  provider?: BackendProvider;
  backendType: string;
  requestThreadId: string | undefined;
  historyEntries: HistoryEntry[];
  isCurrentScope: () => boolean;
  isCurrentThread: () => boolean;
}): Promise<
  | { stale: true }
  | {
      stale?: false;
      plan: ConversationContextPlan;
      prefix: string;
    }
> {
  let contextPlan = await planConversationContext({
    history: input.history,
    request: input.request,
    contextPrefix: input.contextPrefix,
    contextWindowTokens: input.selectedModel?.capabilities?.contextWindow,
    backendType: input.provider?.backendType ?? input.backendType,
  });
  let prefix = input.contextPrefix;
  if (
    !contextPlan.ok &&
    input.requestThreadId &&
    input.historyEntries.length > 0 &&
    (contextPlan.reason === "model-context-window" ||
      contextPlan.reason === "native-history-envelope")
  ) {
    const compacted = await compactConversationTurn({
      threadId: input.requestThreadId,
      history: input.historyEntries,
      request: input.request,
      contextPrefix: input.contextPrefix,
      contextWindowTokens: input.selectedModel?.capabilities?.contextWindow,
      backendType: input.provider?.backendType ?? input.backendType,
      dependencies: {
        listSummaries: listRuntimeContextSummaries,
        saveSummary: saveRuntimeContextSummary,
      },
    });
    if (!input.isCurrentScope() || !input.isCurrentThread()) {
      return { stale: true };
    }
    if (compacted.ok) {
      contextPlan = compacted.plan;
      prefix = compacted.prefix;
    } else {
      contextPlan = {
        ...contextPlan,
        message: `${contextPlan.message} ${compacted.message}`,
      };
    }
  }
  return { plan: contextPlan, prefix };
}

export function contextFailureState(
  plan: ConversationContextFailure,
  request: AgentTurnRequest,
  scope: NativeAgentContextScope,
) {
  return {
    ...plan,
    requestPrompt:
      request.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content ?? "",
    scope,
  };
}
