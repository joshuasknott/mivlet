/**
 * Runs a provider-neutral `AgentBackend` and routes its events into the shell.
 *
 * The hook resolves the connected backend to an `AgentBackend` via
 * `resolveAgentBackend` (native API, Codex app-server, and provider-owned ACP
 * runtimes all have live adapters). It then runs the backend, consuming
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
  PermissionMode,
  PreparedRunContext,
  ProviderRouteExecutionBinding,
  RunContextReceipt
} from "@fable/protocol";
import {
  resolveAgentBackend,
  type AgentBackend,
  type BackendDeps,
  type ToolExecutor
} from "@fable/connectors";
import { describeBackendError } from "../lib/backend-errors";
import { createDesktopAcpTransport } from "../lib/acp-transport";
import { createDesktopCodexAppServer } from "../lib/codex-app-server";
import { createDesktopLocalModelTransport } from "../lib/local-model-transport";
import { createDesktopTransport } from "../lib/native-transport";
import {
  listRuntimeBackendModels,
  listRuntimeAgentRuns,
  recoverRuntimeAgentRuns,
  saveRuntimeAgentRun
} from "../runtime";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { selectNativeProviderRoute } from "../lib/provider-route-selection";

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
    costUnknown?: boolean;
  } | null;
  running: boolean;
  lastError: string | null;
  status: PersistedAgentRun["status"] | "idle";
  recoverableRuns: PersistedAgentRun[];
  /** Immutable context evidence keyed by canonical run id, including recovered completed runs. */
  contextReceipts: Record<string, RunContextReceipt>;
  /** Secret-free durable provider route evidence keyed by canonical run id. */
  providerRoutes: Record<string, ProviderRouteExecutionBinding>;
  /** Final provider usage keyed by canonical run id, including restarted history. */
  usageReceipts: Record<string, NonNullable<PersistedAgentRun["usage"]>>;
  /** Canonical id for the current or most recently started run. */
  currentRunId: string | null;
  /** True when there is no desktop runtime to carry the request. */
  noTransport: boolean;
}

export interface UseNativeAgentOptions {
  providers: BackendProvider[];
  /** Provider selected by the combined model picker. */
  activeProviderId?: string;
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
  /**
   * Optional canonical transcript writer. The legacy run remains an in-flight
   * recovery adapter; when a durable thread is active, lifecycle facts flow to
   * this writer with stable per-run idempotency keys.
   */
  createDurableRunWriter?: (threadId: string, runId: string) => DurableRunWriter;
}

