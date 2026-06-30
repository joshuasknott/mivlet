/**
 * Runs a provider-neutral `AgentBackend` and routes its events into the shell.
 *
 * The hook resolves the connected backend to an `AgentBackend` via
 * `resolveAgentBackend` (native API, Codex app-server, and ACP have live
 * adapters; Copilot remains metadata-only). It then runs the backend, consuming
 * the universal `BackendAgentEvent` stream, and:
 *   - accumulates text deltas into the agent transcript
 *   - pushes tool-call approvals into the shell's approval queue (via onToolCall)
 *   - records usage for display
 *   - signals real cancellation to the backend (which drops it at egress)
 *
 * The provider-id wire-family details (request shaping, SSE parsing, the Tauri
 * transport) live inside the native-API adapter + `createDesktopTransport`, not
 * here — so this hook is provider-neutral. Outside the desktop runtime the hook
 * surfaces a no-transport notice so the UI stays fixture-testable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRunRequest,
  BackendAgentEvent,
  BackendModel,
  BackendProvider,
  PersistedAgentExchange,
  PersistedAgentRun,
  PermissionMode
} from "@fable/protocol";
import {
  resolveAgentBackend,
  type AgentBackend,
  type BackendDeps,
  type ToolExecutor
} from "@fable/connectors";
import { permissionModeFor } from "../lib/agent-run";
import { describeBackendError } from "../lib/backend-errors";
import { createDesktopAcpTransport } from "../lib/acp-transport";
import { createDesktopCodexAppServer } from "../lib/codex-app-server";
import { createDesktopTransport } from "../lib/native-transport";
import {
  listRuntimeBackendModels,
  recoverRuntimeAgentRuns,
  saveRuntimeAgentRun
} from "../runtime";

/** True when the desktop (Tauri) runtime is present (drives the noTransport state). */
function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

export interface NativeAgentState {
  transcript: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costEstimated?: boolean;
  } | null;
  running: boolean;
  lastError: string | null;
  status: PersistedAgentRun["status"] | "idle";
  recoverableRuns: PersistedAgentRun[];
  /** True when there is no desktop runtime to carry the request. */
  noTransport: boolean;
}

