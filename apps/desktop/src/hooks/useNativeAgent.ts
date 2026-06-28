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

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackendAgentEvent,
  BackendProvider,
  NativeCompletionRequest,
  PersistedAgentRun,
  PermissionMode
} from "@fable/protocol";
import {
  runAgentLoop,
  shapeAnthropicRequest,
  shapeGeminiRequest,
  shapeOpenAiRequest,
  type HttpTransport,
  type ToolExecutor
} from "@fable/connectors";
import { permissionModeFor } from "../lib/agent-run";
import {
  cancelRuntimeCompletion,
  listenRuntimeBackendEvents,
  recoverRuntimeAgentRuns,
  saveRuntimeAgentRun,
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
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/** Build a transport that delegates egress to the Rust boundary. Null outside Tauri. */
function tauriTransport(
  onRequestStarted: (requestId: string) => void,
  onRetry: () => void
): HttpTransport | null {
  if (!hasDesktopRuntime()) {
    return null;
  }
  return {
    async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queue: string[] = [];
      let resolveNext: ((value: string | undefined) => void) | null = null;
      let finished = false;
      let transportError: Error | null = null;

      const unlisten = await listenRuntimeBackendEvents(requestId, (line) => {
        if (line === "[DONE]" || line === "[CANCELLED]") {
          finished = true;
          resolveNext?.(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(line) as {
            __fableTransport?: { kind: string; message: string };
          };
          if (parsed.__fableTransport) {
            if (parsed.__fableTransport.kind === "error") {
              transportError = new Error(parsed.__fableTransport.message);
            } else if (parsed.__fableTransport.kind === "retrying") {
              onRetry();
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

      onRequestStarted(requestId);
      // Tauri commands resolve when the Rust future finishes. Start the command
      // without awaiting it so events are yielded to the UI as they arrive.
      const completion = streamRuntimeCompletion({
        providerId: request.providerId,
        requestId,
        model: request.model,
        body: shapeBodyFor(request)
      }).catch((error) => {
        transportError = error instanceof Error ? error : new Error("Provider request failed.");
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
  /**
   * The real tool executor, wired to the shell's shared approval gate + the Rust
   * boundary. When omitted the loop uses a fail-closed stub (tool calls surface
   * as approvals and execution refuses) — this is the pre-tool-execution behavior
   * and keeps the hook fixture-testable without a live approval gate.
   */
  execute?: ToolExecutor;
  /**
   * Cooperative cancellation hook, checked between events. When omitted the loop
   * can never be cooperatively cancelled mid-turn (real in-flight cancellation
   * still happens at the Rust boundary via cancel()). App.tsx wires this to a
   * cancel flag so an in-flight loop can bail between events.
   */
  shouldCancel?: () => boolean;
  /**
   * Invoked once when a run is cancelled, so the shell can tear down any
   * tool-call still awaiting approval on the shared gate (gate.cancelPending()).
   * This prevents cancelled-but-never-granted calls (and their unresolved
   * promises) from lingering for the session. Cooperative cancel + the Rust
   * boundary drop stay intact — this is the gate-teardown layer on top.
   */
  onCancel?: () => void;
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
  // The executor + cancellation hook are read live each run so App.tsx can wire
  // the real (approval-gated) executor + cancel path without re-creating the hook.
  const executeRef = useRef(options.execute);
  executeRef.current = options.execute;
  const shouldCancelRef = useRef(options.shouldCancel);
  shouldCancelRef.current = options.shouldCancel;
  const onCancelRef = useRef(options.onCancel);
  onCancelRef.current = options.onCancel;

  useEffect(() => {
    void recoverRuntimeAgentRuns(new Date().toISOString());
  }, []);

  const run = useCallback(
    async (
      request: NativeCompletionRequest,
      contextPrefix?: string,
      permissionLabel?: string
    ) => {
      let persisted: PersistedAgentRun | null = null;
      const transport = tauriTransport(
        (requestId) => {
          cancelRef.current = requestId;
        },
        () => {
          if (!persisted) return;
          persisted = {
            ...persisted,
            status: "retrying",
            retryCount: persisted.retryCount + 1,
            updatedAt: new Date().toISOString()
          };
          void saveRuntimeAgentRun(persisted);
        }
      );
      if (!transport) {
        setState((current) => ({
          ...current,
          noTransport: true,
          lastError: "Native agent needs the desktop runtime."
        }));
        return;
      }
      setState({ transcript: "", usage: null, running: true, lastError: null, noTransport: false });
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      persisted = {
        id: runId,
        providerId: request.providerId,
        model: request.model,
        status: "streaming",
        transcript: "",
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt,
        updatedAt: createdAt
      };
      await saveRuntimeAgentRun(persisted);
      let lastPersistedTranscriptLength = 0;
      let lastPersistedAt = Date.now();
      const pendingApprovalByCall = new Map<string, string>();
      // Map the composer's permission-level label to a PermissionMode that gates
      // tool execution in the loop (read-only suppresses write/shell, etc.).
      const permissionMode: PermissionMode = permissionLabel
        ? permissionModeFor(permissionLabel)
        : "full-access";
      try {
        for await (const event of runAgentLoop(transport, request, {
          // The real executor is wired by App.tsx from the shell's shared
          // approval gate + the Rust tool boundary; until then (or in tests)
          // the fail-closed stub keeps tool calls surfacing as approvals that
          // refuse to execute. The permission mode still gates which tool calls
          // may reach the executor.
          execute:
            executeRef.current ??
            (async () => {
              throw new Error("Tool execution pending approval in the shell.");
            }),
          shouldCancel: shouldCancelRef.current ?? (() => false),
          contextPrefix,
          permissionMode
        })) {
          if (event.type === "text-delta") {
            setState((current) => ({ ...current, transcript: current.transcript + event.text }));
            persisted = {
              ...persisted,
              transcript: persisted.transcript + event.text,
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "usage") {
            setState((current) => ({
              ...current,
              usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: event.costUsd
              }
            }));
            persisted = {
              ...persisted,
              usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: event.costUsd
              },
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "tool-call") {
            onToolCallRef.current?.(event);
            pendingApprovalByCall.set(event.callId, event.approval.id);
            persisted = {
              ...persisted,
              status: "awaiting-approval",
              pendingApprovalIds: [...persisted.pendingApprovalIds, event.approval.id],
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "tool-result") {
            const completedApprovalId = pendingApprovalByCall.get(event.callId);
            pendingApprovalByCall.delete(event.callId);
            persisted = {
              ...persisted,
              status: "streaming",
              turn: persisted.turn + 1,
              pendingApprovalIds: persisted.pendingApprovalIds.filter(
                (id) => id !== completedApprovalId
              ),
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "error") {
            setState((current) => ({ ...current, lastError: event.message }));
            persisted = {
              ...persisted,
              error: event.message,
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "done" || event.type === "cancelled") {
            setState((current) => ({ ...current, running: false }));
            persisted = {
              ...persisted,
              status: event.type === "cancelled" ? "cancelled" : "completed",
              recoverable: false,
              pendingApprovalIds: [],
              updatedAt: new Date().toISOString()
            };
          }
          const terminalOrBoundary =
            event.type !== "text-delta" ||
            persisted.transcript.length - lastPersistedTranscriptLength >= 512 ||
            Date.now() - lastPersistedAt >= 1_000;
          if (terminalOrBoundary) {
            await saveRuntimeAgentRun(persisted);
            lastPersistedTranscriptLength = persisted.transcript.length;
            lastPersistedAt = Date.now();
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent run failed.";
        setState((current) => ({
          ...current,
          running: false,
          lastError: message
        }));
        persisted = {
          ...persisted,
          status: shouldCancelRef.current?.() ? "cancelled" : "failed",
          recoverable: !shouldCancelRef.current?.(),
          error: message,
          updatedAt: new Date().toISOString()
        };
        await saveRuntimeAgentRun(persisted);
      } finally {
        cancelRef.current = null;
      }
    },
    []
  );

  const cancel = useCallback(async () => {
    if (cancelRef.current) {
      await cancelRuntimeCompletion(cancelRef.current);
    }
    // Tear down any tool-call still awaiting approval on the shared gate so a
    // cancelled-but-never-granted call (and its unresolved promise) does not
    // linger for the session. No-op when no onCancel is wired.
    onCancelRef.current?.();
    setState((current) => ({ ...current, running: false }));
  }, []);

  /**
   * Surface a pre-run validation error (e.g. an invalid model selection) through
   * the same `lastError` channel the UI renders for run failures, without
   * starting a run. Used so {@link validateModelSelection} can fail fast before
   * the loop opens a socket.
   */
  const reportError = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      running: false,
      lastError: message,
      transcript: "",
      usage: null
    }));
  }, []);

  return { state, run, cancel, reportError };
}
