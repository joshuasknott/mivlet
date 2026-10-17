import { runAgentLoop } from "@mivlet/connectors/native-api/agent-loop";
import { registeredToolSpecs } from "@mivlet/connectors/native-api/tools";
import { catalogueCapabilities } from "@mivlet/connectors/native-api/model-catalogue";
import { shapeOpenAiRequest } from "@mivlet/connectors/native-api/openai-compat";
import { shapeAnthropicRequest } from "@mivlet/connectors/native-api/anthropic";
import { shapeGeminiRequest } from "@mivlet/connectors/native-api/gemini";
import type { HttpTransport } from "@mivlet/connectors/native-api/transport";
import { canonicalHostedTaskJson, hostedTaskSha256, hostedTextContentFailure, HOSTED_PUBLIC_WEB_LIMITS as L, publicWebUrl,
  type HostedPublicWebTaskBinding, type HostedTaskTextInput, type HostedTaskUsage, type NativeCompletionRequest } from "@mivlet/protocol";
import { ENDPOINTS, lines, ProviderFailure, usageRecord, type ProviderResult } from "./provider";
import { publicWebReader, type PublicWebReader } from "./public-web-reader";
import type { ResearchJournal } from "./research-journal";

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret));
  return !!value && typeof value === "object" && Object.values(value).some(item => containsSecret(item, secret));
}
function safeKeyUrl(url: string, secret: string): void {
  let decoded = url;
  for (let count = 0; count < 64; count++) {
    if (decoded.includes(secret)) throw new Error("research-secret-url");
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { throw new Error("research-secret-url"); }
    if (next === decoded) return;
    decoded = next;
  }
  throw new Error("research-secret-url");
}

/** Same provider adapters, separate explicitly authorized read-only execution.
 * Credential never leaves this function's Worker custody, including tool args. */