export interface UseNativeAgentOptions {
  providers: BackendProvider[];
  /** Truthfully selectable models after dynamic discovery/catalogue merging. */
  models?: BackendModel[];
  /** Active chat/thread identifier used to durably associate completed exchanges. */
  threadId?: string;
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
    status: "idle",
    recoverableRuns: [],
    noTransport: !hasDesktopRuntime()
  });
  // The active backend + run id for the current run. cancel() delegates to the
  // backend; the adapter routes the cancel to the egress boundary (the Rust
  // cancel map for native-API) using the requestId it captured from the transport.
  const activeBackendRef = useRef<AgentBackend | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
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
  const threadIdRef = useRef(options.threadId);
  threadIdRef.current = options.threadId;
  const modelsRef = useRef(options.models ?? []);
  modelsRef.current = options.models ?? [];

  useEffect(() => {
    void recoverRuntimeAgentRuns(new Date().toISOString()).then((runs) => {
      if (!runs) return;
      setState((current) => ({
        ...current,
        recoverableRuns: runs.filter(
          (run) =>
            (run.status === "interrupted" || run.status === "failed") && run.recoverable
        )
      }));
    });
  }, []);

  // Resolve the connected backend to a provider-neutral AgentBackend. The deps
  // bag injects the desktop transport + model discovery so the contract stays
  // pure; the native-API adapter consumes them. Returns null when no backend is
  // connected/runnable, or in browser preview (no transport) — mirroring the
  // legacy `connectedNativeBackend` predicate.
  const deps: BackendDeps = useMemo(
    () => ({
      createTransport: createDesktopTransport,
      createCodexAppServer: createDesktopCodexAppServer,
      createAcpTransport: createDesktopAcpTransport,
      discoverModels: async (providerId) => {
        const result = await listRuntimeBackendModels(providerId);
        return result;
      }
    }),
    []
  );
  const backend: AgentBackend | null = useMemo(
    () =>
      resolveAgentBackend(
        options.providers.find(
          (provider) =>
            provider.authState === "connected" &&
            provider.capabilities.includes("streaming")
        ),
        deps
      ),
    [options.providers, deps]
  );

  const run = useCallback(
    async (
      request: AgentRunRequest,
      contextPrefix?: string,
      permissionLabel?: string,
      parentRunId?: string
    ) => {
      let persisted: PersistedAgentRun | null = null;
      if (!backend) {
        setState((current) => ({
          ...current,
          noTransport: !hasDesktopRuntime(),
          lastError: "Native agent needs the desktop runtime.",
          status: "failed"
        }));
        return;
      }
      const providerId = backend.providerId;
      setState((current) => ({
        ...current,
        transcript: "",
        usage: null,
        running: true,
        lastError: null,
        status: "streaming",
        recoverableRuns: parentRunId
          ? current.recoverableRuns.filter((run) => run.id !== parentRunId)
          : current.recoverableRuns,
        noTransport: false
      }));
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const initialExchanges: PersistedAgentExchange[] = request.messages
        .filter(
          (message): message is typeof message & { role: "user" | "assistant" | "tool" } =>
            message.role !== "system"
        )
        .map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName
        }));
      persisted = {
        id: runId,
        providerId,
        model: request.model,
        status: "streaming",
        transcript: "",
        threadId: threadIdRef.current,
        exchanges: initialExchanges,
        parentRunId,
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
      // Resolve the run through the provider-neutral backend. The adapter
      // (native-API today) builds its egress transport from deps and returns null
      // when no transport is available (browser preview). The event handling below
      // is provider-neutral — it consumes the universal BackendAgentEvent stream.
      const eventStream = backend.run(request, {
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
        permissionMode,
        runId,
        onRetry: () => {
          if (!persisted) return;
          persisted = {
            ...persisted,
            status: "retrying",
            retryCount: persisted.retryCount + 1,
            updatedAt: new Date().toISOString()
          };
          void saveRuntimeAgentRun(persisted);
        }
      });
      if (!eventStream) {
        setState((current) => ({
          ...current,
          noTransport: true,
          lastError: "Native agent needs the desktop runtime.",
          running: false,
          status: "failed"
        }));
        return;
      }
      // Capture the active run's backend + id so cancel() reaches the egress
      // boundary (the Rust cancel map for native-API). The adapter also records
      // the requestId internally from the transport's onRequestStarted callback.
      activeBackendRef.current = backend;
      activeRunIdRef.current = runId;
      try {
        for await (const event of eventStream) {
          if (event.type === "text-delta") {
            setState((current) => ({ ...current, transcript: current.transcript + event.text }));
            const exchanges: PersistedAgentExchange[] = [...(persisted.exchanges ?? [])];
            const finalExchange = exchanges.at(-1);
            if (finalExchange?.role === "assistant" && !finalExchange.toolCallId) {
              exchanges[exchanges.length - 1] = {
                ...finalExchange,
                content: finalExchange.content + event.text
              };
            } else {
              exchanges.push({ role: "assistant", content: event.text });
            }
            persisted = {
              ...persisted,
              transcript: persisted.transcript + event.text,
              exchanges,
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "usage") {
            setState((current) => ({
              ...current,
              usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: event.costUsd,
                costEstimated: event.costEstimated
              }
            }));
            persisted = {
              ...persisted,
              usage: {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                costUsd: event.costUsd,
                costEstimated: event.costEstimated
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
            setState((current) => ({ ...current, status: "awaiting-approval" }));
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
              exchanges: [
                ...(persisted.exchanges ?? []),
                {
                  role: "tool",
                  content: event.output,
                  toolCallId: event.callId,
                  ok: event.ok
                }
              ],
              updatedAt: new Date().toISOString()
            };
            setState((current) => ({ ...current, status: "streaming" }));
          } else if (event.type === "error") {
            // Classify so a configuration error (rejected/expired key) is
            // distinguishable from a runtime/provider failure. The structured
            // code travels on the event from the Rust transport boundary.
            const described = describeBackendError(
              event.message,
              event.code,
              event.retryable
            );
            setState((current) => ({ ...current, lastError: described.message }));
            persisted = {
              ...persisted,
              error: described.message,
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "done" || event.type === "cancelled") {
            const failed: boolean =
              event.type === "done" &&
              (event.finishReason === "error" || Boolean(persisted.error));
            const terminalStatus: PersistedAgentRun["status"] =
              event.type === "cancelled" ? "cancelled" : failed ? "failed" : "completed";
            const terminalRun: PersistedAgentRun = {
              ...persisted!,
              status: terminalStatus,
              recoverable: terminalStatus === "failed",
              pendingApprovalIds: [],
              updatedAt: new Date().toISOString()
            };
            persisted = terminalRun;
            setState((current) => ({
              ...current,
              running: false,
              status: terminalStatus,
              recoverableRuns:
                terminalStatus === "failed"
                  ? [
                      terminalRun,
                      ...current.recoverableRuns.filter((run) => run.id !== terminalRun.id)
                    ]
                  : current.recoverableRuns
            }));
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
        // A thrown BackendRuntimeError carries the structured code from the
        // transport boundary; classify it so config vs runtime is visible.
        const thrown = error as { code?: string; retryable?: boolean };
        const rawMessage = error instanceof Error ? error.message : "Agent run failed.";
        const described = describeBackendError(rawMessage, thrown.code, thrown.retryable);
        const message = described.message;
        const cancelled = Boolean(shouldCancelRef.current?.());
        const terminalRun: PersistedAgentRun = {
          ...persisted!,
          status: cancelled ? "cancelled" : "failed",
          recoverable: !cancelled,
          error: message,
          updatedAt: new Date().toISOString()
        };
        persisted = terminalRun;
        setState((current) => ({
          ...current,
          running: false,
          lastError: message,
          status: terminalRun.status,
          recoverableRuns: cancelled
            ? current.recoverableRuns
            : [
                terminalRun,
                ...current.recoverableRuns.filter((run) => run.id !== terminalRun.id)
              ]
        }));
        await saveRuntimeAgentRun(persisted);
      } finally {
        activeBackendRef.current = null;
        activeRunIdRef.current = null;
      }
    },
    [backend]
  );

  const retry = useCallback(
    async (runToRetry: PersistedAgentRun) => {
      const userExchange = runToRetry.exchanges
        ?.filter((exchange) => exchange.role === "user")
        .at(-1);
      if (!runToRetry.recoverable || !userExchange?.content.trim()) {
        setState((current) => ({
          ...current,
          lastError: "This interrupted run does not contain a safe user prompt to retry."
        }));
        return;
      }
      const model = modelsRef.current.find((candidate) => candidate.id === runToRetry.model);
      if (!model?.available || model.capabilities?.streaming !== true) {
        setState((current) => ({
          ...current,
          lastError:
            "This run cannot be retried because its model is unavailable or its capabilities are unknown."
        }));
        return;
      }
      await run(
        {
          model: runToRetry.model,
          messages: [{ role: "user", content: userExchange.content }],
          tools: [],
          maxTokens: 2_048
        },
        undefined,
        "Confirm every action",
        runToRetry.id
      );
    },
    [run]
  );

  const cancel = useCallback(async () => {
    // Delegate real in-flight cancellation to the active backend. The native-API
    // adapter routes it to the Rust cancel map via the requestId it captured from
    // the transport. No-op when no run is active.
    if (activeBackendRef.current) {
      await activeBackendRef.current.cancel(activeRunIdRef.current ?? "");
    }
    // Tear down any tool-call still awaiting approval on the shared gate so a
    // cancelled-but-never-granted call (and its unresolved promise) does not
    // linger for the session. No-op when no onCancel is wired.
    onCancelRef.current?.();
    setState((current) => ({ ...current, running: false, status: "cancelled" }));
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
      usage: null,
      status: "failed"
    }));
  }, []);

  return { state, run, retry, cancel, reportError };
}
