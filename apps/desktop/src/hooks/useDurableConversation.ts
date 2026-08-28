import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendRuntimeConversationMessage,
  createRuntimeConversationThread,
  deleteRuntimeConversationDraft,
  getRuntimeConversationThread,
  listRuntimeConversationMessages,
  listRuntimeConversationThreads,
  loadRuntimeConversationDraft,
  reviseRuntimeConversationMessage,
  saveRuntimeConversationDraft,
  updateRuntimeConversationThread,
  type RuntimeConversationDraft
} from "../runtime";
import {
  createConversationRuntime,
  createDurableRunWriter,
  newThreadDraftKey,
  threadDraftKey,
  type ConversationMessageAppend,
  type ConversationMessageRevision,
  type ConversationThreadCreate,
  type ConversationThreadUpdate
} from "../lib/conversation-runtime";

export interface UseDurableConversationOptions {
  /** Changes whenever account reconciliation selects another workspace. */
  workspaceId?: string;
  threadId?: string;
}

export interface DurableConversationState {
  threads: Awaited<ReturnType<typeof listRuntimeConversationThreads>>;
  conversation: Awaited<ReturnType<ReturnType<typeof createConversationRuntime>["hydrate"]>>;
  draft: RuntimeConversationDraft | null;
  loading: boolean;
  error: string | null;
}

const runtime = createConversationRuntime({
  createThread: createRuntimeConversationThread,
  listThreads: listRuntimeConversationThreads,
  getThread: getRuntimeConversationThread,
  updateThread: updateRuntimeConversationThread,
  listMessages: listRuntimeConversationMessages,
  appendMessage: appendRuntimeConversationMessage,
  reviseMessage: reviseRuntimeConversationMessage,
  loadDraft: loadRuntimeConversationDraft,
  saveDraft: saveRuntimeConversationDraft,
  deleteDraft: deleteRuntimeConversationDraft
});

/** Shared callback for the agent loop; UI callers use the hook below. */
export function createDesktopDurableRunWriter(threadId: string, runId: string) {
  return createDurableRunWriter({
    createThread: createRuntimeConversationThread,
    listThreads: listRuntimeConversationThreads,
    getThread: getRuntimeConversationThread,
    updateThread: updateRuntimeConversationThread,
    listMessages: listRuntimeConversationMessages,
    appendMessage: appendRuntimeConversationMessage,
    reviseMessage: reviseRuntimeConversationMessage,
    loadDraft: loadRuntimeConversationDraft,
    saveDraft: saveRuntimeConversationDraft,
    deleteDraft: deleteRuntimeConversationDraft
  }, threadId, runId);
}

/**
 * React state around the durable conversation transport. A monotonically
 * increasing generation fences all late workspace/thread responses, including
 * a draft read that resolves after the user has switched threads.
 */
export function useDurableConversation(options: UseDurableConversationOptions) {
  const [state, setState] = useState<DurableConversationState>({
    threads: [],
    conversation: null,
    draft: null,
    loading: false,
    error: null
  });
  const generation = useRef(0);
  const workspaceRef = useRef(options.workspaceId);
  workspaceRef.current = options.workspaceId;
  const draftKey = options.threadId ? threadDraftKey(options.threadId) : newThreadDraftKey();

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [threads, conversation, draft] = await Promise.all([
        runtime.listThreads(),
        options.threadId ? runtime.hydrate(options.threadId) : Promise.resolve(null),
        runtime.loadDraft(draftKey)
      ]);
      if (request !== generation.current) return;
      setState({ threads, conversation, draft, loading: false, error: null });
    } catch (error) {
      if (request !== generation.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Could not load this conversation."
      }));
    }
  }, [draftKey, options.threadId, options.workspaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const createThread = useCallback(async (input: ConversationThreadCreate) => {
    const thread = await runtime.createThread(input);
    await refresh();
    return thread;
  }, [refresh]);

  const updateThread = useCallback(async (input: ConversationThreadUpdate) => {
    const thread = await runtime.updateThread(input);
    await refresh();
    return thread;
  }, [refresh]);

  const appendMessage = useCallback(async (input: ConversationMessageAppend) => {
    const view = await runtime.appendMessage(input);
    await refresh();
    return view;
  }, [refresh]);

  const reviseMessage = useCallback(async (input: ConversationMessageRevision) => {
    const view = await runtime.reviseMessage(input);
    await refresh();
    return view;
  }, [refresh]);

  const saveDraft = useCallback(async (content: string) => {
    const saved = await runtime.saveDraft({
      draftKey,
      threadId: options.threadId,
      content,
      updatedAt: new Date().toISOString()
    });
    // A save belongs to this exact scope/key. Do not let it repaint a thread
    // selected after the await.
    if (workspaceRef.current === options.workspaceId) {
      setState((current) => current.draft?.draftKey === draftKey || !current.draft
        ? { ...current, draft: saved }
        : current);
    }
    return saved;
  }, [draftKey, options.threadId, options.workspaceId]);

  const deleteDraft = useCallback(async () => {
    await runtime.deleteDraft(draftKey);
    setState((current) => current.draft?.draftKey === draftKey ? { ...current, draft: null } : current);
  }, [draftKey]);

  return useMemo(() => ({
    state,
    draftKey,
    refresh,
    createThread,
    updateThread,
    appendMessage,
    reviseMessage,
    saveDraft,
    deleteDraft
  }), [appendMessage, createThread, deleteDraft, draftKey, refresh, reviseMessage, saveDraft, state, updateThread]);
}
