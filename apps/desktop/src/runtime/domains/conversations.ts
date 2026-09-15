import type { Spine } from "@mivlet/protocol";
import { hasTauriRuntime, invoke, activeDataScope } from "../bridge";

// ---------------------------------------------------------------------------
// Durable conversations. These wrappers are intentionally narrow: scope is
// always resolved here, never accepted from a caller. Browser preview has its
// own explicit in-memory fixture rather than silently falling back to a
// production-shaped local store.
// ---------------------------------------------------------------------------

type ConversationThread = Spine.Conversations.Thread;

type ConversationMessage = Spine.Conversations.Message;

type ConversationRevision = Spine.Conversations.MessageRevision;

export type RuntimeConversationThreadCreate =
  Spine.Conversations.ThreadCreateInput;

export type RuntimeConversationThreadUpdate =
  Spine.Conversations.ThreadUpdateInput;

export type RuntimeConversationMessageAppend =
  Spine.Conversations.MessageAppendInput;

export type RuntimeConversationMessageRevision =
  Spine.Conversations.MessageRevisionCreateInput;

export interface RuntimeConversationMessageView {
  message: ConversationMessage;
  currentRevision: ConversationRevision;
}

export interface RuntimeConversationDraft {
  draftKey: string;
  threadId?: string;
  content: string;
  updatedAt: string;
}

interface PreviewConversationStore {
  threads: ConversationThread[];
  messages: RuntimeConversationMessageView[];
  drafts: Map<string, RuntimeConversationDraft>;
}

interface NativeConversationThreadRow {
  id: string;
  title: string;
  lifecycle: "active" | "archived";
  lastSequence: number;
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NativeConversationMessageRow {
  id: string;
  threadId: string;
  sequence: number;
  kind: ConversationMessage["kind"];
  runId: string | null;
  detail: unknown;
  currentRevisionId: string;
  currentRevisionNumber: number;
  currentRevisionState: ConversationRevision["state"];
  content: unknown;
  createdAt: string;
}

const previewConversationStores = new Map<string, PreviewConversationStore>();

function conversationScopeOrThrow() {
  const scope = activeDataScope();
  if (!scope)
    throw new Error("A selected workspace is required for conversations.");
  return scope;
}

function previewConversationStore(
  workspaceId: string,
): PreviewConversationStore {
  let store = previewConversationStores.get(workspaceId);
  if (!store) {
    store = { threads: [], messages: [], drafts: new Map() };
    previewConversationStores.set(workspaceId, store);
  }
  return store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNativeThread(
  value: unknown,
): asserts value is NativeConversationThreadRow {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Malformed conversation thread response.");
  }
  if (
    typeof value.title !== "string" ||
    (value.lifecycle !== "active" && value.lifecycle !== "archived") ||
    typeof value.lastSequence !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Malformed conversation thread response.");
  }
}

function assertNativeMessage(
  value: unknown,
): asserts value is NativeConversationMessageRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.threadId !== "string"
  ) {
    throw new Error("Malformed conversation message response.");
  }
  if (
    typeof value.sequence !== "number" ||
    typeof value.currentRevisionId !== "string" ||
    typeof value.currentRevisionNumber !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Malformed conversation message response.");
  }
}

function assertDraft(
  value: unknown,
  workspaceId: string,
): asserts value is RuntimeConversationDraft {
  if (
    !isRecord(value) ||
    (value.workspaceId !== undefined && value.workspaceId !== workspaceId) ||
    typeof value.draftKey !== "string" ||
    typeof value.content !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.threadId !== undefined && typeof value.threadId !== "string")
  ) {
    throw new Error(
      "Malformed or cross-workspace conversation draft response.",
    );
  }
}

