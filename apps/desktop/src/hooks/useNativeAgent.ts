/**
 * Runs the Fable-owned native-API agent loop and routes its events into the shell.
 *
 * The TypeScript layer owns orchestration; Rust owns the key + HTTP/SSE egress.
 * This hook builds a TauriTransport (HttpTransport over the Rust boundary) when
 * the desktop runtime is present, runs runAgentLoop, and:
 *   - accumulates text deltas into the agent transcript
 *   - pushes tool-call approvals into the shell's approval queue (via onToolCall)
 *   - records usage for display
 *   - signals real cancellation to Rust on cancel
 *
 * Outside Tauri (no transport) the hook surfaces a no-transport notice so the UI
 * stays fixture-testable without a live socket.
 */

import { useCallback, useRef, useState } from "react";
import type { BackendAgentEvent, BackendProvider, NativeCompletionRequest } from "@fable/protocol";
import {
  runAgentLoop,
  shapeAnthropicRequest,
  shapeGeminiRequest,
  shapeOpenAiRequest,
  type HttpTransport
} from "@fable/connectors";
import {
  cancelRuntimeCompletion,
  listenRuntimeBackendEvents,
  streamRuntimeCompletion
} from "../runtime";

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

function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}

/** Build a transport that delegates egress to the Rust boundary. Null outside Tauri. */
function tauriTransport(): HttpTransport | null {
  if (!hasDesktopRuntime()) {
    return null;
  }
  return {
    async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queue: string[] = [];
      let resolveNext: ((value: string | undefined) => void) | null = null;
      let finished = false;

      const unlisten = await listenRuntimeBackendEvents(requestId, (line) => {
        if (line === "[DONE]" || line === "[CANCELLED]") {
          finished = true;
          resolveNext?.(undefined);
          return;
        }
        queue.push(line);
        resolveNext?.(line);
        resolveNext = null;
      });

      await streamRuntimeCompletion({
        providerId: request.providerId,
        requestId,
        model: request.model,
        body: shapeBodyFor(request)
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
      } finally {
        void unlisten?.();
      }
    }
  };
}

export interface NativeAgentState {
  transcript: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  running: boolean;
  lastError: string | null;
  /** True when there is no desktop runtime to carry the request. */
  noTransport: boolean;
}

export interface UseNativeAgentOptions {
  providers: BackendProvider[];
  /** Receives tool-call events so the shell can route them into its approval queue. */
  onToolCall?: (event: Extract<BackendAgentEvent, { type: "tool-call" }>) => void;
}

export function useNativeAgent(options: UseNativeAgentOptions) {
  const [state, setState] = useState<NativeAgentState>({
    transcript: "",
    usage: null,
    running: false,
    lastError: null,
    noTransport: !hasDesktopRuntime()
  });
  const cancelRef = useRef<string | null>(null);
  const onToolCallRef = useRef(options.onToolCall);
  onToolCallRef.current = options.onToolCall;

  const run = useCallback(async (request: NativeCompletionRequest, contextPrefix?: string) => {
    const transport = tauriTransport();
    if (!transport) {
      setState((current) => ({
        ...current,
        noTransport: true,
        lastError: "Native agent needs the desktop runtime."
      }));
      return;
    }
    setState({ transcript: "", usage: null, running: true, lastError: null, noTransport: false });
    const requestId = `req-${Date.now()}`;
    cancelRef.current = requestId;
    try {
      for await (const event of runAgentLoop(transport, request, {
        // The shell owns approval; the executor only runs after a grant. Until
        // the shell wires a real executor, tool calls surface as approvals and
        // execution refuses (fail-closed) rather than auto-running.
        execute: async () => {
          throw new Error("Tool execution pending approval in the shell.");
        },
        shouldCancel: () => false,
        contextPrefix
      })) {
        if (event.type === "text-delta") {
          setState((current) => ({ ...current, transcript: current.transcript + event.text }));
        } else if (event.type === "usage") {
          setState((current) => ({
            ...current,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd
            }
          }));
        } else if (event.type === "tool-call") {
          onToolCallRef.current?.(event);
        } else if (event.type === "error") {
          setState((current) => ({ ...current, lastError: event.message }));
        } else if (event.type === "done" || event.type === "cancelled") {
          setState((current) => ({ ...current, running: false }));
        }
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        running: false,
        lastError: error instanceof Error ? error.message : "Agent run failed."
      }));
    } finally {
      cancelRef.current = null;
    }
  }, []);

  const cancel = useCallback(async () => {
    if (cancelRef.current) {
      await cancelRuntimeCompletion(cancelRef.current);
    }
    setState((current) => ({ ...current, running: false }));
  }, []);

  return { state, run, cancel };
}
