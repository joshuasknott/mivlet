import type {
  BackendProvider,
  NativeCompletionRequest
} from "@fable/protocol";
import {
  BackendRuntimeError,
  classifyBackendError,
  shapeOllamaChatRequest,
  type HttpTransport,
  type TransportHandle,
  type TransportHandlers
} from "@fable/connectors";
import {
  cancelRuntimeLocalModelCompletion,
  listenRuntimeLocalModelEvents,
  streamRuntimeLocalModelCompletion
} from "../runtime";

interface LocalTransportControlPayload {
  kind: string;
  code?: string;
  message?: string;
  retryable?: boolean;
}

function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

function tauriLocalModelTransport(
  provider: BackendProvider,
  handlers: TransportHandlers
): HttpTransport | null {
  if (!hasDesktopRuntime()) return null;
  return {
    async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
      const requestId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queue: string[] = [];
      let resolveNext: ((value: string | undefined) => void) | null = null;
      let finished = false;
      let transportError: Error | null = null;

      const unlisten = await listenRuntimeLocalModelEvents(requestId, (line) => {
        if (line === "[CANCELLED]") {
          transportError = new BackendRuntimeError(
            "Local model request was cancelled.",
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
            __fableTransport?: LocalTransportControlPayload;
          };
          if (parsed.__fableTransport) {
            if (parsed.__fableTransport.kind === "error") {
              transportError = new BackendRuntimeError(
                parsed.__fableTransport.message ?? "Local model request failed.",
                parsed.__fableTransport.code ?? "transport",
                parsed.__fableTransport.retryable ?? false
              );
            } else if (parsed.__fableTransport.kind === "retrying") {
              handlers.onRetry();
            }
            return;
          }
        } catch {
          // Provider payloads are parsed by the Ollama stream parser.
        }
        queue.push(line);
        resolveNext?.(line);
        resolveNext = null;
      });

      handlers.onRequestStarted(requestId);
      const completion = streamRuntimeLocalModelCompletion({
        providerId: provider.id,
        requestId,
        model: request.model,
        body: shapeOllamaChatRequest(request)
      }).catch((error) => {
        if (!transportError) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string" && error.trim()
                ? error
                : "Local model request failed.";
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
}

export function createDesktopLocalModelTransport(
  provider: BackendProvider,
  handlers: TransportHandlers
): TransportHandle | null {
  const transport = tauriLocalModelTransport(provider, handlers);
  if (!transport) return null;
  return {
    transport,
    cancel: async (requestId) => {
      await cancelRuntimeLocalModelCompletion(requestId);
    }
  };
}