function previewThread(
  input: RuntimeConversationThreadCreate,
  workspaceId: string,
): ConversationThread {
  const now = new Date().toISOString();
  const id =
    `thread-preview-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}` as never;
  return {
    id,
    workspaceId: workspaceId as never,
    authority: input.authorityScope.authority,
    visibility: input.authorityScope.visibility,
    ...(input.authorityScope.authority === "local"
      ? { ownerMemberId: input.authorityScope.ownerMemberId }
      : {}),
    schemaVersion: 1,
    revision: 0,
    createdByInternalUserId: "preview-user" as never,
    createdByDeviceId: "preview-device" as never,
    createdAt: now,
    updatedAt: now,
    title: input.title,
    lifecycle: "active",
    messageHead: { lastSequence: 0 },
  } as ConversationThread;
}

function nativeMetadata(
  workspaceId: string,
  createdAt: string,
  updatedAt = createdAt,
) {
  return {
    workspaceId: workspaceId as never,
    authority: "local" as const,
    visibility: "member-private" as const,
    ownerMemberId: workspaceId as never,
    schemaVersion: 1 as never,
    revision: 0 as never,
    createdByInternalUserId: workspaceId as never,
    createdAt: createdAt as never,
    updatedAt: updatedAt as never,
  };
}

function fromNativeThread(
  row: NativeConversationThreadRow,
  workspaceId: string,
): ConversationThread {
  return {
    ...nativeMetadata(workspaceId, row.createdAt, row.updatedAt),
    id: row.id as never,
    title: row.title,
    lifecycle: row.lifecycle,
    messageHead: {
      lastSequence: row.lastSequence,
      lastMessageId: (row.lastMessageId as never) ?? undefined,
    },
  } as ConversationThread;
}

function fromNativeMessage(
  row: NativeConversationMessageRow,
  workspaceId: string,
): RuntimeConversationMessageView {
  const metadata = nativeMetadata(workspaceId, row.createdAt);
  const detail = row.detail === null ? {} : { detail: row.detail };
  const message = {
    ...metadata,
    id: row.id,
    threadId: row.threadId,
    sequence: row.sequence,
    kind: row.kind,
    ...(row.runId ? { runId: row.runId } : {}),
    ...detail,
    idempotencyKey: `native:message:${row.id}`,
    currentRevisionId: row.currentRevisionId,
    currentRevisionNumber: row.currentRevisionNumber,
    currentRevisionState: row.currentRevisionState,
  } as unknown as ConversationMessage;
  const body =
    row.currentRevisionState === "redacted"
      ? { state: "redacted" as const, redaction: row.content }
      : {
          state: row.currentRevisionState,
          content:
            typeof row.content === "string"
              ? row.content
              : JSON.stringify(row.content),
        };
  const currentRevision = {
    ...metadata,
    ...body,
    id: row.currentRevisionId,
    messageId: row.id,
    threadId: row.threadId,
    messageRevisionNumber: row.currentRevisionNumber,
    baseMessageRevisionNumber: Math.max(0, row.currentRevisionNumber - 1),
    reason: row.currentRevisionNumber === 1 ? "initial" : "recovery",
    idempotencyKey: `native:revision:${row.currentRevisionId}`,
    checkpointedAt: row.createdAt,
  } as unknown as ConversationRevision;
  return { message, currentRevision };
}

function draftThreadId(draftKey: string) {
  return draftKey.startsWith("thread:")
    ? draftKey.slice("thread:".length)
    : undefined;
}

