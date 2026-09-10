import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendRuntimeConversationMessage,
  createRuntimeConversationThread,
  deleteRuntimeConversationDraft,
  deleteRuntimeConversationThread,
  getRuntimeConversationThread,
  listRuntimeConversationMessages,
  listRuntimeConversationThreads,
  loadRuntimeConversationDraft,
  reviseRuntimeConversationMessage,
  saveRuntimeConversationDraft,
  updateRuntimeConversationThread,
  type RuntimeConversationDraft,
} from "../runtime";
import {
  createConversationRuntime,
  createDurableRunWriter,
  newThreadDraftKey,
  threadDraftKey,
  type ConversationMessageAppend,
  type ConversationMessageRevision,
  type ConversationThreadCreate,
  type ConversationThreadUpdate,
} from "../lib/conversation-runtime";

export interface UseDurableConversationOptions {
  /** Changes whenever account reconciliation selects another workspace. */
  workspaceId?: string;
  threadId?: string;
}

export interface DurableConversationState {
  threads: Awaited<ReturnType<typeof listRuntimeConversationThreads>>;
  conversation: Awaited<
    ReturnType<ReturnType<typeof createConversationRuntime>["hydrate"]>
  >;
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
  deleteDraft: deleteRuntimeConversationDraft,
});

/** Read a fresh, thread-validated history before a provider request. */
export const loadDesktopConversation = (threadId: string) => runtime.hydrate(threadId);

/** Shared callback for the agent loop; UI callers use the hook below. */
export function createDesktopDurableRunWriter(threadId: string, runId: string) {
  return createDurableRunWriter(
    {
      createThread: createRuntimeConversationThread,
      listThreads: listRuntimeConversationThreads,
      getThread: getRuntimeConversationThread,
      updateThread: updateRuntimeConversationThread,
      listMessages: listRuntimeConversationMessages,
      appendMessage: appendRuntimeConversationMessage,
      reviseMessage: reviseRuntimeConversationMessage,
      loadDraft: loadRuntimeConversationDraft,
      saveDraft: saveRuntimeConversationDraft,
      deleteDraft: deleteRuntimeConversationDraft,
    },
    threadId,
    runId,
  );
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
    error: null,
  });
  const generation = useRef(0);
  const workspaceRef = useRef(options.workspaceId);
  workspaceRef.current = options.workspaceId;
  const draftKey = options.threadId
    ? threadDraftKey(options.threadId)
    : newThreadDraftKey();

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!options.workspaceId) {
      setState({
        threads: [],
        conversation: null,
        draft: null,
        loading: false,
        error: null,
      });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [threads, conversation, draft] = await Promise.all([
        runtime.listThreads(),
        options.threadId
          ? runtime.hydrate(options.threadId)
          : Promise.resolve(null),
        runtime.loadDraft(draftKey),
      ]);
      if (request !== generation.current) return;
      setState({ threads, conversation, draft, loading: false, error: null });
    } catch (error) {
      if (request !== generation.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not load this conversation.",
      }));
    }
  }, [draftKey, options.threadId, options.workspaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const createThread = useCallback(
    async (input: ConversationThreadCreate) => {
      if (!options.workspaceId) throw new Error("Choose a workspace before starting a conversation.");
      const thread = await createRuntimeConversationThread(input, options.workspaceId);
      await refresh();
      return thread;
    },
    [options.workspaceId, refresh],
  );

  const deleteThread = useCallback(async (threadId: string) => {
    const workspaceId = workspaceRef.current;
    await deleteRuntimeConversationThread(threadId);
    if (workspaceRef.current !== workspaceId) return;
    generation.current += 1;
    setState((current) => ({ ...current,
      threads: current.threads.filter((thread) => thread.id !== threadId),
      conversation: current.conversation?.thread.id === threadId ? null : current.conversation,
      draft: current.draft?.threadId === threadId ? null : current.draft,
      loading: false, error: null,
    }));
  }, []);

  const updateThread = useCallback(
    async (input: ConversationThreadUpdate) => {
      const thread = await runtime.updateThread(input);
      await refresh();
      return thread;
    },
    [refresh],
  );

  const appendMessage = useCallback(
    async (input: ConversationMessageAppend) => {
      const view = await runtime.appendMessage(input);
      await refresh();
      return view;
    },
    [refresh],
  );

  const reviseMessage = useCallback(
    async (input: ConversationMessageRevision) => {
      const view = await runtime.reviseMessage(input);
      await refresh();
      return view;
    },
    [refresh],
  );

  const saveDraft = useCallback(
    async (content: string) => {
      const saved = await runtime.saveDraft({
        draftKey,
        threadId: options.threadId,
        content,
        updatedAt: new Date().toISOString(),
      });
      // A save belongs to this exact scope/key. Do not let it repaint a thread
      // selected after the await.
      if (workspaceRef.current === options.workspaceId) {
        setState((current) =>
          current.draft?.draftKey === draftKey || !current.draft
            ? { ...current, draft: saved }
            : current,
        );
      }
      return saved;
    },
    [draftKey, options.threadId, options.workspaceId],
  );

  const deleteDraft = useCallback(async () => {
    await runtime.deleteDraft(draftKey);
    setState((current) =>
      current.draft?.draftKey === draftKey
        ? { ...current, draft: null }
        : current,
    );
  }, [draftKey]);

  return useMemo(
    () => ({
      state,
      draftKey,
      refresh,
      createThread,
      deleteThread,
      updateThread,
      appendMessage,
      reviseMessage,
      saveDraft,
      deleteDraft,
    }),
    [
      appendMessage,
      createThread,
      deleteThread,
      deleteDraft,
      draftKey,
      refresh,
      reviseMessage,
      saveDraft,
      state,
      updateThread,
    ],
  );
}
