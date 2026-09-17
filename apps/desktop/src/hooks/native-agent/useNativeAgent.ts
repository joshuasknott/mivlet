import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTurnRequest,
  ExecutionAttempt,
  PermissionMode,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import type { AttemptPersistence } from "../../lib/attempt-persistence";
import {
  listRuntimeExecutionAttempts,
  recoverRuntimeExecutionAttempts,
} from "../../runtime/domains/workspace";
import {
  CONVERSATION_STYLE_INSTRUCTIONS,
  toolActivity,
} from "../../lib/conversation-presentation";
import type { AgentBackend } from "@mivlet/connectors";
import { cancelNativeAgentRun } from "./cancellation";
import { nativeAgentContextScope } from "./context";
import {
  createNativeAgentBackendDeps,
  resolveStreamingBackend,
  resolveStreamingBackendById,
} from "./providers";
import { mergeRecoveredAttempts } from "./recovery";
import { buildRetryTurnRequest, describeRetryBlock } from "./retry";
import { runNativeAgentTurn, type NativeAgentRunHost } from "./run";
import {
  clearNativeAgentPresentation,
  createInitialNativeAgentState,
} from "./runtime";
import type {
  NativeAgentRunControl,
  NativeAgentState,
  UseNativeAgentOptions,
} from "./types";