export async function createRuntimeConversationThread(
  input: RuntimeConversationThreadCreate,
  expectedWorkspaceId?: string,
) {
  const scope = conversationScopeOrThrow();
  if (expectedWorkspaceId && scope.workspaceId !== expectedWorkspaceId) {
    throw new Error(
      "The selected workspace changed before the conversation was created.",
    );
  }
  if (!hasTauriRuntime()) {
    const thread = previewThread(input, scope.workspaceId);
    previewConversationStore(scope.workspaceId).threads.push(thread);
    return thread;
  }
  if (input.authorityScope.authority !== "local") {
    throw new Error(
      "Shared conversations are not available in the local desktop store.",
    );
  }
  const nativeInput = {
    id: `thread-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    title: input.title,
    payload: input,
  };
  const result = await invoke<unknown>("conversation_create_thread", {
    input: nativeInput,
    expectedWorkspaceId,
  });
  assertNativeThread(result);
  return fromNativeThread(result, scope.workspaceId);
}

export async function listRuntimeConversationThreads() {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    return [...previewConversationStore(scope.workspaceId).threads];
  }
  const result = await invoke<unknown>("conversation_list_threads");
  if (!Array.isArray(result))
    throw new Error("Malformed conversation thread list response.");
  result.forEach(assertNativeThread);
  return result.map((thread) => fromNativeThread(thread, scope.workspaceId));
}

export async function deleteRuntimeConversationThread(threadId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    store.threads = store.threads.filter((thread) => thread.id !== threadId);
    store.messages = store.messages.filter(
      (view) => view.message.threadId !== threadId,
    );
    store.drafts.delete(`thread:${threadId}`);
    return;
  }
  await invoke<void>("conversation_delete_thread", { threadId });
}

export async function getRuntimeConversationThread(threadId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    return (
      previewConversationStore(scope.workspaceId).threads.find(
        (thread) => thread.id === threadId,
      ) ?? null
    );
  }
  const result = await invoke<unknown>("conversation_get_thread", { threadId });
  if (result === null) return null;
  assertNativeThread(result);
  return fromNativeThread(result, scope.workspaceId);
}

export async function updateRuntimeConversationThread(
  input: RuntimeConversationThreadUpdate,
) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const index = store.threads.findIndex(
      (thread) => thread.id === input.threadId,
    );
    if (index < 0)
      throw new Error("Conversation thread was not found in this workspace.");
    const previous = store.threads[index];
    const next = {
      ...previous,
      ...input,
      updatedAt: new Date().toISOString(),
      revision: previous.revision + 1,
    } as ConversationThread;
    store.threads[index] = next;
    return next;
  }
  const result = await invoke<unknown>("conversation_update_thread", { input });
  assertNativeThread(result);
  return fromNativeThread(result, scope.workspaceId);
}

export async function listRuntimeConversationMessages(threadId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    return previewConversationStore(scope.workspaceId).messages.filter(
      (view) => view.message.threadId === threadId,
    );
  }
  const result = await invoke<unknown>("conversation_list_messages", {
    threadId,
  });
  if (!Array.isArray(result))
    throw new Error("Malformed conversation message list response.");
  result.forEach(assertNativeMessage);
  return result.map((message) => fromNativeMessage(message, scope.workspaceId));
}

export async function appendRuntimeConversationMessage(
  input: RuntimeConversationMessageAppend,
) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const thread = store.threads.find(
      (candidate) => candidate.id === input.threadId,
    );
    if (!thread)
      throw new Error("Conversation thread was not found in this workspace.");
    const revision = {
      ...input.initialRevision,
      id: input.initialRevision.revisionId,
      messageId: input.messageId,
      threadId: input.threadId,
      messageRevisionNumber: 1,
      baseMessageRevisionNumber: 0,
      workspaceId: scope.workspaceId as never,
      authority: thread.authority,
      visibility: thread.visibility,
      schemaVersion: 1,
      revision: 0,
      createdByInternalUserId: "preview-user" as never,
      createdAt: input.initialRevision.checkpointedAt,
      updatedAt: input.initialRevision.checkpointedAt,
    } as unknown as ConversationRevision;
    const message = {
      ...input,
      id: input.messageId,
      workspaceId: scope.workspaceId as never,
      authority: thread.authority,
      visibility: thread.visibility,
      schemaVersion: 1,
      revision: 0,
      createdByInternalUserId: "preview-user" as never,
      createdAt: input.initialRevision.checkpointedAt,
      updatedAt: input.initialRevision.checkpointedAt,
      currentRevisionId: revision.id,
      currentRevisionNumber: 1,
      currentRevisionState: revision.state,
    } as unknown as ConversationMessage;
    const view = { message, currentRevision: revision };
    store.messages.push(view);
    return view;
  }
  const { initialRevision, ...message } = input;
  const nativeInput = {
    ...message,
    detail: "detail" in input ? input.detail : null,
    revisionId: initialRevision.revisionId,
    state: initialRevision.state,
    reason: initialRevision.reason,
    content:
      initialRevision.state === "redacted"
        ? initialRevision.redaction
        : initialRevision.content,
    checkpointedAt: initialRevision.checkpointedAt,
  };
  const result = await invoke<unknown>("conversation_append_message", {
    input: nativeInput,
  });
  assertNativeMessage(result);
  return fromNativeMessage(result, scope.workspaceId);
}

export async function reviseRuntimeConversationMessage(
  input: RuntimeConversationMessageRevision,
) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const index = store.messages.findIndex(
      (view) =>
        view.message.id === input.messageId &&
        view.message.threadId === input.threadId,
    );
    if (index < 0)
      throw new Error("Conversation message was not found in this workspace.");
    const previous = store.messages[index];
    const revision = {
      ...input,
      id: input.revisionId,
      workspaceId: scope.workspaceId as never,
      authority: previous.message.authority,
      visibility: previous.message.visibility,
      schemaVersion: 1,
      revision: 0,
      createdByInternalUserId: "preview-user" as never,
      createdAt: input.checkpointedAt,
      updatedAt: input.checkpointedAt,
      messageRevisionNumber: previous.message.currentRevisionNumber + 1,
    } as unknown as ConversationRevision;
    const message = {
      ...previous.message,
      currentRevisionId: revision.id,
      currentRevisionNumber: revision.messageRevisionNumber,
      currentRevisionState: revision.state,
      updatedAt: input.checkpointedAt,
    } as ConversationMessage;
    const view = { message, currentRevision: revision };
    store.messages[index] = view;
    return view;
  }
  const nativeInput = {
    ...input,
    content: input.state === "redacted" ? input.redaction : input.content,
  };
  const result = await invoke<unknown>("conversation_revise_message", {
    input: nativeInput,
  });
  assertNativeMessage(result);
  return fromNativeMessage(result, scope.workspaceId);
}

export async function loadRuntimeConversationDraft(
  draftKey: string,
  expectedWorkspaceId?: string,
  threadId = draftThreadId(draftKey),
) {
  const scope = conversationScopeOrThrow();
  if (expectedWorkspaceId && scope.workspaceId !== expectedWorkspaceId)
    throw new Error(
      "The selected workspace changed before the draft was loaded.",
    );
  if (!hasTauriRuntime())
    return (
      previewConversationStore(scope.workspaceId).drafts.get(draftKey) ?? null
    );
  const response = await invoke<unknown>("conversation_load_draft", {
    id: draftKey,
    threadId,
    expectedWorkspaceId,
  });
  if (response === null) return null;
  // Tauri serializes an absent optional threadId as null in saved payloads.
  const result =
    isRecord(response) && response.threadId === null
      ? { ...response, threadId: undefined }
      : response;
  assertDraft(result, scope.workspaceId);
  if (result.draftKey !== draftKey || result.threadId !== threadId)
    throw new Error("Malformed or cross-conversation draft response.");
  return result;
}

export async function saveRuntimeConversationDraft(
  draft: RuntimeConversationDraft,
  expectedWorkspaceId?: string,
) {
  const scope = conversationScopeOrThrow();
  if (expectedWorkspaceId && scope.workspaceId !== expectedWorkspaceId)
    throw new Error(
      "The selected workspace changed before the draft was saved.",
    );
  if (!hasTauriRuntime()) {
    previewConversationStore(scope.workspaceId).drafts.set(draft.draftKey, {
      ...draft,
    });
    return draft;
  }
  await invoke<void>("conversation_save_draft", {
    input: { id: draft.draftKey, threadId: draft.threadId, payload: draft },
    expectedWorkspaceId,
  });
  return draft;
}

export async function deleteRuntimeConversationDraft(draftKey: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    previewConversationStore(scope.workspaceId).drafts.delete(draftKey);
    return;
  }
  await invoke<void>("conversation_delete_draft", {
    id: draftKey,
    threadId: draftThreadId(draftKey),
  });
}
