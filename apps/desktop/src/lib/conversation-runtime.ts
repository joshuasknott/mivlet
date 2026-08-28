import type { Spine } from "@fable/protocol";

export type ConversationThread = Spine.Conversations.Thread;
export type ConversationMessage = Spine.Conversations.Message;
export type ConversationRevision = Spine.Conversations.MessageRevision;
export type ConversationThreadCreate = Spine.Conversations.ThreadCreateInput;
export type ConversationThreadUpdate = Spine.Conversations.ThreadUpdateInput;
export type ConversationMessageAppend = Spine.Conversations.MessageAppendInput;
export type ConversationMessageRevision = Spine.Conversations.MessageRevisionCreateInput;

/** The current, renderable checkpoint for one ordered transcript record. */
export interface ConversationMessageView {
  message: ConversationMessage;
  currentRevision: ConversationRevision;
}

export interface ConversationDraft {
  draftKey: string;
  threadId?: string;
  content: string;
  updatedAt: string;
}

/** The renderer-facing part of the native conversation boundary. */
export interface ConversationTransport {
  createThread(input: ConversationThreadCreate): Promise<ConversationThread>;
  listThreads(): Promise<ConversationThread[]>;
  getThread(threadId: string): Promise<ConversationThread | null>;
  updateThread(input: ConversationThreadUpdate): Promise<ConversationThread>;
  listMessages(threadId: string): Promise<ConversationMessageView[]>;
  appendMessage(input: ConversationMessageAppend): Promise<ConversationMessageView>;
  reviseMessage(input: ConversationMessageRevision): Promise<ConversationMessageView>;
  loadDraft(draftKey: string): Promise<ConversationDraft | null>;
  saveDraft(draft: ConversationDraft): Promise<ConversationDraft>;
  deleteDraft(draftKey: string): Promise<void>;
}

export interface HydratedConversation {
  thread: ConversationThread;
  messages: ConversationMessageView[];
}

export const NEW_THREAD_DRAFT_PREFIX = "new-thread";

export function newThreadDraftKey() {
  return NEW_THREAD_DRAFT_PREFIX;
}

export function threadDraftKey(threadId: string) {
  return `thread:${threadId}`;
}

/**
 * A small, transport-only facade. It deliberately owns no React state, making
 * it safe for the shell, hooks, and agent lifecycle to share without allowing
 * callers to invent a workspace scope.
 */
export function createConversationRuntime(transport: ConversationTransport) {
  return {
    listThreads: () => transport.listThreads(),
    createThread: (input: ConversationThreadCreate) => transport.createThread(input),
    updateThread: (input: ConversationThreadUpdate) => transport.updateThread(input),
    getThread: (threadId: string) => transport.getThread(threadId),
    async hydrate(threadId: string): Promise<HydratedConversation | null> {
      const [thread, views] = await Promise.all([
        transport.getThread(threadId),
        transport.listMessages(threadId)
      ]);
      if (!thread) return null;
      const messages = [...views].sort((left, right) => left.message.sequence - right.message.sequence);
      for (const view of messages) {
        if (view.message.threadId !== thread.id || view.currentRevision.threadId !== thread.id) {
          throw new Error("Conversation response contains a message outside its thread.");
        }
      }
      return { thread, messages };
    },
    appendMessage: (input: ConversationMessageAppend) => transport.appendMessage(input),
    reviseMessage: (input: ConversationMessageRevision) => transport.reviseMessage(input),
    loadDraft: (draftKey: string) => transport.loadDraft(draftKey),
    saveDraft: (draft: ConversationDraft) => transport.saveDraft(draft),
    deleteDraft: (draftKey: string) => transport.deleteDraft(draftKey)
  };
}

export type DurableRunRecord =
  | { kind: "user" | "assistant"; content: string; state?: "streaming" | "terminal" }
  | { kind: "tool-call"; content: string; callId: string; toolName: string }
  | { kind: "tool-result"; content: string; callId: string; toolName: string; ok: boolean }
  | { kind: "approval-request"; content: string; approvalRequestId: string }
  | { kind: "approval-decision"; content: string; approvalRequestId: string; decisionId: string; decision: Spine.Conversations.ApprovalMessageDecision }
  | { kind: "interruption"; content: string; reason: Spine.Conversations.InterruptionReason }
  | { kind: "error"; content: string; code: string; retryable: boolean };

export interface DurableRunWriter {
  record(record: DurableRunRecord): Promise<void>;
  checkpointAssistant(content: string, terminal?: boolean): Promise<void>;
}

