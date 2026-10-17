/** Real fixed-provider egress. Credential bytes never leave this consumer. */
import { runAgentLoop } from "@mivlet/connectors/native-api/agent-loop";
import { shapeOpenAiRequest } from "@mivlet/connectors/native-api/openai-compat";
import { shapeAnthropicRequest } from "@mivlet/connectors/native-api/anthropic";
import { shapeGeminiRequest } from "@mivlet/connectors/native-api/gemini";
import type { HttpTransport } from "@mivlet/connectors/native-api/transport";
import type { BackendAgentEvent, HostedTaskBinding, HostedTaskTextInput, HostedTaskUsage, NativeCompletionRequest } from "@mivlet/protocol";

export const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  xai: "https://api.x.ai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
} as const;
export interface ProviderResult { text: string; usage?: HostedTaskUsage; research?: import("@mivlet/protocol").HostedPublicWebProgress; coding?: import("@mivlet/protocol").HostedCodingProgress }
/** Safe fixed code only. Never forward a provider error body or secret. */
export class ProviderFailure extends Error {
  constructor(readonly code: string, readonly uncertain: boolean) { super(code); }
}
export async function* lines(response: Response, signal: AbortSignal): AsyncIterable<string> {
  if (!response.body) throw new Error("provider-response-unavailable");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let pending = ""; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("provider-response-too-large");
      pending += decoder.decode(item.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); if (line) yield line; }
      if (pending.length > 256 * 1024) throw new Error("provider-line-too-large");
    }
    pending += decoder.decode(); if (pending.trim()) yield pending.trim();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function runRealText(binding: HostedTaskBinding, input: HostedTaskTextInput, secret: string, signal: AbortSignal): Promise<ProviderResult> {
  if (binding.version !== 1 || binding.budget.maxModelCalls !== 1) throw new ProviderFailure("hosted-text-only", false);
  let calls = 0; let dispatched = false; let definitiveRejection: string | undefined; let wireTerminal = false;
  const transport: HttpTransport = { async *stream(request) {
    signal.throwIfAborted();
    if (++calls !== 1 || request.providerId !== binding.providerId || request.model !== binding.model || request.tools.length) throw new Error("hosted-text-only");
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    let endpoint: string; let body: unknown;
    if (binding.providerId === "anthropic") {
      endpoint = ENDPOINTS.anthropic; headers["x-api-key"] = secret; headers["anthropic-version"] = "2023-06-01"; body = shapeAnthropicRequest(request);
    } else if (binding.providerId === "gemini") {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(binding.model)}:streamGenerateContent?alt=sse`;
      headers["x-goog-api-key"] = secret; body = shapeGeminiRequest(request);
    } else { endpoint = ENDPOINTS[binding.providerId]; headers.authorization = `Bearer ${secret}`; body = shapeOpenAiRequest(request); }
    // This is the only provider dispatch. Neither Fetch nor our pure loop has
    // an application retry path; an interrupted send is never replayed.
    dispatched = true;
    // Workers Fetch supports manual/follow. Manual keeps credentials at this
    // fixed provider endpoint; every non-success (including redirects) fails.
    const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 422, 429].includes(response.status)) definitiveRejection = response.status === 401 || response.status === 403 ? "hosted-provider-authentication-required" : response.status === 429 ? "hosted-provider-rate-limited" : "hosted-provider-request-rejected";
      throw new Error(definitiveRejection ?? "hosted-provider-request-uncertain");
    }
    for await (const line of lines(response, signal)) {
      // The shared loop also emits a closing event at EOF. Require a real
      // protocol terminator so a truncated response cannot become success.
      if (line.startsWith("data:")) {
        try {
          const value = JSON.parse(line.slice(5).trim());
          if (binding.providerId === "anthropic" ? value?.type === "message_stop"
            : binding.providerId === "gemini" ? value?.candidates?.[0]?.finishReason === "STOP"
            : value?.choices?.[0]?.finish_reason === "stop") wireTerminal = true;
        } catch { /* The shared parser reports malformed data. */ }
      }
      yield line;
    }
  } };
  const request: NativeCompletionRequest = { providerId: binding.providerId, model: binding.model, messages: input.messages, tools: [], maxTokens: binding.budget.maxOutputTokens, ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}) };
  let text = ""; let finish = false; let failed = false; let usage: HostedTaskUsage | undefined;
  try { for await (const event of runAgentLoop(transport, request, {
    toolsEnabled: false, modelSupportsTools: false, maxTurns: 1, maxToolCalls: 0,
    permissionMode: "read-only", runId: binding.runId, shouldCancel: () => signal.aborted,
    execute: async () => { throw new Error("hosted-text-only"); },
  })) {
    signal.throwIfAborted();
    switch (event.type) {
      case "text-delta": text += event.text; if (new TextEncoder().encode(text).length > binding.budget.maxResultBytes) throw new Error("hosted-result-limit"); break;
      case "usage": usage = usageRecord(event); if (usage.outputTokens > binding.budget.maxOutputTokens) throw new Error("hosted-output-token-limit"); break;
      case "done": finish = event.finishReason === "stop"; if (!finish) failed = true; break;
      case "reasoning-summary": break; // Public summaries are optional; first path retains final text only.
      default: failed = true; break; // No tool, retry, cancellation or error can become a successful text task.
    }
  }
  signal.throwIfAborted();
  if (!finish || !wireTerminal || failed || !text.trim()) throw new Error("hosted-provider-incomplete");
  // Check the assembled output too, so a provider cannot echo a key split over
  // separate SSE deltas. No partial text leaves the custody boundary.
  if (text.includes(secret)) throw new Error("hosted-provider-secret-content");
  return { text, ...(usage ? { usage } : {}) };
  } catch {
    throw new ProviderFailure(definitiveRejection ?? (dispatched ? "hosted-provider-outcome-uncertain" : "hosted-provider-not-dispatched"), dispatched && !definitiveRejection);
  }
}
export function usageRecord(event: Extract<BackendAgentEvent, { type: "usage" }>): HostedTaskUsage {
  for (const value of [event.inputTokens, event.outputTokens, event.cachedInputTokens, event.cacheWriteTokens, event.reasoningTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_000_000)) throw new Error("hosted-provider-usage-invalid");
  if (!Number.isFinite(event.costUsd) || event.costUsd < 0) throw new Error("hosted-provider-usage-invalid");
  return { inputTokens: event.inputTokens, outputTokens: event.outputTokens,
    ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
    ...(event.cacheWriteTokens !== undefined ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
    ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
    // The shared adapter may estimate a provider-wide catalogue price. This
    // cloud path has no exact model billing receipt, so never present that
    // estimate as known cloud spend or as an enforced money cap.
    costUsd: event.costEstimated === false && event.costUnknown !== true ? event.costUsd : 0,
    costEstimated: event.costEstimated !== false, costUnknown: event.costEstimated !== false || event.costUnknown !== false };
}
