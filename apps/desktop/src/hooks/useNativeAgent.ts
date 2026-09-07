/**
 * Runs a provider-neutral `AgentBackend` and routes its events into the shell.
 *
 * The hook resolves the connected backend to an `AgentBackend` via
 * `resolveAgentBackend` (native API and Codex app-server have live adapters).
 * It then runs the backend, consuming
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
import { isRoutineConnectorRead } from "@fable/connectors/native-api/tool-executor";
import type {
  AgentTurnRequest,
  BackendAgentEvent,
  BackendModel,
  BackendProvider,
  ExecutionExchange,
  ExecutionAttempt,
  PermissionMode,
  PreparedExecutionContext,
  ProviderRouteExecutionBinding,
  ExecutionContextReceipt,
} from "@fable/protocol";
import {
  resolveAgentBackend,
  type AgentBackend,
  type BackendDeps,
  type ToolExecutor,
} from "@fable/connectors";
import { validateReasoningEffort } from "@fable/connectors/native-api/reasoning";
import { describeBackendError } from "../lib/backend-errors";
import { createComputerTaskExecutor } from "../lib/computer-task-executor";
import { createDesktopCodexAppServer } from "../lib/codex-app-server";
import { createDesktopAntigravityAcp } from "../lib/antigravity-acp";
import { createDesktopManagedRuntime } from "../lib/managed-runtime";
import { createDesktopTransport } from "../lib/native-transport";
import {
  listRuntimeBackendModels,
  listRuntimeExecutionAttempts,
  recoverRuntimeExecutionAttempts,
  saveRuntimeExecutionAttempt,
} from "../runtime";
import type {
  DurableRunWriter,
  HydratedConversation,
} from "../lib/conversation-runtime";
import { buildContinuationMessages } from "../lib/agent-run";
import { selectNativeProviderRoute } from "../lib/provider-route-selection";
import { appendResponseText, CONVERSATION_STYLE_INSTRUCTIONS, resolveResponseTool, toolActivity, toolConnectorId, type ResponsePart } from "../lib/conversation-presentation";

/** True when the desktop (Tauri) runtime is present (drives the noTransport state). */
function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

export interface NativeAgentState {
  transcript: string;
  responseParts?: ResponsePart[];
  progressPrompt?: string;
  startedAt?: string;
  endedAt?: string;
  progressThreadId?: string;
  reasoningSummaries?: Record<string, string>;
  progressReceipts?: Record<string, { summaries: Record<string, string>; startedAt: string; endedAt: string }>;
  activity?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costEstimated?: boolean;
    costUnknown?: boolean;
  } | null;
  running: boolean;
  lastError: string | null;
  status: ExecutionAttempt["status"] | "idle";
  recoverableAttempts: ExecutionAttempt[];
  /** Immutable context evidence keyed by canonical attempt id, including recovered completed attempts. */
  contextReceipts: Record<string, ExecutionContextReceipt>;
  /** Secret-free durable provider route evidence keyed by canonical attempt id. */
  providerRoutes: Record<string, ProviderRouteExecutionBinding>;
  /** Final provider usage keyed by canonical attempt id, including restarted history. */
  usageReceipts: Record<string, NonNullable<ExecutionAttempt["usage"]>>;
  /** Canonical id for the current or most recently started attempt. */
  currentAttemptId: string | null;
  /** True when there is no desktop runtime to carry the request. */
  noTransport: boolean;
}

