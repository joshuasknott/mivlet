import type { AgentTurnRequest } from "@fable/protocol";

export const CODEX_HISTORY_MAX_UTF8_BYTES = 64 * 1024;
export const UNKNOWN_CONTEXT_WINDOW_TOKENS = 32_768;
const CONTEXT_WINDOW_USAGE_PERCENT = 80;
const MESSAGE_OVERHEAD_TOKENS = 32;
const TOOL_OVERHEAD_TOKENS = 128;
const IMAGE_RESERVE_TOKENS = 4_096;
const REQUEST_OVERHEAD_TOKENS = 256;

type NativeMessage = AgentTurnRequest["messages"][number];

export type ConversationContextPlan =
  | {
      ok: true;
      messages: AgentTurnRequest["messages"];
      estimatedInputTokens: number;
      historyUtf8Bytes: number;
      contextWindowTokens: number;
    }
  | {
      ok: false;
      code: "conversation-context-too-large";
      message: string;
      estimatedInputTokens: number;
      historyUtf8Bytes: number;
      contextWindowTokens: number;
    };

export interface PlanConversationContextInput {
  history: AgentTurnRequest["messages"];
  request: AgentTurnRequest;
  contextPrefix?: string;
  contextWindowTokens?: number;
  backendType: string;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Conservative upper bound used before persistence and provider egress. UTF-8
 * bytes are counted as tokens so unusual text cannot make the estimate smaller
 * than a byte-level tokenizer, with explicit reserves for framing and images.
 */
export function estimateConversationInputTokens(
  messages: readonly NativeMessage[],
  tools: AgentTurnRequest["tools"],
  contextPrefix = "",
): number {
  const messageTokens = messages.reduce(
    (total, message) =>
      total +
      utf8Bytes(message.role) +
      utf8Bytes(message.content) +
      MESSAGE_OVERHEAD_TOKENS +
      (message.toolCallId ? utf8Bytes(message.toolCallId) : 0) +
      (message.toolName ? utf8Bytes(message.toolName) : 0) +
      (message.images?.length ?? 0) * IMAGE_RESERVE_TOKENS,
    0,
  );
  const toolTokens = tools.reduce(
    (total, tool) =>
      total +
      utf8Bytes(tool.name) +
      utf8Bytes(tool.description) +
      utf8Bytes(tool.parameters) +
      TOOL_OVERHEAD_TOKENS,
    0,
  );
  return REQUEST_OVERHEAD_TOKENS + messageTokens + toolTokens + utf8Bytes(contextPrefix);
}

/**
 * Preserve the complete terminal conversation or reject it. This first-stage
 * guard deliberately performs no summarization, ranking, or silent omission.
 */
export function planConversationContext(
  input: PlanConversationContextInput,
): ConversationContextPlan {
  const system = input.request.messages.filter((message) => message.role === "system");
  const current = input.request.messages.filter((message) => message.role !== "system");
  const messages = [...system, ...input.history, ...current];
  const historyUtf8Bytes = utf8Bytes(JSON.stringify(input.history));
  const contextWindowTokens = Number.isFinite(input.contextWindowTokens) &&
    (input.contextWindowTokens ?? 0) > 0
    ? Math.floor(input.contextWindowTokens!)
    : UNKNOWN_CONTEXT_WINDOW_TOKENS;
  const estimatedInputTokens = estimateConversationInputTokens(
    messages,
    input.request.tools,
    input.contextPrefix,
  );
  const usableTokens = Math.floor(
    (contextWindowTokens * CONTEXT_WINDOW_USAGE_PERCENT) / 100,
  );
  const codexHistoryExceeded =
    input.backendType === "codex-app-server" &&
    historyUtf8Bytes > CODEX_HISTORY_MAX_UTF8_BYTES;
  if (
    codexHistoryExceeded ||
    !Number.isFinite(input.request.maxTokens) || input.request.maxTokens < 1 ||
    estimatedInputTokens + input.request.maxTokens > usableTokens
  ) {
    return {
      ok: false,
      code: "conversation-context-too-large",
      message:
        "This conversation is too long for the selected model. Start a new conversation to continue; Mivlet did not omit or summarize any earlier messages.",
      estimatedInputTokens,
      historyUtf8Bytes,
      contextWindowTokens,
    };
  }
  return {
    ok: true,
    messages,
    estimatedInputTokens,
    historyUtf8Bytes,
    contextWindowTokens,
  };
}
