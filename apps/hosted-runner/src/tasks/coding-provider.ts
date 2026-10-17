import { catalogueCapabilities } from "@mivlet/connectors/native-api/model-catalogue";
import { shapeOpenAiRequest, streamOpenAiEvents } from "@mivlet/connectors/native-api/openai-compat";
import { shapeAnthropicRequest, streamAnthropicEvents } from "@mivlet/connectors/native-api/anthropic";
import { shapeGeminiRequest, streamGeminiEvents } from "@mivlet/connectors/native-api/gemini";
import type { HttpTransport } from "@mivlet/connectors/native-api/transport";
import {
  canonicalHostedTaskJson, hostedTaskSha256, hostedTextContentFailure, HOSTED_CODING_TOOLS,
  HOSTED_CODING_LIMITS as L, type HostedCodingProgress, type HostedCodingProposal,
  type HostedCodingTaskBinding, type HostedRepositoryFile, type HostedRepositoryOutputManifest,
  type HostedTaskTextInput, type HostedTaskUsage, type NativeCompletionRequest, type NativeMessage, type NativeToolCall,
} from "@mivlet/protocol";
import { boundedObject, exactKeys, integer } from "./contracts";
import { utf8 } from "./coding-contracts";
import { ENDPOINTS, lines, ProviderFailure, usageRecord, type ProviderResult } from "./provider";
import type { CodingJournal } from "./coding-journal";
import type { CodingRuntimeBinding, CodingCheckResult } from "./coding-runtime-contract";

export interface CodingFileAccess {
  manifest(): Promise<HostedRepositoryFile[]>;
  bytes(file: HostedRepositoryFile): Promise<Uint8Array>;
  read(path: string, offset: number, length: number): Promise<{ sha256: string; sizeBytes: number; content: string; end: boolean }>;
  write(path: string, expected: string | null, content: string | null): Promise<{ sha256: string | null }>;
  sealOutput(): Promise<HostedRepositoryOutputManifest>;
}
function hasSecret(value: unknown, key: string): boolean {
  if (typeof value === "string") return value.includes(key);
  return Array.isArray(value) ? value.some(item => hasSecret(item, key)) : !!value && typeof value === "object" && Object.values(value).some(item => hasSecret(item, key));
}
function addUsage(previous: HostedTaskUsage | undefined, next: HostedTaskUsage): HostedTaskUsage {
  const sum = (field: "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens") => previous?.[field] === undefined && next[field] === undefined ? undefined : (previous?.[field] ?? 0) + (next[field] ?? 0);
  return { inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens, outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    cachedInputTokens: sum("cachedInputTokens"), cacheWriteTokens: sum("cacheWriteTokens"), reasoningTokens: sum("reasoningTokens"), costUsd: 0, costEstimated: true, costUnknown: true };
}
class ScopeProposal extends Error { constructor(readonly proposal: HostedCodingProposal) { super("coding-fresh-review-required"); } }

/** Closed scratch loop using the existing provider shapers/parsers. It does not
 * enter the local tool registry, permission presets, or local approval bypass. */