export interface UseNativeAgentOptions {
  computer?: { workspaceId: string; agentId: string };
  providers: BackendProvider[];
  /** Provider selected by the combined model picker. */
  activeProviderId?: string;
  /** Truthfully selectable models after dynamic discovery/catalogue merging. */
  models?: BackendModel[];
  /** Active chat/thread identifier used to durably associate completed exchanges. */
  threadId?: string;
  /** Fresh canonical history; never re-persisted as a new user turn. */
  loadConversation?: (threadId: string) => Promise<HydratedConversation | null>;
  /** Receives tool-call events so the shell can route them into its approval queue. */
  onToolCall?: (
    event: Extract<BackendAgentEvent, { type: "tool-call" }>,
  ) => void;
  /**
   * The real tool executor, wired to the shell's shared approval gate + the Rust
   * boundary. When omitted the loop uses a fail-closed stub (tool calls surface
   * as approvals and execution refuses) — this is the pre-tool-execution behavior
   * and keeps the hook fixture-testable without a live approval gate.
   */
  execute?: ToolExecutor;
  /** Approval-only gate for provider-owned tools such as Antigravity ACP. */
  authorize?: (
    approval: import("@fable/protocol").ApprovalRequest,
  ) => Promise<void>;
  /**
   * Cooperative cancellation hook, checked between events. When omitted the loop
   * can never be cooperatively cancelled mid-turn (real in-flight cancellation
   * still happens at the Rust boundary via cancel()). App.tsx wires this to a
   * cancel flag so an in-flight loop can bail between events.
   */
  shouldCancel?: () => boolean;
  /**
   * Invoked once when an attempt is cancelled, so the shell can tear down any
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
  createDurableRunWriter?: (
    threadId: string,
    attemptId: string,
  ) => DurableRunWriter;
}

export function useNativeAgent(options: UseNativeAgentOptions) {
  const [state, setState] = useState<NativeAgentState>({
    transcript: "",
        reasoningSummaries: {},
        activity: "",
    usage: null,
    running: false,
    lastError: null,
    status: "idle",
    recoverableAttempts: [],
    contextReceipts: {},
    providerRoutes: {},
    usageReceipts: {},
    currentAttemptId: null,
    noTransport: !hasDesktopRuntime(),
  });
  // The active backend + run id for the current run. cancel() delegates to the
  // backend; the adapter routes the cancel to the egress boundary (the Rust
  // cancel map for native-API) using the requestId it captured from the transport.
  const activeBackendRef = useRef<AgentBackend | null>(null);
  const activeAttemptIdRef = useRef<string | null>(null);
  const activePersistedRef = useRef<ExecutionAttempt | null>(null);
  const activeWriterRef = useRef<DurableRunWriter | null>(null);
  const onToolCallRef = useRef(options.onToolCall);
  onToolCallRef.current = options.onToolCall;
  // The executor + cancellation hook are read live each run so App.tsx can wire
  // the real (approval-gated) executor + cancel path without re-creating the hook.
  const executeRef = useRef(options.execute);
  executeRef.current = options.execute;
  const authorizeRef = useRef(options.authorize);
  authorizeRef.current = options.authorize;
  const shouldCancelRef = useRef(options.shouldCancel);
  shouldCancelRef.current = options.shouldCancel;
  const onCancelRef = useRef(options.onCancel);
  onCancelRef.current = options.onCancel;
  const threadIdRef = useRef(options.threadId);
  threadIdRef.current = options.threadId;
  const loadConversationRef = useRef(options.loadConversation);
  loadConversationRef.current = options.loadConversation;
  const modelsRef = useRef(options.models ?? []);
  modelsRef.current = options.models ?? [];
  const createDurableRunWriterRef = useRef(options.createDurableRunWriter);
  createDurableRunWriterRef.current = options.createDurableRunWriter;

  useEffect(() => {
    void (async () => {
      const recovered = await recoverRuntimeExecutionAttempts(
        new Date().toISOString(),
      ).catch(() => null);
      const listed = await listRuntimeExecutionAttempts().catch(() => null);
      const runs = listed ?? recovered;
      if (!runs) return;
      setState((current) => ({
        ...current,
        contextReceipts: runs.reduce<Record<string, ExecutionContextReceipt>>(
          (receipts, run) => {
            if (run.contextReceipt) receipts[run.id] = run.contextReceipt;
            return receipts;
          },
          { ...current.contextReceipts },
        ),
        providerRoutes: runs.reduce<
          Record<string, ProviderRouteExecutionBinding>
        >(
          (routes, run) => {
            if (run.providerRoute) routes[run.id] = run.providerRoute;
            return routes;
          },
          { ...current.providerRoutes },
        ),
        usageReceipts: runs.reduce<
          Record<string, NonNullable<ExecutionAttempt["usage"]>>
        >(
          (receipts, run) => {
            if (run.usage) receipts[run.id] = run.usage;
            return receipts;
          },
          { ...current.usageReceipts },
        ),
        recoverableAttempts: runs.filter(
          (run) =>
            (run.status === "interrupted" || run.status === "failed") &&
            run.recoverable,
        ),
        progressReceipts: Object.fromEntries(runs.map((run) => [run.id, { summaries: run.reasoningSummaries ?? {}, startedAt: run.createdAt, endedAt: run.updatedAt }])),
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
      createAntigravityAcp: createDesktopAntigravityAcp,
      createManagedRuntime: createDesktopManagedRuntime,
      discoverModels: async (providerId) => {
        const result = await listRuntimeBackendModels(providerId);
        return result;
      },
    }),
    [],
  );
  const backend: AgentBackend | null = useMemo(
    () =>
      resolveAgentBackend(
        options.providers.find(
          (provider) =>
            (!options.activeProviderId ||
              provider.id === options.activeProviderId) &&
            provider.authState === "connected" &&
            provider.capabilities.includes("streaming"),
        ),
        deps,
      ),
    [options.providers, options.activeProviderId, deps],
  );
  const resolveBackend = useCallback(
    (providerId: string): AgentBackend | null =>
      resolveAgentBackend(
        options.providers.find(
          (provider) =>
            provider.id === providerId &&
            provider.authState === "connected" &&
            provider.capabilities.includes("streaming"),
        ),
        deps,
      ),
    [options.providers, deps],
  );

  const run = useCallback(
    async (
      request: AgentTurnRequest,
      preparedContext?: PreparedExecutionContext | string,
      requestedPermissionMode?: PermissionMode,
      parentAttemptId?: string,
    ) => {
      let persisted: ExecutionAttempt | null = null;
      let terminalized = false;
      if (activeAttemptIdRef.current) {
        setState((current) => ({
          ...current,
          lastError:
            "Wait for the current response to finish before starting another one.",
        }));
        return;
      }
      if (!backend) {
        setState((current) => ({
          ...current,
          noTransport: !hasDesktopRuntime(),
          lastError: "Native agent needs the desktop runtime.",
          status: "failed",
          currentAttemptId: null,
        }));
        return;
      }
      const providerId = backend.providerId;
      try {
        validateReasoningEffort(providerId, modelsRef.current.find((model) => model.id === request.model) ?? backend.backend.models.find((model) => model.id === request.model), request.reasoningEffort);
      } catch (error) {
        setState((current) => ({ ...current, lastError: error instanceof Error ? error.message : "Choose a reasoning level again.", status: "failed" }));
        return;
      }
      const generatedAttemptId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const prepared =
        typeof preparedContext === "object" && preparedContext?.receipt
          ? preparedContext
          : {
              systemPrefix:
                typeof preparedContext === "string" ? preparedContext : "",
              receipt: {
                version: 1 as const,
                attemptId: generatedAttemptId,
                assembledAt: createdAt,
                scope: threadIdRef.current
                  ? { level: "thread" as const, threadId: threadIdRef.current }
                  : { level: "global" as const },
                citations: [],
                contributions: [],
              },
            };
      const attemptId = prepared.receipt.attemptId;
      // Reserve the attempt before asynchronous route selection so two rapid sends
      // cannot both acquire provider authority before either durable write.
      activeAttemptIdRef.current = attemptId;
      const requestThreadId = threadIdRef.current;
      let providerRequest = request;
      if (requestThreadId && loadConversationRef.current) {
        try {
          const conversation =
            await loadConversationRef.current(requestThreadId);
          if (
            !conversation ||
            conversation.thread.id !== requestThreadId ||
            threadIdRef.current !== requestThreadId
          ) {
            throw new Error(
              "The conversation changed before the message could be sent. Try again.",
            );
          }
          // Completed conversation only. Orphaned tool results and tool calls
          // must not be replayed as requests or duplicated in the transcript.
          const history = buildContinuationMessages(
            conversation.messages.filter((view) => !parentAttemptId || view.message.runId !== parentAttemptId),
          ).filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          );
          providerRequest = {
            ...request,
            messages: [
              ...request.messages.filter(
                (message) => message.role === "system",
              ),
              ...history,
              ...request.messages.filter(
                (message) => message.role !== "system",
              ),
            ],
          };
        } catch (error) {
          activeAttemptIdRef.current = null;
          setState((current) => ({
            ...current,
            lastError:
              error instanceof Error
                ? error.message
                : "Could not read this conversation.",
            status: "failed",
            currentAttemptId: null,
          }));
          return;
        }
      }
      let providerRoute:
        Awaited<ReturnType<typeof selectNativeProviderRoute>> | undefined;
      const provider = options.providers.find(
        (candidate) => candidate.id === providerId,
      );
      if (provider?.backendType === "native-api") {
        try {
          const requiredInputTokens = Math.max(
            1,
            Math.ceil(
              (providerRequest.messages.reduce(
                (total, message) => total + message.content.length,
                0,
              ) +
                prepared.systemPrefix.length) /
                4,
            ),
          );
          providerRoute = await selectNativeProviderRoute({
            providerId,
            model: request.model,
            requiredInputTokens,
            requiredOutputTokens: request.maxTokens,
            requiresTools: request.tools.length > 0,
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Fable could not select an authorized provider route.";
          setState((current) => ({
            ...current,
            lastError: message,
            status: "failed",
            currentAttemptId: null,
          }));
          activeAttemptIdRef.current = null;
          return;
        }
      }
      if (
        activeAttemptIdRef.current !== attemptId ||
        threadIdRef.current !== requestThreadId ||
        shouldCancelRef.current?.()
      ) {
        if (activeAttemptIdRef.current === attemptId)
          activeAttemptIdRef.current = null;
        return;
      }
      setState((current) => ({
        ...current,
        transcript: "",
        reasoningSummaries: {},
        activity: "",
        progressThreadId: requestThreadId,
        progressPrompt: request.messages.filter((message) => message.role === "user").at(-1)?.content,
        responseParts: [],
        startedAt: createdAt,
        endedAt: undefined,
        usage: null,
        running: true,
        lastError: null,
        status: "streaming",
        recoverableAttempts: parentAttemptId
          ? current.recoverableAttempts.filter(
              (run) => run.id !== parentAttemptId,
            )
          : current.recoverableAttempts,
        currentAttemptId: attemptId,
        contextReceipts: {
          ...current.contextReceipts,
          [attemptId]: prepared.receipt,
        },
        providerRoutes: providerRoute
          ? { ...current.providerRoutes, [attemptId]: providerRoute }
          : current.providerRoutes,
        noTransport: false,
      }));
      // Mark active before the first durable write so a second click cannot
      // start an overlapping attempt while initial persistence is still pending.
      const initialExchanges: ExecutionExchange[] = request.messages
        .filter(
          (
            message,
          ): message is typeof message & {
            role: "user" | "assistant" | "tool";
          } => message.role !== "system",
        )
        .map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
        }));
      persisted = {
        id: attemptId,
        providerId,
        model: request.model,
        status: "streaming",
        transcript: "",
        threadId: requestThreadId,
        exchanges: initialExchanges,
        parentAttemptId,
        contextReceipt: prepared.receipt,
        ...(providerRoute ? { providerRoute } : {}),
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt,
        updatedAt: createdAt,
      };
      activePersistedRef.current = persisted;
      const durableWriter = requestThreadId
        ? (createDurableRunWriterRef.current?.(requestThreadId, attemptId) ??
          null)
        : null;
      activeWriterRef.current = durableWriter;
      try {
        // Persist the canonical user turn before egress. A retry supplies only
        // its new user input, never a replay of already-completed tool work.
        if (durableWriter) {
          for (const exchange of initialExchanges.filter(
            (entry) => entry.role === "user",
          )) {
            await durableWriter.record({
              kind: "user",
              content: exchange.content,
            });
          }
        }
        await saveRuntimeExecutionAttempt(persisted);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not save the conversation before it started.";
        const failed = {
          ...persisted,
          status: "failed" as const,
          recoverable: true,
          error: message,
          updatedAt: new Date().toISOString(),
        };
        activePersistedRef.current = failed;
        setState((current) => {
          const contextReceipts = { ...current.contextReceipts };
          delete contextReceipts[attemptId];
          const providerRoutes = { ...current.providerRoutes };
          delete providerRoutes[attemptId];
          return {
            ...current,
            running: false,
            status: "failed",
            lastError: message,
            recoverableAttempts: [failed, ...current.recoverableAttempts],
            contextReceipts,
            providerRoutes,
            currentAttemptId: null,
          };
        });
        try {
          await saveRuntimeExecutionAttempt(failed);
        } catch {
          /* persistence is already the reported terminal failure */
        }
        activeAttemptIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
        return;
      }
      let lastPersistedTranscriptLength = 0;
      let lastPersistedAt = Date.now();
      const pendingApprovalByCall = new Map<string, string>();
      const toolNameByCall = new Map<string, string>();
      // The shell resolves the visible approval preset (including Custom) down
      // to one PermissionMode before the attempt reaches this hook.
      const permissionMode: PermissionMode =
        requestedPermissionMode ?? "trusted-scope";
      // Resolve the attempt through the provider-neutral backend. The adapter
      // (native-API today) builds its egress transport from deps and returns null
      // when no transport is available (browser preview). The event handling below
      // is provider-neutral — it consumes the universal BackendAgentEvent stream.
      const eventStream = backend.run(
        { ...providerRequest, ...(providerRoute ? { providerRoute } : {}) },
        {
          // The real executor is wired by App.tsx from the shell's shared
          // approval gate + the Rust tool boundary; until then (or in tests)
          // the fail-closed stub keeps tool calls surfacing as approvals that
          // refuse to execute. The permission mode still gates which tool calls
          // may reach the executor.
          execute: createComputerTaskExecutor(
            executeRef.current ??
            (async () => {
              throw new Error("Tool execution pending approval in the shell.");
            }),
            (activity) => setState((current) => ({ ...current, activity })),
          ),
          authorize: authorizeRef.current,
          shouldCancel: shouldCancelRef.current ?? (() => false),
          contextPrefix: prepared.systemPrefix,
          permissionMode,
          attemptId,
          computer: options.computer,
          onRetry: () => {
            if (!persisted) return;
            persisted = {
              ...persisted,
              status: "retrying",
              retryCount: persisted.retryCount + 1,
              updatedAt: new Date().toISOString(),
            };
            void saveRuntimeExecutionAttempt(persisted);
          },
        },
      );
      if (!eventStream) {
        setState((current) => ({
          ...current,
          noTransport: true,
          lastError: "Native agent needs the desktop runtime.",
          running: false,
          status: "failed",
        }));
        activeAttemptIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
        return;
      }
      // Capture the active attempt's backend + id so cancel() reaches the egress
      // boundary (the Rust cancel map for native-API). The adapter also records
      // the requestId internally from the transport's onRequestStarted callback.
      activeBackendRef.current = backend;
      activeAttemptIdRef.current = attemptId;
      try {
        for await (const event of eventStream) {
          if (activePersistedRef.current?.status === "cancelled") {
            persisted = activePersistedRef.current;
            terminalized = true;
            break;
          }
          if (event.type === "reasoning-summary") {
            const key = `${event.itemId}:${event.summaryIndex}`;
            const summaries: Record<string, string> = { ...persisted.reasoningSummaries };
            summaries[key] = ((summaries[key] ?? "") + event.text).slice(-16000);
            for (const staleKey of Object.keys(summaries).slice(0, -32)) delete summaries[staleKey];
            persisted = { ...persisted, reasoningSummaries: summaries };
            setState((current) => {
              return { ...current, reasoningSummaries: summaries };
            });
          } else if (event.type === "text-delta") {
            setState((current) => ({
              ...current,
              transcript: current.transcript + event.text,
              responseParts: appendResponseText(current.responseParts ?? [], event.text),
              activity: "",
            }));
            const exchanges: ExecutionExchange[] = [
              ...(persisted.exchanges ?? []),
            ];
            const finalExchange = exchanges.at(-1);
            if (
              finalExchange?.role === "assistant" &&
              !finalExchange.toolCallId
            ) {
              exchanges[exchanges.length - 1] = {
                ...finalExchange,
                content: finalExchange.content + event.text,
              };
            } else {
              exchanges.push({ role: "assistant", content: event.text });
            }
            persisted = {
              ...persisted,
              transcript: persisted.transcript + event.text,
              exchanges,
              updatedAt: new Date().toISOString(),
            };
            if (durableWriter)
              await durableWriter.checkpointAssistant(persisted.transcript);
          } else if (event.type === "usage") {
            const usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
              costEstimated: event.costEstimated,
              costUnknown: event.costUnknown,
            };
            setState((current) => ({
              ...current,
              usage,
              usageReceipts: { ...current.usageReceipts, [attemptId]: usage },
            }));
            persisted = {
              ...persisted,
              usage,
              updatedAt: new Date().toISOString(),
            };
          } else if (event.type === "tool-call") {
            const needsApproval = !isRoutineConnectorRead(event.approval)
              && !["connector-call", "connector-action"].includes(event.approval.action.split(/\s+/)[0]);
            onToolCallRef.current?.(event);
            if (needsApproval) pendingApprovalByCall.set(event.callId, event.approval.id);
            toolNameByCall.set(event.callId, event.tool);
            persisted = {
              ...persisted,
              status: needsApproval ? "awaiting-approval" : "streaming",
              pendingApprovalIds: [
                ...persisted.pendingApprovalIds,
                ...(needsApproval ? [event.approval.id] : []),
              ],
              updatedAt: new Date().toISOString(),
            };
            setState((current) => ({
              ...current,
              status: needsApproval ? "awaiting-approval" : "streaming",
              activity: toolActivity(event.tool, "running"),
              responseParts: [...(current.responseParts ?? []), { id: event.callId, kind: "tool", tool: event.tool, connectorId: toolConnectorId(event.tool, event.arguments), content: "", state: "running" }],
            }));
            if (durableWriter) {
              await durableWriter.record({
                kind: "tool-call",
                content: `Tool requested: ${event.tool}`,
                callId: event.callId,
                toolName: event.tool,
              });
              // Historical evidence only: a recovered request must never become
              // a new permit or standing grant after restart.
              if (needsApproval) await durableWriter.record({
                kind: "approval-request",
                content: `Approval requested for ${event.tool}.`,
                approvalRequestId: event.approval.id,
              });
            }
          } else if (event.type === "tool-result") {
            const completedApprovalId = pendingApprovalByCall.get(event.callId);
            pendingApprovalByCall.delete(event.callId);
            persisted = {
              ...persisted,
              status: "streaming",
              turn: persisted.turn + 1,
              pendingApprovalIds: persisted.pendingApprovalIds.filter(
                (id) => id !== completedApprovalId,
              ),
              exchanges: [
                ...(persisted.exchanges ?? []),
                {
                  role: "tool",
                  content: event.output,
                  toolCallId: event.callId,
                  ok: event.ok,
                },
              ],
              updatedAt: new Date().toISOString(),
            };
            setState((current) => ({ ...current, status: "streaming", activity: "",
              responseParts: resolveResponseTool(current.responseParts ?? [], event.callId, event.output, event.ok) }));
            if (durableWriter)
              await durableWriter.record({
                kind: "tool-result",
                content: event.output,
                callId: event.callId,
                toolName: toolNameByCall.get(event.callId) ?? "unknown-tool",
                ok: event.ok,
              });
            toolNameByCall.delete(event.callId);
          } else if (event.type === "error") {
            // Classify so a configuration error (rejected/expired key) is
            // distinguishable from an attempttime/provider failure. The structured
            // code travels on the event from the Rust transport boundary.
            const described = describeBackendError(
              event.message,
              event.code,
              event.retryable,
            );
            setState((current) => ({
              ...current,
              lastError: described.message,
              endedAt: new Date().toISOString(),
            }));
            persisted = {
              ...persisted,
              error: described.message,
              updatedAt: new Date().toISOString(),
            };
            const terminalRun: ExecutionAttempt = {
              ...persisted,
              status: "failed",
              recoverable: true,
              pendingApprovalIds: [],
              updatedAt: new Date().toISOString(),
            };
            persisted = terminalRun;
            terminalized = true;
            if (durableWriter)
              await durableWriter.record({
                kind: "error",
                content: described.message,
                code: event.code ?? "provider-error",
                retryable: event.retryable ?? true,
              });
            setState((current) => ({
              ...current,
              running: false,
              status: "failed",
              recoverableAttempts: [
                terminalRun,
                ...current.recoverableAttempts.filter(
                  (run) => run.id !== terminalRun.id,
                ),
              ],
            }));
          } else if (event.type === "done" || event.type === "cancelled") {
            const failed: boolean =
              event.type === "done" &&
              (event.finishReason === "error" || Boolean(persisted.error));
            const terminalStatus: ExecutionAttempt["status"] =
              event.type === "cancelled"
                ? "cancelled"
                : failed
                  ? "failed"
                  : "completed";
            const terminalRun: ExecutionAttempt = {
              ...persisted!,
              status: terminalStatus,
              recoverable: terminalStatus === "failed",
              pendingApprovalIds: [],
              updatedAt: new Date().toISOString(),
            };
            persisted = terminalRun;
            terminalized = true;
            if (durableWriter) {
              await durableWriter.checkpointAssistant(
                terminalRun.transcript,
                true,
              );
              if (terminalStatus === "cancelled")
                await durableWriter.record({
                  kind: "interruption",
                  content: "The response was stopped.",
                  reason: "user-stop",
                });
            }
            setState((current) => ({
              ...current,
              running: false,
              status: terminalStatus,
              endedAt: terminalRun.updatedAt,
              progressReceipts: { ...current.progressReceipts, [attemptId]: { summaries: terminalRun.reasoningSummaries ?? {}, startedAt: terminalRun.createdAt, endedAt: terminalRun.updatedAt } },
              recoverableAttempts:
                terminalStatus === "failed"
                  ? [
                      terminalRun,
                      ...current.recoverableAttempts.filter(
                        (run) => run.id !== terminalRun.id,
                      ),
                    ]
                  : current.recoverableAttempts,
            }));
          }
          const terminalOrBoundary =
            event.type !== "text-delta" ||
            persisted.transcript.length - lastPersistedTranscriptLength >=
              512 ||
            Date.now() - lastPersistedAt >= 1_000;
          if (terminalOrBoundary) {
            await saveRuntimeExecutionAttempt(persisted);
            activePersistedRef.current = persisted;
            lastPersistedTranscriptLength = persisted.transcript.length;
            lastPersistedAt = Date.now();
          }
          if (terminalized) break;
        }
        if (!terminalized && persisted) {
          const terminalRun: ExecutionAttempt = {
            ...persisted,
            status: "failed",
            recoverable: true,
            pendingApprovalIds: [],
            error: "The provider ended without a completion event.",
            updatedAt: new Date().toISOString(),
          };
          persisted = terminalRun;
          if (durableWriter)
            await durableWriter.record({
              kind: "error",
              content: terminalRun.error!,
              code: "provider-eof",
              retryable: true,
            });
          await saveRuntimeExecutionAttempt(terminalRun);
          setState((current) => ({
            ...current,
            running: false,
            status: "failed",
            lastError: terminalRun.error!,
            recoverableAttempts: [
              terminalRun,
              ...current.recoverableAttempts.filter(
                (run) => run.id !== terminalRun.id,
              ),
            ],
          }));
        }
      } catch (error) {
        // A thrown BackendRuntimeError carries the structured code from the
        // transport boundary; classify it so config vs runtime is visible.
        const thrown = error as { code?: string; retryable?: boolean };
        const rawMessage =
          error instanceof Error ? error.message : "Agent run failed.";
        const described = describeBackendError(
          rawMessage,
          thrown.code,
          thrown.retryable,
        );
        const message = described.message;
        const cancelled = Boolean(shouldCancelRef.current?.());
        const terminalRun: ExecutionAttempt = {
          ...persisted!,
          status: cancelled ? "cancelled" : "failed",
          recoverable: !cancelled,
          error: message,
          updatedAt: new Date().toISOString(),
        };
        persisted = terminalRun;
        if (durableWriter) {
          await durableWriter.record(
            cancelled
              ? {
                  kind: "interruption",
                  content: "The response was stopped.",
                  reason: "user-stop",
                }
              : {
                  kind: "error",
                  content: message,
                  code: thrown.code ?? "transport-error",
                  retryable: Boolean(thrown.retryable),
                },
          );
        }
        setState((current) => ({
          ...current,
          running: false,
          lastError: message,
          status: terminalRun.status,
          endedAt: terminalRun.updatedAt,
          recoverableAttempts: cancelled
            ? current.recoverableAttempts
            : [
                terminalRun,
                ...current.recoverableAttempts.filter(
                  (run) => run.id !== terminalRun.id,
                ),
              ],
        }));
        try {
          await saveRuntimeExecutionAttempt(persisted);
        } catch {
          /* preserve the original terminal failure */
        }
      } finally {
        activeBackendRef.current = null;
        activeAttemptIdRef.current = null;
        activePersistedRef.current = null;
        activeWriterRef.current = null;
      }
    },
    [backend, options.providers],
  );

  const retry = useCallback(
    async (
      attemptToRetry: ExecutionAttempt,
      tools: AgentTurnRequest["tools"] = [],
      permissionMode: PermissionMode = "read-only",
      instructions: string = CONVERSATION_STYLE_INSTRUCTIONS,
    ) => {
      const userExchange = attemptToRetry.exchanges
        ?.filter((exchange) => exchange.role === "user")
        .at(-1);
      if (!attemptToRetry.recoverable || !userExchange?.content.trim()) {
        setState((current) => ({
          ...current,
          lastError:
            "This interrupted run does not contain a safe user prompt to retry.",
        }));
        return;
      }
      if (attemptToRetry.threadId !== threadIdRef.current) {
        setState((current) => ({ ...current, lastError: "Open this run's conversation before retrying it." }));
        return;
      }
      const model = modelsRef.current.find(
        (candidate) => candidate.id === attemptToRetry.model,
      );
      if (!model?.available || model.capabilities?.streaming === false) {
        setState((current) => ({
          ...current,
          lastError:
            "This run cannot be retried because its model is unavailable or cannot stream.",
        }));
        return;
      }
      if (backend?.providerId !== attemptToRetry.providerId) {
        setState((current) => ({
          ...current,
          lastError:
            "Select the attempt's original provider before retrying it.",
        }));
        return;
      }
      await run(
        {
          model: attemptToRetry.model,
          messages: [{ role: "system", content: instructions }, { role: "user", content: userExchange.content }],
          tools,
          maxTokens: 2_048,
        },
        undefined,
        permissionMode,
        attemptToRetry.id,
      );
    },
    [run],
  );

  const markToolExecuting = useCallback((approvalId: string, tool: string) => {
    const persisted = activePersistedRef.current;
    if (!persisted || !persisted.pendingApprovalIds.includes(approvalId) || persisted.status === "cancelled") return;
    activePersistedRef.current = { ...persisted, status: "streaming", pendingApprovalIds: persisted.pendingApprovalIds.filter((id) => id !== approvalId) };
    setState((current) => current.running && current.currentAttemptId === persisted.id
      ? { ...current, status: "streaming", activity: toolActivity(tool, "running") } : current);
  }, []);

  const cancel = useCallback(async () => {
    const backendToCancel = activeBackendRef.current;
    const attemptToCancel = activeAttemptIdRef.current;
    const writerToCancel = activeWriterRef.current;
    const persisted = activePersistedRef.current;
    // Reject approval waiters immediately, even when native cancellation is
    // slow or unavailable. No lost card may leave a provider waiting forever.
    onCancelRef.current?.();
    const nativeCancellation = Promise.resolve().then(() => backendToCancel?.cancel(attemptToCancel ?? "")).catch(() => {
      setState((current) => current.currentAttemptId === attemptToCancel
        ? { ...current, lastError: "The response stopped locally, but provider cancellation could not be confirmed." } : current);
    });
    if (persisted && persisted.status !== "cancelled") {
      const terminalRun: ExecutionAttempt = {
        ...persisted,
        status: "cancelled",
        recoverable: false,
        pendingApprovalIds: [],
        updatedAt: new Date().toISOString(),
      };
      activePersistedRef.current = terminalRun;
      try {
        await writerToCancel?.checkpointAssistant(
          terminalRun.transcript,
          true,
        );
        await writerToCancel?.record({
          kind: "interruption",
          content: "The response was stopped.",
          reason: "user-stop",
        });
        await saveRuntimeExecutionAttempt(terminalRun);
      } catch {
        // Cancellation is terminal even when a checkpoint cannot be written;
        // the next scoped recovery can surface the adapter state safely.
      }
    }
    setState((current) => current.currentAttemptId === attemptToCancel ? ({
      ...current,
      running: false,
      status: "cancelled",
      endedAt: new Date().toISOString(),
    }) : current);
    await nativeCancellation;
  }, []);

  useEffect(() => () => {
    // A renderer remount cannot retain the visible approval queue. Stop its
    // native provider and settle its gate before those refs become unreachable.
    if (activeAttemptIdRef.current) void cancel();
  }, [cancel]);

  /**
   * Surface a pre-run validation error (e.g. an invalid model selection) through
   * the same `lastError` channel the UI renders for run failures, without
   * starting an attempt. Used so {@link validateModelSelection} can fail fast before
   * the loop opens a socket.
   */
  const reportError = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      running: false,
      lastError: message,
      transcript: "",
        reasoningSummaries: {},
        activity: "",
      usage: null,
      status: "failed",
      currentAttemptId: null,
    }));
  }, []);

  return { state, run, retry, cancel, markToolExecuting, reportError, backend, resolveBackend };
}
