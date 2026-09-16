import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AgentTurnRequest,
  BackendModel,
  ExecutionAttempt,
  PermissionMode,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import type { AgentBackend, ToolExecutor } from "@mivlet/connectors";
import { validateReasoningEffort } from "@mivlet/connectors/native-api/reasoning";
import {
  createAttemptPersistence,
  type AttemptPersistence,
} from "../../lib/attempt-persistence";
import { createComputerTaskExecutor } from "../../lib/computer-task-executor";
import { saveRuntimeExecutionAttempt } from "../../runtime/domains/workspace";
import type {
  DurableRunWriter,
  HydratedConversation,
} from "../../lib/conversation-runtime";
import {
  contextFailureState,
  loadContinuationHistory,
  planAttemptContext,
  resolvePreparedAttemptContext,
} from "./context";
import {
  consumeNativeAgentEvents,
  failNativeAgentRun,
  type NativeAgentEventSession,
} from "./events";
import {
  buildQueuedAttempt,
  buildQueuedExchanges,
  prependRecoverableAttempt,
} from "./persistence";
import { selectAttemptProviderRoute } from "./providers";
import { hasDesktopRuntime } from "./runtime";
import type {
  NativeAgentContextScope,
  NativeAgentRunControl,
  NativeAgentState,
  UseNativeAgentOptions,
} from "./types";

export interface NativeAgentRunHost {
  backend: AgentBackend | null;
  options: UseNativeAgentOptions;
  setState: Dispatch<SetStateAction<NativeAgentState>>;
  activeBackendRef: MutableRefObject<AgentBackend | null>;
  activeAttemptIdRef: MutableRefObject<string | null>;
  activePersistenceRef: MutableRefObject<AttemptPersistence | null>;
  onToolCallRef: MutableRefObject<UseNativeAgentOptions["onToolCall"]>;
  executeRef: MutableRefObject<ToolExecutor | undefined>;
  authorizeRef: MutableRefObject<UseNativeAgentOptions["authorize"]>;
  shouldCancelRef: MutableRefObject<UseNativeAgentOptions["shouldCancel"]>;
  threadIdRef: MutableRefObject<string | undefined>;
  contextScopeRef: MutableRefObject<NativeAgentContextScope>;
  loadConversationRef: MutableRefObject<
    ((threadId: string) => Promise<HydratedConversation | null>) | undefined
  >;
  attributeHistoryRef: MutableRefObject<
    UseNativeAgentOptions["attributeHistory"]
  >;
  modelsRef: MutableRefObject<BackendModel[]>;
  createDurableRunWriterRef: MutableRefObject<
    | ((threadId: string, attemptId: string) => DurableRunWriter)
    | undefined
  >;
}

