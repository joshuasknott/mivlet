import type { AgentTurnOptions, AgentTurnRequest, BackendAgentEvent, BackendProvider } from "@mivlet/protocol";
import type { AgentBackend, BackendDeps, EmbeddedRuntimeHandle } from "../contract";
import { buildToolApproval } from "../../native-api/approvals";
import { lookupTool, registeredToolSpecs, CONNECTED_SOURCE_BRIEF_GUIDANCE, WEB_SOURCE_BRIEF_GUIDANCE } from "../../native-api/tools";
import { resolveModelCapabilities } from "../../native-api/model-catalogue";
import { supportsNativeComputerVision, computerVisionUnavailableReason } from "../../native-api/computer-vision";
import { effectForTool, evaluatePermissionPolicy } from "../../permission-policy";
import { backendErrorEvent } from "../utils/errors";
import { validateReasoningEffort } from "../../native-api/reasoning";

/** Adapts SDK execution to Mivlet's existing exact approval and effect boundary. */
export function createEmbeddedBackend(provider: BackendProvider, deps: BackendDeps): AgentBackend {
  const active = new Map<string, EmbeddedRuntimeHandle>();
  const stopped = new WeakSet<EmbeddedRuntimeHandle>();
  return {
    backend: provider, providerId: provider.id, capabilities: provider.capabilities,
    run(request: AgentTurnRequest, options: AgentTurnOptions) {
      const host = deps.createEmbeddedRuntime?.(provider);
      if (!host) return null;
      const attempt = options.attemptId ?? crypto.randomUUID();
      const shouldStop = () => stopped.has(host) || options.shouldCancel?.() === true;
      const model = provider.models.find(m => m.id === request.model);
      validateReasoningEffort(provider.id, model ?? { id: request.model, label: request.model, available: true }, request.reasoningEffort);
      const tools = resolveModelCapabilities(provider.id, model)?.tools === true
        && provider.capabilities.includes("tool-requests") && provider.capabilities.includes("approvals")
        ? (request.tools.length ? request.tools : registeredToolSpecs()).filter(tool => lookupTool(tool.name)
          && (!tool.name.startsWith("local-desktop-") || options.computer && supportsNativeComputerVision(provider.id, model))) : [];
      const mode = options.permissionMode ?? "full-access";
      const contextPrefix = [options.contextPrefix, computerVisionUnavailableReason(provider, model),
        tools.some(t => t.name === "connection-read") ? CONNECTED_SOURCE_BRIEF_GUIDANCE : undefined,
        tools.some(t => t.name === "web-fetch") ? WEB_SOURCE_BRIEF_GUIDANCE : undefined].filter(Boolean).join("\n\n");
      if (active.has(attempt)) throw new Error("This agent attempt is already running.");
      active.set(attempt, host);
      return (async function* (): AsyncIterable<BackendAgentEvent> {
        const seen = new Set<string>();
        try {
          if (shouldStop()) { yield { type: "cancelled" }; return; }
          for await (const event of host.run({ ...request, tools }, { ...options, contextPrefix })) {
            if (shouldStop()) { yield { type: "cancelled" }; return; }
            if (event.type === "retrying") {
              options.onRetry?.();
              continue;
            }
            if (event.type !== "tool-request") {
              yield event;
              if (event.type === "done" || event.type === "cancelled" || event.type === "error") return;
              continue;
            }
            if (!/^[a-zA-Z0-9_-]{1,160}$/.test(event.callId) || seen.has(event.callId)
              || !tools.some(tool => tool.name === event.tool) || event.arguments.length > 64_000
              || seen.size >= (options.maxToolCalls ?? 32)) throw new Error("The SDK returned an invalid or replayed tool call.");
            seen.add(event.callId);
            const args: unknown = JSON.parse(event.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments.");
            if (event.tool.startsWith("local-desktop-") && !event.approvalId) throw new Error("Native computer call binding is missing.");
            const approval = { ...buildToolApproval(provider.id, event.tool, event.arguments),
              id: event.approvalId ?? `native-${attempt}-${event.callId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 160),
              requestedAt: new Date().toISOString() };
            yield { type: "tool-call", callId: event.callId, tool: event.tool, arguments: event.arguments, approval };
            let ok = false, output: string;
            try {
              const effect = effectForTool(event.tool);
              if (!effect || !evaluatePermissionPolicy({ mode, effect, riskLevel: approval.riskLevel }).allowed) throw new Error(`Permission denied: ${mode} profile forbids ${event.tool}.`);
              if (shouldStop()) { yield { type: "cancelled" }; return; }
              output = await options.execute(approval, event.arguments); ok = true;
            } catch (error) { output = error instanceof Error ? error.message : "Tool execution failed."; }
            if (shouldStop()) { yield { type: "cancelled" }; return; }
            const configuredLimit = options.maxToolOutputCharacters ?? 64_000;
            const limit = Number.isFinite(configuredLimit)
              ? Math.max(0, Math.min(64_000, Math.floor(configuredLimit)))
              : 0;
            if (output.length > limit) {
              const marker = "[Tool output truncated by Mivlet.]";
              output = limit <= marker.length
                ? marker.slice(0, limit)
                : output.slice(0, limit - marker.length - 1) + `\n${marker}`;
            }
            yield { type: "tool-result", callId: event.callId, ok, output };
            await host.reply(event.callId, ok, output);
          }
        } catch (error) { yield backendErrorEvent(error, "Embedded agent failed."); yield { type: "done", finishReason: "error" }; }
        finally { await host.cancel(); if (active.get(attempt) === host) active.delete(attempt); }
      })();
    },
    async cancel(id) {
      for (const [attempt, host] of active) if (attempt === id || attempt.startsWith(`${id}:worker:`)) {
        stopped.add(host);
        await host.cancel();
      }
    },
    async listModels() { return await deps.discoverModels?.(provider.id) ?? { outcome: "unsupported", models: [] }; },
  };
}
