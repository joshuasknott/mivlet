import type {
  ManagedRuntimeEvent,
  ManagedRuntimeHandle,
  ManagedRuntimeHandlers,
} from "@fable/connectors";
import type { AgentTurnRequest, BackendProvider } from "@fable/protocol";
import {
  getRuntimeManagedStatus,
  interruptRuntimeManagedTurn,
  listenRuntimeManagedEvents,
  respondRuntimeManagedApproval,
  shutdownRuntimeManagedTurn,
  startRuntimeManagedTurn,
  type ManagedRuntimeProviderId,
} from "../runtime";

const MANAGED_PROVIDER_IDS = new Set<ManagedRuntimeProviderId>([
  "claude",
  "cursor",
  "grok",
  "opencode",
]);

function hasDesktopRuntime() {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

function nextRequestId(providerId: string) {
  return `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isManagedRuntimeEvent(value: unknown): value is ManagedRuntimeEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  return (
    type === "text-delta" ||
    type === "approval-request" ||
    type === "approval-result" ||
    type === "usage" ||
    type === "done" ||
    type === "error" ||
    type === "cancelled"
  );
}

export function createDesktopManagedRuntime(
  provider: BackendProvider,
  handlers: ManagedRuntimeHandlers,
): ManagedRuntimeHandle | null {
  if (
    !hasDesktopRuntime() ||
    !MANAGED_PROVIDER_IDS.has(provider.id as ManagedRuntimeProviderId)
  ) {
    return null;
  }
  const providerId = provider.id as ManagedRuntimeProviderId;
  const requestId = nextRequestId(providerId);
  return {
    async initialize() {
      const status = await getRuntimeManagedStatus(providerId);
      if (!status?.installed) {
        throw new Error(
          status?.message ?? `${provider.label} is not installed.`,
        );
      }
      if (!status.authenticated) {
        throw new Error(
          `Connect ${provider.label} before starting a conversation.`,
        );
      }
      handlers.onRequestStarted(requestId);
    },
    async *submitTurn(
      request: AgentTurnRequest,
      options,
    ): AsyncIterable<ManagedRuntimeEvent> {
      const queue: ManagedRuntimeEvent[] = [];
      let finished = false;
      let resolveNext: ((event?: ManagedRuntimeEvent) => void) | null = null;
      const unlisten = await listenRuntimeManagedEvents(
        providerId,
        requestId,
        (event) => {
          if (event.type === "process-exited") {
            finished = true;
            resolveNext?.();
            return;
          }
          if (!isManagedRuntimeEvent(event)) return;
          queue.push(event);
          resolveNext?.(event);
          resolveNext = null;
          if (
            event.type === "done" ||
            event.type === "error" ||
            event.type === "cancelled"
          ) {
            finished = true;
          }
        },
      );
      try {
        await startRuntimeManagedTurn({
          requestId,
          providerId,
          request,
          options: {
            contextPrefix: options.contextPrefix,
            permissionMode: options.permissionMode,
            runId: options.attemptId,
          },
        });
        while (!finished || queue.length) {
          if (queue.length) {
            yield queue.shift() as ManagedRuntimeEvent;
          } else {
            const next = await new Promise<ManagedRuntimeEvent | undefined>(
              (resolve) => {
                resolveNext = resolve;
              },
            );
            if (!next && finished) break;
          }
        }
      } finally {
        void unlisten?.();
      }
    },
    async respondApproval(approvalRequestId, approved) {
      await respondRuntimeManagedApproval({
        requestId,
        approvalRequestId,
        approved,
      });
    },
    async cancel() {
      await interruptRuntimeManagedTurn(requestId);
    },
    async shutdown() {
      await shutdownRuntimeManagedTurn(requestId);
    },
  };
}
