import type {
  CodexAppServerEvent,
  CodexAppServerHandle,
  CodexAppServerHandlers,
  CodexTurnRequest
} from "@fable/connectors";
import type { AgentTurnRequest, BackendProvider } from "@fable/protocol";
import {
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
      // The provider was verified when connected. Native turn startup checks
      // the executable and the server reports current auth failures; spawning
      // --version and login status for every message adds two avoidable starts.
      handlers.onRequestStarted(currentRequestId);
    },

    async startThread(_request: AgentTurnRequest) {
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
      const finish = () => {
        finished = true;
        resolveNext?.(undefined);
        resolveNext = null;
      };
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
          finish();
          return;
        }
        if (isCodexEvent(event)) {
          queue.push(event);
          resolveNext?.(event);
          resolveNext = null;
          if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
            finished = true;
          }
        }
      });

      try {
        // The native command acknowledges process startup immediately; it does
        // not represent turn completion. Keep listening until the app-server
        // emits a terminal turn event or the supervised process exits.
        await startRuntimeCodexTurn({
          requestId: currentRequestId,
          providerId: provider.id,
          threadId: turn.threadId.startsWith("pending-") ? null : turn.threadId,
          request: turn.request,
          options: turn.options
        });
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
        threadId: activeThreadId ?? threadId,
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
