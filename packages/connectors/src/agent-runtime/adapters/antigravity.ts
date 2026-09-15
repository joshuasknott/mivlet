import type {
  AgentTurnOptions,
  AgentTurnRequest,
  BackendAgentEvent,
  BackendProvider
} from "@mivlet/protocol";
import type { AgentBackend, AntigravityAcpHandle, BackendDeps } from "../contract";
import { backendErrorEvent } from "../utils/errors";
import { redactSecretsFromString } from "../utils/redact";
import { computerVisionUnavailableReason } from "../../native-api/computer-vision";

export function createAntigravityBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  let active: AntigravityAcpHandle | null = null;

  function run(request: AgentTurnRequest, options: AgentTurnOptions): AsyncIterable<BackendAgentEvent> | null {
    const handle = deps.createAntigravityAcp?.(provider, { onRequestStarted: () => {} });
    if (!handle || !provider.capabilities.includes("streaming")) return null;
    const liveHandle: AntigravityAcpHandle = handle;

    async function* stream(): AsyncIterable<BackendAgentEvent> {
      active = liveHandle;
      try {
        await liveHandle.initialize();
        for await (const event of liveHandle.submitTurn(request, {
          contextPrefix: [options.contextPrefix, options.computer && computerVisionUnavailableReason(provider, provider.models.find(model => model.id === request.model))].filter(Boolean).join("\n\n"),
          permissionMode: options.permissionMode,
          attemptId: options.attemptId
        })) {
          if (options.shouldCancel?.()) {
            await liveHandle.cancel();
            yield { type: "cancelled" };
            return;
          }
          if (event.type === "text-delta" || event.type === "done" || event.type === "cancelled") {
            yield event;
            if (event.type === "done" || event.type === "cancelled") return;
          } else if (event.type === "error") {
            yield { type: "error", message: redactSecretsFromString(event.message) };
            yield { type: "done", finishReason: "error" };
            return;
          } else if (event.type === "approval-request") {
            const kind = event.tool.split(":", 2)[1] ?? "other";
            const blockedByMode =
              options.permissionMode === "read-only"
                ? !["read", "search", "fetch"].includes(kind)
                : options.permissionMode === "trusted-scope"
                  ? ["execute", "delete", "move", "other"].includes(kind)
                  : false;
            if (blockedByMode) {
              await liveHandle.respondApproval(event.requestId, false);
              yield { type: "tool-result", callId: event.callId, ok: false, output: `Blocked by Mivlet's ${options.permissionMode} permission mode.` };
              continue;
            }
            yield { type: "tool-call", callId: event.callId, tool: event.tool, arguments: event.arguments, approval: event.approval };
            try {
              if (!options.authorize) throw new Error("Antigravity permission approval is not connected to the shell.");
              await options.authorize(event.approval);
              await liveHandle.respondApproval(event.requestId, true);
              yield { type: "tool-result", callId: event.callId, ok: true, output: "Approved for Antigravity to execute once." };
            } catch (error) {
              await liveHandle.respondApproval(event.requestId, false);
              yield { type: "tool-result", callId: event.callId, ok: false, output: error instanceof Error ? redactSecretsFromString(error.message) : "Permission denied." };
            }
          }
        }
      } catch (error) {
        yield backendErrorEvent(error, "Antigravity ACP run failed.");
        yield { type: "done", finishReason: "error" };
      } finally {
        await liveHandle.shutdown();
        if (active === liveHandle) active = null;
      }
    }
    return stream();
  }

  return {
    backend: provider,
    providerId: provider.id,
    capabilities: provider.capabilities,
    run,
    cancel: async () => { await active?.cancel(); active = null; },
    listModels: async () => (await deps.discoverModels?.(provider.id)) ?? { outcome: "unsupported", models: [] }
  };
}
