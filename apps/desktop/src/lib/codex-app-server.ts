import type {
  CodexAppServerEvent,
  CodexAppServerHandle,
  CodexAppServerHandlers,
  CodexTurnRequest
} from "@fable/connectors";
import type { AgentRunRequest, BackendProvider } from "@fable/protocol";
import {
  getRuntimeCodexStatus,
  interruptRuntimeCodexTurn,
  listenRuntimeCodexEvents,
  respondRuntimeCodexApproval,
  shutdownRuntimeCodexTurn,
  startRuntimeCodexTurn
} from "../runtime";

function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

function requestId(): string {
  return `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCodexEvent(value: unknown): value is CodexAppServerEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

export function createDesktopCodexAppServer(
  provider: BackendProvider,
  handlers: CodexAppServerHandlers
): CodexAppServerHandle | null {
  if (!hasDesktopRuntime() || provider.backendType !== "codex-app-server") {
    return null;
  }

  const currentRequestId = requestId();
  let activeThreadId: string | null = null;
  let activeTurnId: string | null = null;

  return {
    async initialize() {
      const status = await getRuntimeCodexStatus();
      if (!status?.installed) {
        throw new Error(status?.message ?? "Codex CLI is not installed.");
      }
      handlers.onRequestStarted(currentRequestId);
    },

    async startThread(_request: AgentRunRequest) {
      activeThreadId = `pending-${currentRequestId}`;
      return { threadId: activeThreadId };
    },

    async resumeThread(threadId: string) {
      activeThreadId = threadId;
      return { threadId };
    },

    async *submitTurn(turn: CodexTurnRequest): AsyncIterable<CodexAppServerEvent> {
      const queue: CodexAppServerEvent[] = [];
      let resolveNext: ((value: CodexAppServerEvent | undefined) => void) | null = null;
      let finished = false;
      const unlisten = await listenRuntimeCodexEvents(currentRequestId, (event) => {
        if (event.type === "retrying") {
          handlers.onRetry();
          return;
        }
        if (event.type === "thread") {
          activeThreadId = event.threadId;
          return;
        }
        if (event.type === "turn") {
          activeTurnId = event.turnId;
          return;
        }
        if (event.type === "process-exited") {
          finished = true;
          resolveNext?.(undefined);
          return;
        }
        if (isCodexEvent(event)) {
          queue.push(event);
          resolveNext?.(event);
          resolveNext = null;
        }
      });

      const completion = startRuntimeCodexTurn({
        requestId: currentRequestId,
        providerId: provider.id,
        threadId: turn.threadId.startsWith("pending-") ? null : turn.threadId,
        request: turn.request,
        options: turn.options
      }).finally(() => {
        finished = true;
        resolveNext?.(undefined);
      });

      try {
        while (!finished || queue.length > 0) {
          if (queue.length > 0) {
            yield queue.shift() as CodexAppServerEvent;
          } else {
            const next = await new Promise<CodexAppServerEvent | undefined>((resolve) => {
              resolveNext = resolve;
            });
            if (!next && finished) break;
          }
        }
        await completion;
      } finally {
        void unlisten?.();
      }
    },

    async respondApproval(requestId, result) {
      await respondRuntimeCodexApproval({
        requestId: currentRequestId,
        approvalRequestId: requestId,
        result
      });
    },

    async cancel(threadId: string, turnId?: string) {
      await interruptRuntimeCodexTurn({
        requestId: currentRequestId,
        threadId,
        turnId: turnId ?? activeTurnId ?? undefined
      });
    },

    async shutdown() {
      await shutdownRuntimeCodexTurn(currentRequestId);
      activeThreadId = null;
      activeTurnId = null;
    }
  };
}