export async function runRealCoding(binding: HostedCodingTaskBinding, input: HostedTaskTextInput, secret: string, signal: AbortSignal,
  journal: CodingJournal, files: CodingFileAccess, runtime: CodingRuntimeBinding | undefined): Promise<ProviderResult> {
  if (!runtime) throw new ProviderFailure("hosted-coding-runtime-required", false);
  if (catalogueCapabilities(binding.providerId, binding.model)?.tools !== true) throw new ProviderFailure("coding-tool-model-required", false);
  let sent = false; let text = ""; let usage: HostedTaskUsage | undefined;
  const messages: NativeMessage[] = [...input.messages]; const seen = new Set<string>();
  const safe = (value: unknown, maximum: number) => { const encoded = canonicalHostedTaskJson(value); if (utf8.encode(encoded).length > maximum || hasSecret(value, secret) || hostedTextContentFailure(encoded)) throw new ProviderFailure("coding-content-refused", false); return encoded; };
  const progress = async (proposal?: HostedCodingProposal): Promise<ProviderResult> => {
    signal.throwIfAborted(); const state = await journal.progress(); const output = await files.sealOutput(); signal.throwIfAborted();
    const coding: HostedCodingProgress = { modelCalls: state.modelCalls, toolCalls: state.toolCalls, allocatedOutputTokens: state.allocatedOutputTokens, completedChecks: state.completedChecks, output, ...(proposal ? { proposal } : {}) };
    return { text: proposal ? "Needs a fresh task review for the recorded additional file or command scope. The retained scratch candidate has not been imported locally." : text, coding, ...(usage ? { usage } : {}) };
  };
  const propose = async (call: NativeToolCall, reason: HostedCodingProposal["reason"]): Promise<never> => {
    safe(call.arguments, 8192);
    throw new ScopeProposal({ tool: call.tool, arguments: call.arguments, argumentsSha256: await hostedTaskSha256(call.arguments), reason });
  };
  try {
    signal.throwIfAborted();
    const prerequisite = await runtime.prerequisites(binding.repository.scope.image);
    signal.throwIfAborted();
    if (prerequisite.image !== binding.repository.scope.image || prerequisite.network !== "disabled" || prerequisite.proof !== "positive-and-negative-v1") throw new ProviderFailure("coding-network-proof-required", false);
    for (let turn = 0; turn < binding.budget.maxModelCalls; turn++) {
      signal.throwIfAborted(); const state = await journal.progress();
      const tokens = Math.min(L.tokensPerCall, binding.budget.maxOutputTokens - state.allocatedOutputTokens);
      if (tokens < 1) throw new ProviderFailure("coding-model-limit", false);
      const request: NativeCompletionRequest = { providerId: binding.providerId, model: binding.model, messages, tools: [...HOSTED_CODING_TOOLS], maxTokens: tokens, ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}) };
      safe(request, L.contextBytes);
      const step = await journal.start("model", await hostedTaskSha256(request), tokens);
      let wireTerminal = false; let wire = "";
      const transport: HttpTransport = { async *stream(shaped) {
        signal.throwIfAborted();
        const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
        let endpoint: string; let body: unknown;
        if (binding.providerId === "anthropic") { endpoint = ENDPOINTS.anthropic; headers["x-api-key"] = secret; headers["anthropic-version"] = "2023-06-01"; body = shapeAnthropicRequest(shaped); }
        else if (binding.providerId === "gemini") { endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(binding.model)}:streamGenerateContent?alt=sse`; headers["x-goog-api-key"] = secret; body = shapeGeminiRequest(shaped); }
        else { endpoint = ENDPOINTS[binding.providerId]; headers.authorization = `Bearer ${secret}`; body = shapeOpenAiRequest(shaped); }
        signal.throwIfAborted(); sent = true;
        const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body), signal });
        if (!response.ok) { await response.body?.cancel(); throw new ProviderFailure([401, 403].includes(response.status) ? "hosted-provider-authentication-required" : "hosted-provider-request-rejected", ![400, 401, 403, 404, 422, 429].includes(response.status)); }
        for await (const line of lines(response, signal)) {
          wire += line;
          if (line.startsWith("data:")) try {
            const value = JSON.parse(line.slice(5).trim());
            if (binding.providerId === "anthropic" ? value?.type === "message_stop" : binding.providerId === "gemini" ? ["STOP", "MAX_TOKENS"].includes(value?.candidates?.[0]?.finishReason) : ["stop", "tool_calls", "length"].includes(value?.choices?.[0]?.finish_reason)) wireTerminal = true;
          } catch { /* Shared parsers validate frames. */ }
          yield line;
        }
      } };
      const stream = binding.providerId === "anthropic" ? streamAnthropicEvents : binding.providerId === "gemini" ? streamGeminiEvents : streamOpenAiEvents;
      const calls: NativeToolCall[] = []; let finish = "error"; text = ""; let nextUsage: HostedTaskUsage | undefined; let failed = false;
      for await (const event of stream(transport, request)) {
        signal.throwIfAborted();
        if (event.type === "text-delta") { text += event.text; if (utf8.encode(text).length > binding.budget.maxResultBytes) throw new ProviderFailure("hosted-result-limit", false); }
        else if (event.type === "tool-call") {
          if (!event.callId || !/^[a-zA-Z0-9_-]{1,160}$/.test(event.callId) || seen.has(event.callId) || event.arguments.length > 64000) throw new ProviderFailure("coding-tool-call-refused", false);
          seen.add(event.callId); safe(event.arguments, 64000);
          calls.push({ callId: event.callId, tool: event.tool, arguments: event.arguments, continuationToken: event.continuationToken });
        } else if (event.type === "usage") nextUsage = usageRecord(event);
        else if (event.type === "done") finish = event.finishReason;
        else if (event.type === "error" || event.type === "cancelled") failed = true;
      }
      signal.throwIfAborted();
      if (failed || !wireTerminal || wire.includes(secret)) throw new ProviderFailure("hosted-provider-outcome-uncertain", true);
      await journal.finish(step, await hostedTaskSha256(wire));
      if (nextUsage) { usage = addUsage(usage, nextUsage); if (usage.outputTokens > binding.budget.maxOutputTokens) throw new ProviderFailure("hosted-output-token-limit", false); }
      if (finish === "stop" && !calls.length && text.trim()) { safe(text, binding.budget.maxResultBytes); return await progress(); }
      if (finish !== "tool-calls" || !calls.length || turn + 1 >= binding.budget.maxModelCalls) throw new ProviderFailure("coding-incomplete", false);
      messages.push({ role: "assistant", content: text, toolCalls: calls });
      for (const call of calls) {
        signal.throwIfAborted(); const args = boundedObject(JSON.parse(call.arguments)); let output: unknown; let toolStep: string;
        if (call.tool === "scratch_read") {
          exactKeys(args, ["path", "offset", "length"]);
          const manifest = await files.manifest(); if (typeof args.path !== "string" || !manifest.some(file => file.path === args.path)) return await propose(call, "path-outside-scope");
          toolStep = await journal.start("read", await hostedTaskSha256(args));
          output = await files.read(args.path, integer(args.offset, 0, L.fileBytes), integer(args.length, 1, 16384));
        } else if (call.tool === "scratch_write") {
          exactKeys(args, ["path", "expectedSha256", "content"]);
          if (typeof args.path !== "string" || !binding.repository.scope.writablePaths.includes(args.path)) return await propose(call, "path-outside-scope");
          if ((args.expectedSha256 !== null && (typeof args.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) || (args.content !== null && typeof args.content !== "string")) throw new Error("coding-write-refused");
          toolStep = await journal.start("write", await hostedTaskSha256(args));
          output = await files.write(args.path, args.expectedSha256, args.content);
        } else if (call.tool === "scratch_check") {
          exactKeys(args, ["id"]);
          if (typeof args.id !== "string" || !binding.repository.scope.checks.some(check => check.id === args.id)) return await propose(call, "check-outside-scope");
          const manifest = await files.manifest(); const candidateSha256 = await hostedTaskSha256(manifest);
          toolStep = await journal.start("check", await hostedTaskSha256({ id: args.id, candidateSha256 }));
          const leaseId = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
          const cancel = () => { void runtime.cancel(leaseId).catch(() => undefined); }; signal.addEventListener("abort", cancel, { once: true });
          let result: CodingCheckResult;
          try {
            signal.throwIfAborted(); await runtime.begin({ leaseId, taskSha256: await hostedTaskSha256(binding), stepId: toolStep, deadline: state.deadline, scope: binding.repository.scope, files: manifest, candidateSha256 });
            for (const file of manifest) { signal.throwIfAborted(); await runtime.file(leaseId, file.path, new TextDecoder("utf-8", { fatal: true }).decode(await files.bytes(file))); }
            signal.throwIfAborted(); result = await runtime.run(leaseId, args.id); signal.throwIfAborted();
            if (result.leaseId !== leaseId || result.stepId !== toolStep || result.candidateSha256 !== candidateSha256 || result.id !== args.id) throw new Error("coding-check-outcome-uncertain");
          } finally { signal.removeEventListener("abort", cancel); await runtime.cancel(leaseId); }
          output = { trust: "external-untrusted", instructionAuthority: "none", ...result };
          const encoded = safe(output, L.toolOutputBytes * 4);
          await journal.finish(toolStep, await hostedTaskSha256(output), { id: args.id, candidateSha256, exitCode: result.exitCode, outputSha256: await hostedTaskSha256(output), truncated: result.truncated });
          messages.push({ role: "tool", content: encoded, toolCallId: call.callId, toolName: call.tool }); continue;
        } else return await propose(call, "tool-outside-scope");
        signal.throwIfAborted(); const encoded = safe(output, L.toolOutputBytes);
        await journal.finish(toolStep, await hostedTaskSha256(output));
        messages.push({ role: "tool", content: encoded, toolCallId: call.callId, toolName: call.tool });
      }
    }
    throw new ProviderFailure("coding-model-limit", false);
  } catch (error) {
    if (error instanceof ScopeProposal) return await progress(error.proposal);
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(sent ? "coding-operation-outcome-uncertain" : "hosted-coding-runtime-required", sent);
  }
}
