import type {
  AgentTurnOptions,
  AgentTurnRequest,
  BackendAgentEvent,
  BackendProvider,
} from "@fable/protocol";
import type {
  AgentBackend,
  BackendDeps,
  ManagedRuntimeHandle,
} from "../contract";
import { backendErrorEvent } from "../utils/errors";
import { redactSecretsFromString } from "../utils/redact";
import { computerVisionUnavailableReason } from "../../native-api/computer-vision";

const PROVIDER_OWNED_DRIVERS = new Set([
  "claude-agent",
  "cursor-acp",
  "grok-acp",
  "opencode",
]);

/** Normalize a provider-owned process into Mivlet's one agent event stream. */
export function createManagedRuntimeBackend(
  provider: BackendProvider,
  deps: BackendDeps,
): AgentBackend | null {
  if (!provider.driverKind || !PROVIDER_OWNED_DRIVERS.has(provider.driverKind))
    return null;
  let active: ManagedRuntimeHandle | null = null;

  function run(
    request: AgentTurnRequest,
    options: AgentTurnOptions,
  ): AsyncIterable<BackendAgentEvent> | null {
    const handle = deps.createManagedRuntime?.(provider, {
      onRequestStarted: () => {},
    });
    if (!handle || !provider.capabilities.includes("streaming")) return null;
    const liveHandle: ManagedRuntimeHandle = handle;

    async function* stream(): AsyncIterable<BackendAgentEvent> {
      active = liveHandle;
      try {
        await liveHandle.initialize();
        for await (const event of liveHandle.submitTurn(request, {
          contextPrefix: [options.contextPrefix, options.computer && computerVisionUnavailableReason(provider, provider.models.find(model => model.id === request.model))].filter(Boolean).join("\n\n"),
          permissionMode: options.permissionMode,
          attemptId: options.attemptId,
        })) {
          if (options.shouldCancel?.()) {
            await liveHandle.cancel();
            yield { type: "cancelled" };
            return;
          }
          if (event.type === "usage") {
            yield {
              ...event,
              costUsd: event.costUsd ?? 0,
              ...(event.costUsd === undefined ? { costUnknown: true } : {}),
            };
          } else if (
            event.type === "text-delta" ||
            event.type === "done" ||
            event.type === "cancelled"
          ) {
            yield event;
            if (event.type === "done" || event.type === "cancelled") return;
          } else if (event.type === "error") {
            yield {
              type: "error",
              message: redactSecretsFromString(event.message),
            };
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
              yield {
                type: "tool-result",
                callId: event.callId,
                ok: false,
                output: `Blocked by Mivlet's ${options.permissionMode} permission mode.`,
              };
              continue;
            }
            yield {
              type: "tool-call",
              callId: event.callId,
              tool: event.tool,
              arguments: event.arguments,
              approval: event.approval,
            };
            let authorized = false;
            try {
              if (!options.authorize) {
                throw new Error(
                  `${provider.label} permission approval is not connected to the shell.`,
                );
              }
              await options.authorize(event.approval);
              authorized = true;
              await liveHandle.respondApproval(event.requestId, true);
              yield {
                type: "tool-result",
                callId: event.callId,
                ok: true,
                output: `Approved for ${provider.label} to execute once.`,
              };
            } catch (error) {
              let deliveryFailed = authorized;
              if (!authorized) {
                try {
                  await liveHandle.respondApproval(event.requestId, false);
                } catch {
                  deliveryFailed = true;
                }
              }
              const message =
                error instanceof Error
                  ? redactSecretsFromString(error.message)
                  : "Permission denied.";
              yield {
                type: "tool-result",
                callId: event.callId,
                ok: false,
                output: message,
              };
              if (deliveryFailed) {
                await liveHandle.cancel().catch(() => undefined);
                yield { type: "error", message };
                yield { type: "done", finishReason: "error" };
                return;
              }
            }
          }
        }
      } catch (error) {
        yield backendErrorEvent(error, `${provider.label} runtime failed.`);
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
    cancel: async () => {
      await active?.cancel();
      active = null;
    },
    listModels: async () =>
      (await deps.discoverModels?.(provider.id)) ?? {
        outcome: "unsupported",
        models: [],
      },
  };
}
