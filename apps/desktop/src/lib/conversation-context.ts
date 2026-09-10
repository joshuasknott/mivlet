import type { AgentTurnRequest } from "@fable/protocol";

export const CODEX_HISTORY_MAX_UTF8_BYTES = 64 * 1024;
const CONTEXT_WINDOW_USAGE_PERCENT = 80;
const IMAGE_RESERVE_TOKENS = 4_096;
const REQUEST_OVERHEAD_TOKENS = 64;

type NativeMessage = AgentTurnRequest["messages"][number];

export interface ConversationContextDiagnostics {
  /** A local estimate, never presented as provider-billed usage. */
  estimatedInputTokens: number;
  tokenizer: "local-utf8-estimate";
  outputReserveTokens: number;
  contextWindowTokens?: number;
  usableContextTokens?: number;
  capacitySource: "provider-metadata" | "unavailable";
  historyUtf8Bytes: number;
  nativeHistoryMaxUtf8Bytes?: number;
}

export interface ConversationContextFailure extends ConversationContextDiagnostics {
  ok: false;
  code: "conversation-context-too-large";
  reason: "invalid-output-budget" | "model-context-window" | "native-history-envelope";
  message: string;
}

export type ConversationContextPlan =
  | ({ ok: true; messages: AgentTurnRequest["messages"] } & ConversationContextDiagnostics)
  | ConversationContextFailure;

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

function localTokenEstimate(value: string): number {
  const asciiCharacters = value.replace(/[^\x00-\x7F]/gu, "").length;
  const nonAsciiBytes = utf8Bytes(value) - asciiCharacters;
  // Common UTF-8 text averages several bytes per token. These divisors keep
  // non-ASCII and structured evidence conservative without treating every byte
  // as a token. Provider-reported usage remains authoritative.
  return Math.ceil(asciiCharacters / 3) + Math.ceil(nonAsciiBytes / 2);
}

/**
 * Estimate the serialized request with a bounded local UTF-8 heuristic.
 * Provider usage remains authoritative; the estimator is named in diagnostics
 * because model-specific tokenization and provider framing can differ.
 */
export function estimateConversationInputTokens(
  messages: readonly NativeMessage[],
  tools: AgentTurnRequest["tools"],
  contextPrefix = "",
): number {
  const text = JSON.stringify({
    messages: messages.map(({ role, content, toolCallId, toolName }) => ({
      role,
      content,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
    })),
    tools,
    contextPrefix,
  });
  const imageReserve = messages.reduce(
    (total, message) => total + (message.images?.length ?? 0) * IMAGE_RESERVE_TOKENS,
    0,
  );
  return REQUEST_OVERHEAD_TOKENS + localTokenEstimate(text) + imageReserve;
}

/** Match the exact history shape sent through the native Codex envelope. */
export function codexHistoryUtf8Bytes(messages: readonly NativeMessage[]): number {
  const history = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
  return utf8Bytes(JSON.stringify(history));
}

/** Preserve the complete terminal conversation or return an inspectable failure. */
export function planConversationContext(input: PlanConversationContextInput): ConversationContextPlan {
  const system = input.request.messages.filter((message) => message.role === "system");
  const current = input.request.messages.filter((message) => message.role !== "system");
  const messages = [...system, ...input.history, ...current];
  const historyUtf8Bytes = codexHistoryUtf8Bytes(input.history);
  const contextWindowTokens = Number.isFinite(input.contextWindowTokens) && (input.contextWindowTokens ?? 0) > 0
    ? Math.floor(input.contextWindowTokens!)
    : undefined;
  const usableContextTokens = contextWindowTokens
    ? Math.floor((contextWindowTokens * CONTEXT_WINDOW_USAGE_PERCENT) / 100)
    : undefined;
  const estimatedInputTokens = estimateConversationInputTokens(messages, input.request.tools, input.contextPrefix);
  const diagnostics: ConversationContextDiagnostics = {
    estimatedInputTokens,
    tokenizer: "local-utf8-estimate",
    outputReserveTokens: input.request.maxTokens,
    contextWindowTokens,
    usableContextTokens,
    capacitySource: contextWindowTokens ? "provider-metadata" : "unavailable",
    historyUtf8Bytes,
    ...(input.backendType === "codex-app-server"
      ? { nativeHistoryMaxUtf8Bytes: CODEX_HISTORY_MAX_UTF8_BYTES }
      : {}),
  };

  if (!Number.isFinite(input.request.maxTokens) || input.request.maxTokens < 1) {
    return {
      ...diagnostics,
      ok: false,
      code: "conversation-context-too-large",
      reason: "invalid-output-budget",
      message: "The selected model returned an invalid output budget. Refresh its provider metadata and try again.",
    };
  }
  if (input.backendType === "codex-app-server" && historyUtf8Bytes > CODEX_HISTORY_MAX_UTF8_BYTES) {
    return {
      ...diagnostics,
      ok: false,
      code: "conversation-context-too-large",
      reason: "native-history-envelope",
      message: `This conversation uses ${historyUtf8Bytes.toLocaleString()} of the ${CODEX_HISTORY_MAX_UTF8_BYTES.toLocaleString()} byte Codex history envelope. Review a continuation handoff to keep working in a new conversation. The original history stays here.`,
    };
  }
  if (usableContextTokens && estimatedInputTokens + input.request.maxTokens > usableContextTokens) {
    return {
      ...diagnostics,
      ok: false,
      code: "conversation-context-too-large",
      reason: "model-context-window",
      message: `This request needs about ${estimatedInputTokens.toLocaleString()} input tokens plus ${input.request.maxTokens.toLocaleString()} reserved output tokens; the provider reports a ${contextWindowTokens!.toLocaleString()} token context window. Review a continuation handoff to keep working in a new conversation. The original history stays here.`,
    };
  }
  return { ...diagnostics, ok: true, messages };
}