export function useNativeAgent(options: UseNativeAgentOptions) {
  const [state, setState] = useState<NativeAgentState>(
    createInitialNativeAgentState,
  );
  const activeBackendRef = useRef<AgentBackend | null>(null);
  const activeAttemptIdRef = useRef<string | null>(null);
  const activePersistenceRef = useRef<AttemptPersistence | null>(null);
  const onToolCallRef = useRef(options.onToolCall);
  onToolCallRef.current = options.onToolCall;
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
  const contextScope = nativeAgentContextScope({
    workspaceId: options.computer?.workspaceId,
    agentId: options.computer?.agentId,
    threadId: options.threadId,
    ownerInternalUserId: options.contextOwner?.internalUserId,
    ownerMemberId: options.contextOwner?.memberId,
  });
  const contextScopeKey = JSON.stringify(contextScope);
  const contextScopeRef = useRef(contextScope);
  contextScopeRef.current = contextScope;
  const presentationScopeRef = useRef(contextScopeKey);
  const loadConversationRef = useRef(options.loadConversation);
  loadConversationRef.current = options.loadConversation;
  const attributeHistoryRef = useRef(options.attributeHistory);
  attributeHistoryRef.current = options.attributeHistory;
  const modelsRef = useRef(options.models ?? []);
  modelsRef.current = options.models ?? [];
  const createDurableRunWriterRef = useRef(options.createDurableRunWriter);
  createDurableRunWriterRef.current = options.createDurableRunWriter;

  useEffect(() => {
    if (options.recover === false) return;
    void (async () => {
      const recovered = await recoverRuntimeExecutionAttempts(
        new Date().toISOString(),
      ).catch(() => null);
      const listed = await listRuntimeExecutionAttempts().catch(() => null);
      const runs = listed ?? recovered;
      if (!runs) return;
      setState((current) => mergeRecoveredAttempts(current, runs));
    })();
  }, []);

  const deps = useMemo(() => createNativeAgentBackendDeps(), []);
  const backend: AgentBackend | null = useMemo(
    () =>
      resolveStreamingBackend(
        options.providers,
        options.activeProviderId,
        deps,
      ),
    [options.providers, options.activeProviderId, deps],
  );
  const resolveBackend = useCallback(
    (providerId: string): AgentBackend | null =>
      resolveStreamingBackendById(options.providers, providerId, deps),
    [options.providers, deps],
  );

  const run = useCallback(
    (
      request: AgentTurnRequest,
      preparedContext?: PreparedExecutionContext | string,
      requestedPermissionMode?: PermissionMode,
      parentAttemptId?: string,
      control?: NativeAgentRunControl,
    ) => {
      const host: NativeAgentRunHost = {
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
      };
      return runNativeAgentTurn(
        host,
        request,
        preparedContext,
        requestedPermissionMode,
        parentAttemptId,
        control,
      );
    },
    [
      backend,
      options.providers,
      options.computer?.workspaceId,
      options.computer?.agentId,
    ],
  );

  const retry = useCallback(
    async (
      attemptToRetry: ExecutionAttempt,
      tools: AgentTurnRequest["tools"] = [],
      permissionMode: PermissionMode = "read-only",
      instructions: string = CONVERSATION_STYLE_INSTRUCTIONS,
      control?: NativeAgentRunControl,
    ) => {
      const blocked = describeRetryBlock(attemptToRetry, {
        threadId: threadIdRef.current,
        models: modelsRef.current,
        backend,
      });
      if (blocked) {
        setState((current) => ({ ...current, lastError: blocked }));
        return;
      }
      const retryRequest = buildRetryTurnRequest(
        attemptToRetry,
        tools,
        instructions,
      );
      if (!retryRequest) {
        setState((current) => ({
          ...current,
          lastError:
            "This interrupted run does not contain a safe user prompt to retry.",
        }));
        return;
      }
      await run(
        retryRequest,
        undefined,
        permissionMode,
        attemptToRetry.id,
        control,
      );
    },
    [run],
  );

  const markToolExecuting = useCallback((approvalId: string, tool: string) => {
    const persistence = activePersistenceRef.current;
    const persistedAttempt = persistence?.current;
    if (
      !persistedAttempt ||
      !persistedAttempt.pendingApprovalIds.includes(approvalId) ||
      persistedAttempt.status === "cancelled"
    )
      return;
    persistence.current = {
      ...persistedAttempt,
      status: "streaming",
      pendingApprovalIds: persistedAttempt.pendingApprovalIds.filter(
        (id) => id !== approvalId,
      ),
    };
    setState((current) =>
      current.running && current.currentAttemptId === persistedAttempt.id
        ? {
            ...current,
            status: "streaming",
            activity: toolActivity(tool, "running"),
          }
        : current,
    );
  }, []);

  const cancel = useCallback(async () => {
    const attemptToCancel = activeAttemptIdRef.current;
    await cancelNativeAgentRun({
      backendToCancel: activeBackendRef.current,
      attemptToCancel,
      persistence: activePersistenceRef.current,
      setState,
      onCancel: () => onCancelRef.current?.(),
      clearActive: (persistence) => {
        if (activePersistenceRef.current === persistence) {
          activeBackendRef.current = null;
          activeAttemptIdRef.current = null;
          activePersistenceRef.current = null;
        }
      },
    });
    if (activeAttemptIdRef.current === attemptToCancel)
      activeAttemptIdRef.current = null;
  }, []);

  const getActiveAttemptId = useCallback(() => activeAttemptIdRef.current, []);

  useEffect(() => {
    if (presentationScopeRef.current === contextScopeKey) return;
    presentationScopeRef.current = contextScopeKey;
    if (activeAttemptIdRef.current) void cancel();
    setState(clearNativeAgentPresentation);
  }, [cancel, contextScopeKey]);

  useEffect(
    () => () => {
      if (activeAttemptIdRef.current) void cancel();
    },
    [cancel],
  );

  const reportError = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      running: false,
      lastError: message,
      contextFailure: undefined,
      transcript: "",
      reasoningSummaries: {},
      activity: "",
      usage: null,
      status: "failed",
      currentAttemptId: null,
    }));
  }, []);

  const clearError = useCallback(() => {
    setState((current) =>
      current.lastError === null && !current.contextFailure
        ? current
        : {
            ...current,
            lastError: null,
            contextFailure: undefined,
            status: current.status === "failed" ? "idle" : current.status,
          },
    );
  }, []);

  return {
    state,
    run,
    retry,
    cancel,
    markToolExecuting,
    reportError,
    getActiveAttemptId,
    clearError,
    backend,
    resolveBackend,
  };
}