export function useNativeAgent(options: UseNativeAgentOptions) {
  const [state, setState] = useState<NativeAgentState>({
    transcript: "",
    usage: null,
    running: false,
    lastError: null,
    status: "idle",
    recoverableRuns: [],
    contextReceipts: {},
    providerRoutes: {},
    usageReceipts: {},
    currentRunId: null,
    noTransport: !hasDesktopRuntime()
  });
  // The active backend + run id for the current run. cancel() delegates to the
  // backend; the adapter routes the cancel to the egress boundary (the Rust
  // cancel map for native-API) using the requestId it captured from the transport.
  const activeBackendRef = useRef<AgentBackend | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activePersistedRef = useRef<PersistedAgentRun | null>(null);
  const activeWriterRef = useRef<DurableRunWriter | null>(null);
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
  const createDurableRunWriterRef = useRef(options.createDurableRunWriter);
  createDurableRunWriterRef.current = options.createDurableRunWriter;

  useEffect(() => {
    void (async () => {
      const recovered = await recoverRuntimeAgentRuns(new Date().toISOString()).catch(() => null);
      const listed = await listRuntimeAgentRuns().catch(() => null);
      const runs = listed ?? recovered;
      if (!runs) return;
      setState((current) => ({
        ...current,
        contextReceipts: runs.reduce<Record<string, RunContextReceipt>>((receipts, run) => {
          if (run.contextReceipt) receipts[run.id] = run.contextReceipt;
          return receipts;
        }, { ...current.contextReceipts }),
        providerRoutes: runs.reduce<Record<string, ProviderRouteExecutionBinding>>((routes, run) => {
          if (run.providerRoute) routes[run.id] = run.providerRoute;
          return routes;
        }, { ...current.providerRoutes }),
        usageReceipts: runs.reduce<Record<string, NonNullable<PersistedAgentRun["usage"]>>>((receipts, run) => {
          if (run.usage) receipts[run.id] = run.usage;
          return receipts;
        }, { ...current.usageReceipts }),
        recoverableRuns: runs.filter(
          (run) =>
            (run.status === "interrupted" || run.status === "failed") && run.recoverable
        )
      }));
    })();
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
      createLocalModelTransport: createDesktopLocalModelTransport,
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
            (!options.activeProviderId || provider.id === options.activeProviderId) &&
            provider.authState === "connected" &&
            provider.capabilities.includes("streaming")
        ),
        deps
      ),
    [options.providers, options.activeProviderId, deps]
  );
  const resolveBackend = useCallback(
    (providerId: string): AgentBackend | null =>
      resolveAgentBackend(
        options.providers.find(
          (provider) =>
            provider.id === providerId
            && provider.authState === "connected"
            && provider.capabilities.includes("streaming")
        ),
        deps
      ),
    [options.providers, deps]
  );

  const run = useCallback(
    async (
      request: AgentRunRequest,
      preparedContext?: PreparedRunContext | string,
      requestedPermissionMode?: PermissionMode,
      parentRunId?: string
    ) => {
      let persisted: PersistedAgentRun | null = null;
      let terminalized = false;
      if (activeRunIdRef.current) {
        setState((current) => ({
          ...current,
          lastError: "Wait for the current response to finish before starting another one."
        }));
        return;
      }
      if (!backend) {
        setState((current) => ({
          ...current,
          noTransport: !hasDesktopRuntime(),
          lastError: "Native agent needs the desktop runtime.",
          status: "failed",
          currentRunId: null
        }));
        return;
      }
      const providerId = backend.providerId;
      const generatedRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const prepared = typeof preparedContext === "object" && preparedContext?.receipt
        ? preparedContext
        : {
            systemPrefix: typeof preparedContext === "string" ? preparedContext : "",
            receipt: {
              version: 1 as const,
              runId: generatedRunId,
              assembledAt: createdAt,
              scope: threadIdRef.current
                ? { level: "thread" as const, threadId: threadIdRef.current }
                : { level: "global" as const },
              citations: [],
              contributions: []
            }
          };
      const runId = prepared.receipt.runId;
      // Reserve the run before asynchronous route selection so two rapid sends
      // cannot both acquire provider authority before either durable write.
      activeRunIdRef.current = runId;
      let providerRoute: Awaited<ReturnType<typeof selectNativeProviderRoute>> | undefined;
      const provider = options.providers.find((candidate) => candidate.id === providerId);
      if (provider?.backendType === "native-api") {
        try {
          const requiredInputTokens = Math.max(1, Math.ceil((
            request.messages.reduce((total, message) => total + message.content.length, 0)
            + prepared.systemPrefix.length
          ) / 4));
          providerRoute = await selectNativeProviderRoute({
            providerId,
            model: request.model,
            requiredInputTokens,
            requiredOutputTokens: request.maxTokens,
            requiresTools: request.tools.length > 0
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Fable could not select an authorized provider route.";
          setState((current) => ({ ...current, lastError: message, status: "failed", currentRunId: null }));
          activeRunIdRef.current = null;
          return;
        }
      }
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
        currentRunId: runId,
        contextReceipts: { ...current.contextReceipts, [runId]: prepared.receipt },
        providerRoutes: providerRoute ? { ...current.providerRoutes, [runId]: providerRoute } : current.providerRoutes,
        noTransport: false
      }));
      // Mark active before the first durable write so a second click cannot
      // start an overlapping run while initial persistence is still pending.
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
        contextReceipt: prepared.receipt,
        ...(providerRoute ? { providerRoute } : {}),
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt,
        updatedAt: createdAt
      };
      activePersistedRef.current = persisted;
      const durableWriter = threadIdRef.current
        ? createDurableRunWriterRef.current?.(threadIdRef.current, runId) ?? null
        : null;
      activeWriterRef.current = durableWriter;
      try {
        // Persist the canonical user turn before egress. A retry supplies only
        // its new user input, never a replay of already-completed tool work.
        if (durableWriter) {
          for (const exchange of initialExchanges.filter((entry) => entry.role === "user")) {
            await durableWriter.record({ kind: "user", content: exchange.content });
          }
        }
        await saveRuntimeAgentRun(persisted);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save the conversation before it started.";
        const failed = { ...persisted, status: "failed" as const, recoverable: true, error: message, updatedAt: new Date().toISOString() };
        activePersistedRef.current = failed;
        setState((current) => {
          const contextReceipts = { ...current.contextReceipts };
          delete contextReceipts[runId];
          const providerRoutes = { ...current.providerRoutes };
          delete providerRoutes[runId];
          return { ...current, running: false, status: "failed", lastError: message, recoverableRuns: [failed, ...current.recoverableRuns], contextReceipts, providerRoutes, currentRunId: null };
        });
        try { await saveRuntimeAgentRun(failed); } catch { /* persistence is already the reported terminal failure */ }
        activeRunIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
        return;
      }
      let lastPersistedTranscriptLength = 0;
      let lastPersistedAt = Date.now();
      const pendingApprovalByCall = new Map<string, string>();
      const toolNameByCall = new Map<string, string>();
      // The shell resolves the visible approval preset (including Custom) down
      // to one PermissionMode before the run reaches this hook.
      const permissionMode: PermissionMode = requestedPermissionMode ?? "trusted-scope";
      // Resolve the run through the provider-neutral backend. The adapter
      // (native-API today) builds its egress transport from deps and returns null
      // when no transport is available (browser preview). The event handling below
      // is provider-neutral — it consumes the universal BackendAgentEvent stream.
      const eventStream = backend.run({ ...request, ...(providerRoute ? { providerRoute } : {}) }, {
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
        contextPrefix: prepared.systemPrefix,
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
        activeRunIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
        return;
      }
      // Capture the active run's backend + id so cancel() reaches the egress
      // boundary (the Rust cancel map for native-API). The adapter also records
      // the requestId internally from the transport's onRequestStarted callback.
      activeBackendRef.current = backend;
      activeRunIdRef.current = runId;
      try {
        for await (const event of eventStream) {
          if (activePersistedRef.current?.status === "cancelled") {
            persisted = activePersistedRef.current;
            terminalized = true;
            break;
          }
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
            if (durableWriter) await durableWriter.checkpointAssistant(persisted.transcript);
          } else if (event.type === "usage") {
            const usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
              costEstimated: event.costEstimated,
              costUnknown: event.costUnknown
            };
            setState((current) => ({
              ...current,
              usage,
              usageReceipts: { ...current.usageReceipts, [runId]: usage }
            }));
            persisted = {
              ...persisted,
              usage,
              updatedAt: new Date().toISOString()
            };
          } else if (event.type === "tool-call") {
            onToolCallRef.current?.(event);
            pendingApprovalByCall.set(event.callId, event.approval.id);
            toolNameByCall.set(event.callId, event.tool);
            persisted = {
              ...persisted,
              status: "awaiting-approval",
              pendingApprovalIds: [...persisted.pendingApprovalIds, event.approval.id],
              updatedAt: new Date().toISOString()
            };
            setState((current) => ({ ...current, status: "awaiting-approval" }));
            if (durableWriter) {
              await durableWriter.record({ kind: "tool-call", content: `Tool requested: ${event.tool}`, callId: event.callId, toolName: event.tool });
              // Historical evidence only: a recovered request must never become
              // a new permit or standing grant after restart.
              await durableWriter.record({ kind: "approval-request", content: `Approval requested for ${event.tool}.`, approvalRequestId: event.approval.id });
            }
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
            if (durableWriter) await durableWriter.record({ kind: "tool-result", content: event.output, callId: event.callId, toolName: toolNameByCall.get(event.callId) ?? "unknown-tool", ok: event.ok });
            toolNameByCall.delete(event.callId);
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
            const terminalRun: PersistedAgentRun = { ...persisted, status: "failed", recoverable: true, pendingApprovalIds: [], updatedAt: new Date().toISOString() };
            persisted = terminalRun;
            terminalized = true;
            if (durableWriter) await durableWriter.record({ kind: "error", content: described.message, code: event.code ?? "provider-error", retryable: event.retryable ?? true });
            setState((current) => ({ ...current, running: false, status: "failed", recoverableRuns: [terminalRun, ...current.recoverableRuns.filter((run) => run.id !== terminalRun.id)] }));
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
            terminalized = true;
            if (durableWriter) {
              await durableWriter.checkpointAssistant(terminalRun.transcript, true);
              if (terminalStatus === "cancelled") await durableWriter.record({ kind: "interruption", content: "The response was stopped.", reason: "user-stop" });
            }
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
            activePersistedRef.current = persisted;
            lastPersistedTranscriptLength = persisted.transcript.length;
            lastPersistedAt = Date.now();
          }
          if (terminalized) break;
        }
        if (!terminalized && persisted) {
          const terminalRun: PersistedAgentRun = { ...persisted, status: "failed", recoverable: true, pendingApprovalIds: [], error: "The provider ended without a completion event.", updatedAt: new Date().toISOString() };
          persisted = terminalRun;
          if (durableWriter) await durableWriter.record({ kind: "error", content: terminalRun.error!, code: "provider-eof", retryable: true });
          await saveRuntimeAgentRun(terminalRun);
          setState((current) => ({ ...current, running: false, status: "failed", lastError: terminalRun.error!, recoverableRuns: [terminalRun, ...current.recoverableRuns.filter((run) => run.id !== terminalRun.id)] }));
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
        if (durableWriter) {
          await durableWriter.record(cancelled
            ? { kind: "interruption", content: "The response was stopped.", reason: "user-stop" }
            : { kind: "error", content: message, code: thrown.code ?? "transport-error", retryable: Boolean(thrown.retryable) });
        }
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
        try { await saveRuntimeAgentRun(persisted); } catch { /* preserve the original terminal failure */ }
      } finally {
        activeBackendRef.current = null;
        activeRunIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
      }
    },
    [backend, options.providers]
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
      if (!model?.available || model.capabilities?.streaming === false) {
        setState((current) => ({
          ...current,
          lastError:
            "This run cannot be retried because its model is unavailable or cannot stream."
        }));
        return;
      }
      if (backend?.providerId !== runToRetry.providerId) {
        setState((current) => ({
          ...current,
          lastError: "Select the run's original provider before retrying it."
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
        "read-only",
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
    const persisted = activePersistedRef.current;
    if (persisted && persisted.status !== "cancelled") {
      const terminalRun: PersistedAgentRun = {
        ...persisted,
        status: "cancelled",
        recoverable: false,
        pendingApprovalIds: [],
        updatedAt: new Date().toISOString()
      };
      activePersistedRef.current = terminalRun;
      try {
        await activeWriterRef.current?.checkpointAssistant(terminalRun.transcript, true);
        await activeWriterRef.current?.record({ kind: "interruption", content: "The response was stopped.", reason: "user-stop" });
        await saveRuntimeAgentRun(terminalRun);
      } catch {
        // Cancellation is terminal even when a checkpoint cannot be written;
        // the next scoped recovery can surface the adapter state safely.
      }
    }
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
      status: "failed",
      currentRunId: null
    }));
  }, []);

  return { state, run, retry, cancel, reportError, backend, resolveBackend };
}