/**
 * Serializes one run's canonical transcript writes. Every append/revision has a
 * deterministic idempotency key, so retrying an interrupted renderer write is
 * safe while a different run cannot consume this writer's sequence cursor.
 */
export function createDurableRunWriter(
  transport: ConversationTransport,
  threadId: string,
  runId: string
): DurableRunWriter {
  let initialized: Promise<{ thread: ConversationThread; messages: ConversationMessageView[] }> | null = null;
  let chain = Promise.resolve();
  let nextSequence = 0;
  let previousMessageId: string | undefined;
  let ordinal = 0;
  let assistant: ConversationMessageView | null = null;

  const initialize = async () => {
    if (!initialized) {
      initialized = Promise.all([transport.getThread(threadId), transport.listMessages(threadId)]).then(
        ([thread, messages]) => {
          if (!thread) throw new Error("The active conversation no longer exists in this workspace.");
          const ordered = [...messages].sort((a, b) => a.message.sequence - b.message.sequence);
          nextSequence = thread.messageHead.lastSequence;
          previousMessageId = thread.messageHead.lastMessageId;
          return { thread, messages: ordered };
        }
      );
    }
    return initialized;
  };

  const enqueue = <T>(work: () => Promise<T>) => {
    const result = chain.then(work, work);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };

  const append = async (record: DurableRunRecord) => {
    const { thread } = await initialize();
    const currentOrdinal = ordinal++;
    const now = new Date().toISOString();
    const messageId = `message-${runId}-${currentOrdinal}` as never;
    const revisionId = `revision-${runId}-${currentOrdinal}-1` as never;
    const idempotencyKey = `${runId}:message:${currentOrdinal}`;
    const kindDetail = record.kind === "tool-call"
      ? { kind: "tool" as const, detail: { phase: "call" as const, toolCallId: record.callId, toolName: record.toolName } }
      : record.kind === "tool-result"
        ? { kind: "tool" as const, detail: { phase: "result" as const, toolCallId: record.callId, toolName: record.toolName, outcome: record.ok ? "succeeded" as const : "failed" as const } }
        : record.kind === "approval-request"
          ? { kind: "approval" as const, detail: { phase: "request" as const, approvalRequestId: record.approvalRequestId } }
          : record.kind === "approval-decision"
            ? { kind: "approval" as const, detail: { phase: "decision" as const, approvalRequestId: record.approvalRequestId, approvalDecisionId: record.decisionId, decision: record.decision } }
            : record.kind === "interruption"
              ? { kind: "interruption" as const, detail: { reason: record.reason } }
              : record.kind === "error"
                ? { kind: "error" as const, detail: { code: record.code, retryable: record.retryable } }
                : { kind: record.kind };
    const view = await transport.appendMessage({
      ...kindDetail,
      threadId: thread.id,
      messageId,
      expectedLastSequence: nextSequence,
      sequence: nextSequence + 1,
      previousMessageId: previousMessageId as never,
      idempotencyKey,
      correlationKey: `${runId}:${currentOrdinal}`,
      runId: runId as never,
      initialRevision: {
        revisionId,
        state: record.kind === "assistant" && record.state === "streaming" ? "streaming" : "terminal",
        content: record.content,
        reason: "initial",
        idempotencyKey: `${idempotencyKey}:revision:1`,
        checkpointedAt: now,
        runId: runId as never
      }
    } as ConversationMessageAppend);
    nextSequence = view.message.sequence;
    previousMessageId = view.message.id;
    if (record.kind === "assistant") assistant = view;
  };

  return {
    record: (record) => enqueue(() => append(record)),
    checkpointAssistant: (content, terminal = false) => enqueue(async () => {
      if (!assistant) {
        await append({ kind: "assistant", content, state: terminal ? "terminal" : "streaming" });
        return;
      }
      const now = new Date().toISOString();
      const revisionNumber = assistant.message.currentRevisionNumber + 1;
      const revision = await transport.reviseMessage({
        threadId: assistant.message.threadId,
        messageId: assistant.message.id,
        revisionId: `revision-${runId}-assistant-${revisionNumber}` as never,
        baseMessageRevisionNumber: assistant.message.currentRevisionNumber,
        previousRevisionId: assistant.message.currentRevisionId,
        state: terminal ? "terminal" : "streaming",
        content,
        reason: terminal ? "completion" : "stream-checkpoint",
        idempotencyKey: `${runId}:assistant:revision:${revisionNumber}`,
        correlationKey: `${runId}:assistant`,
        checkpointedAt: now,
        runId: runId as never
      } as ConversationMessageRevision);
      assistant = revision;
    })
  };
}
