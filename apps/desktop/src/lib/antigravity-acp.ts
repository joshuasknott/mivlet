import type {
  AntigravityAcpEvent,
  AntigravityAcpHandle,
  AntigravityAcpHandlers
} from "@fable/connectors";
import type { AgentTurnRequest, BackendProvider } from "@fable/protocol";
import { getRuntimeAntigravityStatus, interruptRuntimeAntigravityTurn, listenRuntimeAntigravityEvents, respondRuntimeAntigravityApproval, shutdownRuntimeAntigravityTurn, startRuntimeAntigravityTurn } from "../runtime/domains/providers";

function hasDesktopRuntime() {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function nextRequestId() {
  return `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDesktopAntigravityAcp(provider: BackendProvider, handlers: AntigravityAcpHandlers): AntigravityAcpHandle | null {
  if (!hasDesktopRuntime() || provider.backendType !== "antigravity-acp") return null;
  const requestId = nextRequestId();
  return {
    async initialize() {
      const status = await getRuntimeAntigravityStatus();
      if (!status?.installed) throw new Error(status?.message ?? "Antigravity ACP is not installed.");
      if (!status.authenticated) throw new Error("Connect Antigravity with Google before starting a conversation.");
      handlers.onRequestStarted(requestId);
    },
    async *submitTurn(request: AgentTurnRequest, options): AsyncIterable<AntigravityAcpEvent> {
      const queue: AntigravityAcpEvent[] = [];
      let finished = false;
      let resolveNext: ((event?: AntigravityAcpEvent) => void) | null = null;
      const unlisten = await listenRuntimeAntigravityEvents(requestId, (event) => {
        if (event.type === "process-exited") { finished = true; resolveNext?.(); return; }
        queue.push(event as AntigravityAcpEvent);
        resolveNext?.(event as AntigravityAcpEvent);
        resolveNext = null;
        if (event.type === "done" || event.type === "error" || event.type === "cancelled") finished = true;
      });
      try {
        await startRuntimeAntigravityTurn({ requestId, providerId: provider.id, request, options: { contextPrefix: options.contextPrefix, permissionMode: options.permissionMode, runId: options.attemptId } });
        while (!finished || queue.length) {
          if (queue.length) yield queue.shift() as AntigravityAcpEvent;
          else {
            const next = await new Promise<AntigravityAcpEvent | undefined>((resolve) => { resolveNext = resolve; });
            if (!next && finished) break;
          }
        }
      } finally { void unlisten?.(); }
    },
    async respondApproval(approvalRequestId, approved) { await respondRuntimeAntigravityApproval({ requestId, approvalRequestId, approved }); },
    async cancel() { await interruptRuntimeAntigravityTurn(requestId); },
    async shutdown() { await shutdownRuntimeAntigravityTurn(requestId); }
  };
}