export async function runNativeAgentTurn(
  host: NativeAgentRunHost,
  request: AgentTurnRequest,
  preparedContext?: PreparedExecutionContext | string,
  requestedPermissionMode?: PermissionMode,
  parentAttemptId?: string,
  control?: NativeAgentRunControl,
): Promise<ExecutionAttempt | undefined> {
  const {
    backend,
    options,
    setState,
    activeBackendRef,
    activeAttemptIdRef,
    activePersistenceRef,
    onToolCallRef,
    executeRef,
    authorizeRef,
    shouldCancelRef,
    threadIdRef,
    contextScopeRef,
    loadConversationRef,
    attributeHistoryRef,
    modelsRef,
    createDurableRunWriterRef,
  } = host;
  let persisted: ExecutionAttempt | null = null;
  const persistence = createAttemptPersistence(saveRuntimeExecutionAttempt);
  if (activeAttemptIdRef.current) {
    setState((current) => ({
      ...current,
      lastError:
        "Wait for the current response to finish before starting another one.",
    }));
    return;
  }
  setState((current) => ({ ...current, lastError: null, contextFailure: undefined }));
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
    validateReasoningEffort(
      providerId,
      modelsRef.current.find((model) => model.id === request.model) ??
        backend.backend.models.find((model) => model.id === request.model),
      request.reasoningEffort,
    );
  } catch (error) {
    setState((current) => ({
      ...current,
      lastError:
        error instanceof Error
          ? error.message
          : "Choose a reasoning level again.",
      status: "failed",
    }));
    return;
  }
  const generatedAttemptId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const prepared = resolvePreparedAttemptContext(
    preparedContext,
    generatedAttemptId,
    createdAt,
    threadIdRef.current,
  );
  const attemptId = prepared.receipt.attemptId;
  activeAttemptIdRef.current = attemptId;
  const requestThreadId = threadIdRef.current;
  const requestContextScope = contextScopeRef.current;
  const requestContextScopeKey = JSON.stringify(requestContextScope);
  const isCurrentScope = () =>
    JSON.stringify(contextScopeRef.current) === requestContextScopeKey;
  const isCurrentThread = () => threadIdRef.current === requestThreadId;
  let history: AgentTurnRequest["messages"] = [];
  let historyEntries: Awaited<
    Extract<
      Awaited<ReturnType<typeof loadContinuationHistory>>,
      { ok: true }
    >
  >["historyEntries"] = [];
  if (requestThreadId && loadConversationRef.current) {
    const loaded = await loadContinuationHistory({
      requestThreadId,
      parentAttemptId,
      loadConversation: loadConversationRef.current,
      attributeHistory: attributeHistoryRef.current,
      isCurrentThread,
      isCurrentScope,
    });
    if (!loaded.ok) {
      activeAttemptIdRef.current = null;
      if (!isCurrentScope()) return;
      setState((current) => ({
        ...current,
        lastError:
          loaded.error instanceof Error
            ? loaded.error.message
            : "Could not read this conversation.",
        status: "failed",
        currentAttemptId: null,
      }));
      return;
    }
    history = loaded.history;
    historyEntries = loaded.historyEntries;
  }
  const provider = options.providers.find(
    (candidate) => candidate.id === providerId,
  );
  const selectedModel =
    modelsRef.current.find((model) => model.id === request.model) ??
    backend.backend.models.find((model) => model.id === request.model);
  const planned = await planAttemptContext({
    history,
    request,
    contextPrefix: prepared.systemPrefix,
    selectedModel,
    provider,
    backendType: provider?.backendType ?? backend.backend.backendType,
    requestThreadId,
    historyEntries,
    isCurrentScope,
    isCurrentThread,
  });
  if (planned.stale) {
    if (activeAttemptIdRef.current === attemptId)
      activeAttemptIdRef.current = null;
    return;
  }
  if (!isCurrentScope()) {
    if (activeAttemptIdRef.current === attemptId)
      activeAttemptIdRef.current = null;
    return;
  }
  const { plan, prefix: effectiveContextPrefix } = planned;
  if (!plan.ok) {
    activeAttemptIdRef.current = null;
    setState((current) => ({
      ...current,
      lastError: plan.message,
      contextFailure: contextFailureState(
        plan,
        request,
        requestContextScope,
      ),
      status: "failed",
      currentAttemptId: null,
    }));
    return;
  }
  const contextPlan = plan;
  const providerRequest = { ...request, messages: contextPlan.messages };
  const selectedRoute = await selectAttemptProviderRoute({
    provider,
    providerId,
    model: request.model,
    request,
    contextPlan,
  });
  if (!selectedRoute.ok) {
    setState((current) => ({
      ...current,
      lastError: selectedRoute.message,
      status: "failed",
      currentAttemptId: null,
    }));
    activeAttemptIdRef.current = null;
    return;
  }
  const providerRoute = selectedRoute.route;
  if (
    activeAttemptIdRef.current !== attemptId ||
    threadIdRef.current !== requestThreadId ||
    !isCurrentScope() ||
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
    progressPrompt: request.messages
      .filter((message) => message.role === "user")
      .at(-1)?.content,
    responseParts: [],
    startedAt: createdAt,
    endedAt: undefined,
    progressAgentId: options.computer?.agentId,
    usage: null,
    running: true,
    stopRequested: false,
    lastError: null,
    contextFailure: undefined,
    status: "queued",
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
  const initialExchanges = buildQueuedExchanges(request, control);
  persisted = buildQueuedAttempt({
    attemptId,
    providerId,
    model: request.model,
    threadId: requestThreadId,
    exchanges: initialExchanges,
    parentAttemptId,
    contextReceipt: prepared.receipt,
    providerRoute,
    createdAt,
  });
  persistence.current = persisted;
  activePersistenceRef.current = persistence;
  const durableWriter = requestThreadId
    ? (createDurableRunWriterRef.current?.(requestThreadId, attemptId) ??
      null)
    : null;
  persistence.setWriter(durableWriter);
  try {
    await persistence.save(persisted);
    if (persistence.stopped) return persistence.current ?? undefined;
  } catch (error) {
    if (persistence.stopped) return persistence.current ?? undefined;
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
    persistence.current = failed;
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
      await persistence.save(failed);
    } catch {
      /* persistence is already the reported terminal failure */
    }
    activeAttemptIdRef.current = null;
    activePersistenceRef.current = null;
    return;
  }
  try {
    await control?.afterAttemptQueued?.({
      attemptId,
      threadId: requestThreadId,
    });
  } catch (error) {
    if (persistence.stopped) return persistence.current ?? undefined;
    const message =
      error instanceof Error
        ? error.message
        : "Could not authorize the queued agent contribution.";
    const failed: ExecutionAttempt = {
      ...persisted,
      status: "failed",
      recoverable: true,
      error: message,
      updatedAt: new Date().toISOString(),
    };
    persisted = failed;
    persistence.current = failed;
    try {
      await persistence.save(failed);
    } catch {
      /* the queued journal already records the failed boundary */
    }
    setState((current) => ({
      ...current,
      running: false,
      status: "failed",
      lastError: message,
      endedAt: failed.updatedAt,
      recoverableAttempts: prependRecoverableAttempt(
        current.recoverableAttempts,
        failed,
      ),
      currentAttemptId: null,
    }));
    activeAttemptIdRef.current = null;
    activePersistenceRef.current = null;
    return failed;
  }
  const cancelledAfterQueue = Boolean(shouldCancelRef.current?.());
  const staleAfterQueue =
    activeAttemptIdRef.current !== attemptId ||
    threadIdRef.current !== requestThreadId ||
    persistence.stopped;
  if (cancelledAfterQueue || staleAfterQueue) {
    const alreadyCancelled = persistence.stopped;
    const message =
      cancelledAfterQueue || alreadyCancelled
        ? "The queued agent contribution was cancelled before it started."
        : "The conversation changed before the queued agent contribution could start.";
    const terminal: ExecutionAttempt = alreadyCancelled
      ? persistence.current!
      : {
          ...persisted,
          status: cancelledAfterQueue ? "cancelled" : "failed",
          recoverable: !cancelledAfterQueue,
          error: message,
          updatedAt: new Date().toISOString(),
        };
    persisted = terminal;
    if (!alreadyCancelled) {
      try {
        await persistence.save(terminal);
      } catch {
        /* the queued journal remains recoverable */
      }
    }
    setState((current) => ({
      ...current,
      running: false,
      status: terminal.status,
      lastError: message,
      endedAt: terminal.updatedAt,
      recoverableAttempts: terminal.recoverable
        ? prependRecoverableAttempt(current.recoverableAttempts, terminal)
        : current.recoverableAttempts,
      currentAttemptId: null,
    }));
    activeAttemptIdRef.current = null;
    activePersistenceRef.current = null;
    return terminal;
  }
  try {
    if (durableWriter && control?.canonicalUserMessage !== "suppress") {
      const userExchanges = initialExchanges.filter(
        (entry) => entry.role === "user",
      );
      for (const [index, exchange] of userExchanges.entries()) {
        await persistence.record({
          kind: "user",
          content: exchange.content,
          ...(index === userExchanges.length - 1 && control?.attachments?.length
            ? { attachments: control.attachments }
            : {}),
        });
      }
    }
    if (persistence.stopped) return persistence.current ?? undefined;
    persisted = {
      ...persisted,
      status: "streaming",
      updatedAt: new Date().toISOString(),
    };
    persistence.current = persisted;
    await persistence.save(persisted);
    if (persistence.stopped) return persistence.current ?? undefined;
    setState((current) => ({ ...current, status: "streaming" }));
  } catch (error) {
    if (persistence.stopped) return persistence.current ?? undefined;
    const message =
      error instanceof Error
        ? error.message
        : "Could not save the conversation before it started.";
    const failed: ExecutionAttempt = {
      ...persisted,
      status: "failed",
      recoverable: true,
      error: message,
      updatedAt: new Date().toISOString(),
    };
    persisted = failed;
    persistence.current = failed;
    setState((current) => ({
      ...current,
      running: false,
      status: "failed",
      lastError: message,
      recoverableAttempts: prependRecoverableAttempt(
        current.recoverableAttempts,
        failed,
      ),
      currentAttemptId: null,
    }));
    try {
      await persistence.save(failed);
    } catch {
      /* preserve the original terminal failure */
    }
    activeAttemptIdRef.current = null;
    activePersistenceRef.current = null;
    return failed;
  }
  const pendingApprovalByCall = new Map<string, string>();
  const toolNameByCall = new Map<string, string>();
  const permissionMode: PermissionMode =
    requestedPermissionMode ?? "trusted-scope";
  const session: NativeAgentEventSession = {
    persisted,
    persistence,
    durableWriter,
    attemptId,
    setState,
    onToolCall: () => onToolCallRef.current,
    onTextDelta: control?.onTextDelta,
    pendingApprovalByCall,
    toolNameByCall,
    lastPersistedTranscriptLength: 0,
    lastPersistedAt: Date.now(),
  };
  const eventStream = backend.run(
    { ...providerRequest, ...(providerRoute ? { providerRoute } : {}) },
    {
      execute: createComputerTaskExecutor(
        executeRef.current ??
          (async () => {
            throw new Error(
              "Tool execution pending approval in the shell.",
            );
          }),
        (activity) => setState((current) => ({ ...current, activity })),
      ),
      authorize: authorizeRef.current,
      shouldCancel: shouldCancelRef.current ?? (() => false),
      contextPrefix: effectiveContextPrefix,
      permissionMode,
      maxTurns: control?.maxTurns,
      attemptId,
      computer: options.computer,
      onRetry: () => {
        if (!session.persisted || persistence.stopped) return;
        session.persisted = {
          ...session.persisted,
          status: "retrying",
          retryCount: session.persisted.retryCount + 1,
          updatedAt: new Date().toISOString(),
        };
        persistence.current = session.persisted;
        void persistence.save(session.persisted).catch((error: unknown) => {
          if (!persistence.stopped)
            setState((current) => ({
              ...current,
              lastError:
                error instanceof Error
                  ? error.message
                  : "Could not save retry progress.",
            }));
        });
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
    activePersistenceRef.current = null;
    return;
  }
  activeBackendRef.current = backend;
  activeAttemptIdRef.current = attemptId;
  try {
    await consumeNativeAgentEvents(eventStream, session);
    persisted = session.persisted;
  } catch (error) {
    persisted = session.persisted;
    if (persistence.stopped) return persistence.current ?? undefined;
    persisted = await failNativeAgentRun(
      session,
      error,
      Boolean(shouldCancelRef.current?.()),
    );
  } finally {
    if (activePersistenceRef.current === persistence) {
      activeBackendRef.current = null;
      activeAttemptIdRef.current = null;
      activePersistenceRef.current = null;
    }
  }
  return persisted ?? undefined;
}