export async function runRealResearch(binding: HostedPublicWebTaskBinding, input: HostedTaskTextInput, secret: string,
  signal: AbortSignal, journal: ResearchJournal, reader: PublicWebReader = publicWebReader): Promise<ProviderResult> {
  let sent = false; let calls = 0; let allocated = 0;
  let providerFailure: ProviderFailure | undefined;
  const tools = registeredToolSpecs().filter(tool => tool.name === "web-fetch");
  if (tools.length !== 1 || catalogueCapabilities(binding.providerId, binding.model)?.tools !== true) throw new ProviderFailure("research-tool-model-required", false);
  const transport: HttpTransport = { async *stream(request) {
    try {
    signal.throwIfAborted();
    if (++calls > binding.budget.maxModelCalls || request.providerId !== binding.providerId || request.model !== binding.model
      || request.tools.length !== 1 || request.tools[0].name !== "web-fetch") throw new ProviderFailure("research-model-limit", false);
    const tokens = Math.min(L.tokensPerCall, binding.budget.maxOutputTokens - allocated);
    if (tokens < 1) throw new ProviderFailure("research-model-limit", false);
    const bounded = { ...request, maxTokens: tokens };
    const context = canonicalHostedTaskJson(bounded);
    if (new TextEncoder().encode(context).length > L.contextBytes || containsSecret(bounded, secret)) throw new ProviderFailure("research-context-limit", false);
    const step = await journal.model(await hostedTaskSha256(bounded), tokens); allocated += tokens;
    signal.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    let endpoint: string; let body: unknown;
    if (binding.providerId === "anthropic") {
      endpoint = ENDPOINTS.anthropic; headers["x-api-key"] = secret; headers["anthropic-version"] = "2023-06-01"; body = shapeAnthropicRequest(bounded);
    } else if (binding.providerId === "gemini") {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(binding.model)}:streamGenerateContent?alt=sse`;
      headers["x-goog-api-key"] = secret; body = shapeGeminiRequest(bounded);
    } else { endpoint = ENDPOINTS[binding.providerId]; headers.authorization = `Bearer ${secret}`; body = shapeOpenAiRequest(bounded); }
    // Journal committed, cancellation checked, then one possible send. No SDK
    // auto-retry or restart/continuation replay exists on this path.
    signal.throwIfAborted(); sent = true;
    const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderFailure([401, 403].includes(response.status) ? "hosted-provider-authentication-required" : "hosted-provider-request-rejected", ![400, 401, 403, 404, 422, 429].includes(response.status));
    }
    let terminal = false; let wire = "";
    for await (const line of lines(response, signal)) {
      wire += line;
      if (line.startsWith("data:")) try {
        const value = JSON.parse(line.slice(5).trim());
        if (binding.providerId === "anthropic" ? value?.type === "message_stop"
          : binding.providerId === "gemini" ? ["STOP", "MAX_TOKENS"].includes(value?.candidates?.[0]?.finishReason)
          : ["stop", "tool_calls", "length"].includes(value?.choices?.[0]?.finish_reason)) terminal = true;
      } catch { /* Shared provider parser validates actual frames. */ }
      yield line;
    }
    if (!terminal) throw new ProviderFailure("hosted-provider-outcome-uncertain", true);
    if (wire.includes(secret)) throw new ProviderFailure("hosted-provider-secret-content", false);
    await journal.finish(step, await hostedTaskSha256(wire));
    } catch (error) {
      providerFailure = error instanceof ProviderFailure ? error : new ProviderFailure(sent ? "hosted-provider-outcome-uncertain" : "hosted-provider-not-dispatched", sent);
      throw providerFailure;
    }
  } };
  const request: NativeCompletionRequest = { providerId: binding.providerId, model: binding.model, messages: input.messages, tools,
    maxTokens: Math.min(L.tokensPerCall, binding.budget.maxOutputTokens), ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}) };
  let text = ""; let completed = false; let failed = false; let usage: HostedTaskUsage | undefined;
  try {
    for await (const event of runAgentLoop(transport, request, {
      toolsEnabled: true, toolGuidanceAlreadyIncluded: true, modelSupportsTools: true, maxTurns: binding.budget.maxModelCalls, maxToolCalls: binding.budget.maxPageReads,
      maxToolOutputCharacters: 64000, permissionMode: "read-only", runId: binding.runId, shouldCancel: () => signal.aborted,
      execute: async (approval, args) => {
        signal.throwIfAborted();
        if (approval.action.split(/\s+/)[0] !== "web-fetch" || args.length > 4096 || args.includes(secret) || hostedTextContentFailure(args)) throw new Error("research-tool-outside-scope");
        const input = JSON.parse(args);
        if (!input || Array.isArray(input) || Object.keys(input).join(",") !== "url") throw new Error("research-tool-outside-scope");
        const url = publicWebUrl(input.url, binding.webScope.allowedDomains);
        safeKeyUrl(url, secret);
        const step = await journal.read(await hostedTaskSha256({ url })); signal.throwIfAborted();
        let page;
        try { page = await reader.read(url, binding.webScope, signal); signal.throwIfAborted(); }
        catch {
          signal.throwIfAborted(); await journal.finish(step, await hostedTaskSha256({ error: "research-page-unavailable" }));
          throw new Error("research-page-unavailable");
        }
        const output = { trust: "external-untrusted", instructionAuthority: "none", ...page.source, content: page.text, links: page.links };
        const encoded = canonicalHostedTaskJson(output);
        safeKeyUrl(page.source.finalUri, secret); for (const link of page.links) safeKeyUrl(link, secret);
        if (containsSecret(output, secret) || hostedTextContentFailure(page.text) || new TextEncoder().encode(encoded).length > 64000) throw new Error("research-page-content-unavailable");
        await journal.finish(step, await hostedTaskSha256(output), page.source);
        return encoded;
      },
    })) {
      signal.throwIfAborted();
      if (event.type === "text-delta") { text += event.text; if (new TextEncoder().encode(text).length > binding.budget.maxResultBytes) throw new ProviderFailure("hosted-result-limit", false); }
      else if (event.type === "tool-call") text = "";
      else if (event.type === "usage") { usage = usageRecord(event); if (usage.outputTokens > binding.budget.maxOutputTokens) throw new ProviderFailure("hosted-output-token-limit", false); }
      else if (event.type === "done") completed = event.finishReason === "stop";
      else if (event.type === "error" || event.type === "cancelled") failed = true;
    }
    signal.throwIfAborted();
    if (providerFailure) throw providerFailure;
    const research = journal.progress();
    if (!completed || failed || !research.sources.length || !text.trim()) throw new ProviderFailure("research-incomplete", false);
    if (text.includes(secret) || hostedTextContentFailure(text)) throw new ProviderFailure("hosted-provider-secret-content", false);
    return { text, research, ...(usage ? { usage } : {}) };
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(sent ? "hosted-provider-outcome-uncertain" : "hosted-provider-not-dispatched", sent);
  }
}
