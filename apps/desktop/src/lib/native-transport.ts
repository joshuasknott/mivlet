/**
 * Desktop transport factory for the native-API `AgentBackend`.
 *
 * This is the production `BackendDeps.createTransport` implementation: it builds
 * an {@link HttpTransport} that delegates HTTP/SSE egress to the Rust boundary
 * (Rust owns the API key + the actual socket). It is kept here, outside the hook,
 * so `useNativeAgent` can treat the backend as a provider-neutral `AgentBackend`
 * without knowing about provider ids, SSE channels, or Tauri events.
 *
 * SECRET INVARIANT: this module handles NO secret. `shapeBodyFor` builds the
 * provider-shaped request body with NO key; Rust adds the
 * Authorization/x-api-key/x-goog-api-key header from the keychain inside
 * `stream_backend_completion`. The TS side is key-free end to end.
 */

import type {
  BackendProvider,
  NativeCompletionRequest
} from "@fable/protocol";
import {
  BackendRuntimeError,
  classifyBackendError,
  shapeAnthropicRequest,
  shapeGeminiRequest,
  shapeOpenAiRequest,
  type HttpTransport,
  type TransportHandle,
  type TransportHandlers
} from "@fable/connectors";
import { cancelRuntimeCompletion, beginRuntimeComputerSession, endRuntimeComputerSession, listenRuntimeBackendEvents, streamRuntimeCompletion } from "../runtime/domains/providers";

/** Shape the request body for the provider; the loop sends a NativeCompletionRequest. */
function shapeBodyFor(request: NativeCompletionRequest): unknown {
  if (request.providerId === "anthropic") {
    return shapeAnthropicRequest(request);
  }
  if (request.providerId === "gemini") {
    return shapeGeminiRequest(request);
  }
  return shapeOpenAiRequest(request);
}

interface NativeTransportControlPayload {
  kind: string;
  code?: string;
  message?: string;
  retryable?: boolean;
}

/** True when the desktop (Tauri) runtime is present. */
function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/**
 * Build a transport that delegates egress to the Rust boundary. Returns null
 * when there is no desktop runtime (browser preview), so the backend reports
 * no-transport and the hook surfaces that to the UI.
 */
function tauriTransport(
  provider: BackendProvider,
  handlers: TransportHandlers
): TransportHandle | null {
  if (!hasDesktopRuntime()) {
    return null;
  }
  let computerSession: string | undefined;
  let openingComputerSession: Promise<string> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const approvalIds = new Map<string, string>();
  const shutdown = () => {
    closed = true;
    approvalIds.clear();
    closing ??= (async () => {
      const session = computerSession ?? await openingComputerSession?.catch(() => undefined);
      if (session) await endRuntimeComputerSession(session);
      computerSession = undefined;
    })();
    return closing;
  };
  const transport: HttpTransport = {
    toolApprovalId: callId => approvalIds.get(callId),
    async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
      if (closed) throw new BackendRuntimeError("Provider request was cancelled.", "cancelled", false);
      if (request.tools.some(tool => tool.name.startsWith("local-desktop-")) && !computerSession) {
        if (!request.computer || !request.providerRoute) throw new Error("Screenshot delivery requires an exact computer scope and provider route.");
        openingComputerSession = beginRuntimeComputerSession({
          providerId: provider.id, model: request.model, computer: request.computer, providerRoute: request.providerRoute,
        });
        computerSession = await openingComputerSession;
        if (closed) {
          await shutdown();
          throw new BackendRuntimeError("Provider request was cancelled.", "cancelled", false);
        }
      }
      approvalIds.clear();
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queue: string[] = [];
      let resolveNext: ((value: string | undefined) => void) | null = null;
      let finished = false;
      let transportError: Error | null = null;

      const unlisten = await listenRuntimeBackendEvents(requestId, (line) => {
        if (line === "[CANCELLED]") {
          transportError = new BackendRuntimeError(
            "Provider request was cancelled.",
            "cancelled",
            false
          );
          finished = true;
          resolveNext?.(undefined);
          return;
        }
        if (line === "[DONE]") {
          finished = true;
          resolveNext?.(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(line) as {
            __fableTransport?: NativeTransportControlPayload;
            __fableComputerTool?: { callId?: string; approvalId?: string };
          };
          if (parsed.__fableComputerTool) {
            const { callId, approvalId } = parsed.__fableComputerTool;
            if (computerSession && typeof callId === "string" && typeof approvalId === "string"
              && /^api-visual-[a-f0-9]{48}$/.test(approvalId)) approvalIds.set(callId, approvalId);
            return;
          }
          if (parsed.__fableTransport) {
            if (parsed.__fableTransport.kind === "error") {
              transportError = new BackendRuntimeError(
                parsed.__fableTransport.message ?? "Provider request failed.",
                parsed.__fableTransport.code ?? "transport",
                parsed.__fableTransport.retryable ?? false
              );
            } else if (parsed.__fableTransport.kind === "retrying") {
              handlers.onRetry();
            }
            return;
          }
        } catch {
          // Provider payloads are parsed by their provider-specific stream parser.
        }
        queue.push(line);
        resolveNext?.(line);
        resolveNext = null;
      });

      handlers.onRequestStarted(requestId);
      if (closed) {
        void unlisten?.();
        throw new BackendRuntimeError("Provider request was cancelled.", "cancelled", false);
      }
      // Tauri commands resolve when the Rust future finishes. Start the command
      // without awaiting it so events are yielded to the UI as they arrive.
      const completion = streamRuntimeCompletion({
        providerId: provider.id,
        requestId,
        model: request.model,
        body: shapeBodyFor(request),
        ...(computerSession ? { computerSessionId: computerSession } : {}),
        ...(request.providerRoute ? { providerRoute: request.providerRoute } : {})
      }).catch((error) => {
        if (!transportError) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string" && error.trim()
                ? error
                : "Provider request failed.";
          const classified = classifyBackendError(message);
          transportError = new BackendRuntimeError(
            message,
            classified.code,
            classified.retryable
          );
        }
        finished = true;
        resolveNext?.(undefined);
      });

      try {
        while (!finished || queue.length > 0) {
          if (queue.length > 0) {
            yield queue.shift() as string;
          } else if (!finished) {
            const next = await new Promise<string | undefined>((resolve) => {
              resolveNext = resolve;
            });
            if (!next && finished) break;
          } else {
            break;
          }
        }
        await completion;
        if (transportError) throw transportError;
      } finally {
        void unlisten?.();
      }
    }
  };
  return {
    transport,
    cancel: async requestId => {
      await shutdown();
      await cancelRuntimeCompletion(requestId);
    },
    shutdown,
  };
}

/**
 * The production `BackendDeps.createTransport` for the desktop shell. Returns
 * a {@link TransportHandle} (transport + cancel) or null in browser preview.
 */
export function createDesktopTransport(
  provider: BackendProvider,
  handlers: TransportHandlers
): TransportHandle | null {
  return tauriTransport(provider, handlers);
}
