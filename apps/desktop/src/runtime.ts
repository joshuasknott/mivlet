import { getActiveRuntimeDataScope } from "./runtime-scope";
import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter,
} from "./runtime/adapters/select";
import type { RuntimeEvent, RuntimeUnlisten } from "./runtime/ports";
import { toRuntimeError } from "./runtime/errors";
export {
  createRuntimeLocalBackup,
  deleteRuntimeLocalData,
  loadRuntimeExecutionControl,
  loadRuntimeLocalDiagnostics,
  pauseRuntimeExecution,
  prepareRuntimeLocalRestore,
  resumeRuntimeExecution,
  type LocalDataRuntimePort,
  type RuntimeExecutionControlState,
  type RuntimeLocalBackupReceipt,
  type RuntimeLocalDataDeletionReceipt,
  type RuntimeLocalDiagnosticCategory,
  type RuntimeLocalDiagnosticsSnapshot,
  type RuntimeLocalRestorePreparation,
} from "./runtime/domains/local-data";
export {
  beginRuntimeIdentityRecovery,
  beginRuntimeIdentitySignIn,
  clearRuntimeAccountWorkspaceSession,
  loadRuntimeAccountWorkspaceStatus,
  loadRuntimeIdentityStatus,
  reconcileRuntimeAccountWorkspace,
  refreshRuntimeIdentity,
  signOutRuntimeIdentity,
  type AccountRuntimePort,
} from "./runtime/domains/account";
export {
  inspectRuntimeHostedProcess,
  killRuntimeHostedProcess,
  launchRuntimeHostedProcess,
  loadRuntimeHostedComputer,
  navigateRuntimeHostedBrowser,
  actRuntimeHostedBrowser,
  prepareRuntimeHostedBrowser,
  prepareRuntimeHostedBrowserAction,
  prepareRuntimeHostedProcess,
  provisionRuntimeHostedComputer,
  snapshotRuntimeHostedBrowser,
  type HostedComputerRuntimePort,
} from "./runtime/domains/hosted-computer";
export {
  historyRuntimeLocalBrowser,
  keyRuntimeLocalBrowser,
  launchRuntimeLocalComputerApplication,
  listRuntimeLocalComputerFiles,
  previewRuntimeLocalComputerFile,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  provisionRuntimeLocalComputer,
  setRuntimeLocalComputerController,
  snapshotRuntimeLocalBrowser,
} from "./runtime/domains/local-computer";
import type { LocalTextFileCandidate } from "@fable/connectors/local-files";
import type {
  ActionHistoryCategory,
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
  BackendConsequentialEvent,
  BackendCredentialRequest,
  AgentTurnRequest,
  BackendProvider,
  BackendVerifyResult,
  ConnectorActionRequest,
  ConnectorActionResult,
  ConnectorAccountOption,
  ConnectorAuthRequest,
  ConnectorAuthResult,
  ConnectorImportRequest,
  ConnectorImportResult,
  ConnectorManifest,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  ConnectorSyncRequest,
  ConnectorSyncState,
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport,
  LocalKnowledgeRefreshResponse,
  RefreshLocalKnowledgeSourceRequest,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  ExecutionAttempt,
  ProviderRoutePricingEvidence,
  ProviderRouteQualitySnapshot,
  RecordActionHistoryRequest,
  RuntimeSnapshot,
} from "@fable/protocol";
import type { Spine } from "@fable/protocol";

interface ApprovalAuditRecordResponse {
  persisted: boolean;
  entry: ApprovalAuditEntry;
  auditLen: number;
}

function hasTauriRuntime() {
  return hasNativeRuntimeAdapter();
}

function invoke<T>(command: string, args?: Record<string, unknown>) {
  return getRuntimeAdapter().invoke<T>(command, args);
}

function listen<T>(
  event: string,
  handler: (event: RuntimeEvent<T>) => void,
): Promise<RuntimeUnlisten> {
  return getRuntimeAdapter().listen<T>(event, handler);
}

/**
 * Native workspace repositories fail closed until account reconciliation has
 * selected a verified local directory. Browser/test mode receives the explicit
 * preview fixture scope from runtime-scope.ts.
 */
function activeDataScope() {
  return getActiveRuntimeDataScope();
}

export async function loadRuntimeApprovalAudit() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ApprovalAuditEntry[]>("list_approval_audit", scope);
  } catch {
    return null;
  }
}

export async function loadRuntimeApprovalRules() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ApprovalGrant[]>("list_approval_rules", scope);
  } catch {
    return null;
  }
}

export async function resolveRuntimeApprovalRequest(
  request: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ApprovalResolutionResponse>(
      "resolve_approval_request",
      {
        request,
        ...scope,
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function loadRuntimeImportedKnowledgeSources() {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<LocalFileImport[]>(
      "list_imported_knowledge_sources",
      scope,
    );
  } catch {
    return null;
  }
}

export async function saveRuntimeImportedKnowledgeSources(
  sources: LocalFileImport[],
) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<LocalFileImport[]>("save_imported_knowledge_sources", {
      sources,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeLocalKnowledgeSource(
  candidate: LocalTextFileCandidate,
) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<LocalFileImport>("import_local_knowledge_source", {
      candidate,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function refreshRuntimeLocalKnowledgeSource(
  request: RefreshLocalKnowledgeSourceRequest,
) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<LocalKnowledgeRefreshResponse>(
      "refresh_local_knowledge_source",
      {
        request,
        ...scope,
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function searchRuntimeKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limit?: number,
) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<KnowledgeSearchResponse>("search_knowledge_sources", {
      query,
      sources,
      limit,
      ...scope,
    });
  } catch {
    return null;
  }
}

export async function loadRuntimeMemoryState() {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<MemoryControlState>("list_memory_state", scope);
  } catch {
    return null;
  }
}

export async function loadRuntimeSnapshot() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<RuntimeSnapshot | null>("load_runtime_snapshot", scope);
  } catch {
    return null;
  }
}

export async function saveRuntimeSnapshot(snapshot: RuntimeSnapshot) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<RuntimeSnapshot>("save_runtime_snapshot", {
      snapshot,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeExecutionAttempt(attempt: ExecutionAttempt) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ExecutionAttempt>("save_execution_attempt", {
      attempt,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeExecutionAttempts() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ExecutionAttempt[]>("list_execution_attempts", scope);
  } catch {
    return null;
  }
}

export async function recoverRuntimeExecutionAttempts(recoveredAt: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ExecutionAttempt[]>(
      "recover_interrupted_execution_attempts",
      { recoveredAt, ...scope },
    );
  } catch {
    return null;
  }
}

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
) {
  const scope = conversationScopeOrThrow();
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

export async function loadRuntimeConversationDraft(draftKey: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime())
    return (
      previewConversationStore(scope.workspaceId).drafts.get(draftKey) ?? null
    );
  const result = await invoke<unknown>("conversation_load_draft", {
    id: draftKey,
    threadId: draftThreadId(draftKey),
  });
  if (result === null) return null;
  assertDraft(result, scope.workspaceId);
  return result;
}

export async function saveRuntimeConversationDraft(
  draft: RuntimeConversationDraft,
) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    previewConversationStore(scope.workspaceId).drafts.set(draft.draftKey, {
      ...draft,
    });
    return draft;
  }
  await invoke<void>("conversation_save_draft", {
    input: { id: draft.draftKey, threadId: draft.threadId, payload: draft },
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

export async function saveRuntimeMemoryState(state: MemoryControlState) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<MemoryControlState>("save_memory_state", {
      state,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(_state: MemoryControlState) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<string>("export_memory_state", scope);
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function promoteRuntimeKnowledgeSourceToMemory(
  request: MemoryPromotionRequest,
) {
  const scope = activeDataScope();
  if (!scope || !hasTauriRuntime()) return null;
  try {
    return await invoke<MemoryPromotionResponse>(
      "promote_knowledge_source_to_memory",
      {
        request,
        ...scope,
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function recordRuntimeApprovalDecision(entry: ApprovalAuditEntry) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    const response = await invoke<ApprovalAuditRecordResponse>(
      "record_approval_decision",
      {
        entry,
        ...scope,
      },
    );
    return response.persisted ? response.entry : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inspectable action history.
//
// Audit observes actions across model calls, connector actions, shell/tool
// actions, browser/web actions, approvals, and blocked policy
// decisions. It never grants execution authority and never carries secrets.
// Browser preview returns null so the shell can render an empty history without
// claiming a live store.
// ---------------------------------------------------------------------------

/**
 * List recent action-history events, newest first. Optionally filtered by
 * category. Returns null outside Tauri so callers can fall back to in-memory
 * state without surfacing a hard error.
 */
export async function loadRuntimeActionHistory(
  category?: ActionHistoryCategory | string,
  limit?: number,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ActionHistoryEvent[]>("list_action_history", {
      category: category ?? null,
      limit: limit ?? null,
      ...scope,
    });
  } catch {
    return null;
  }
}

/**
 * Record an action-history event from the UI/runtime (observation only). Returns
 * whether the event was persisted; outside Tauri this is always false.
 */
export async function recordRuntimeActionHistory(
  request: RecordActionHistoryRequest,
) {
  if (!hasTauriRuntime()) {
    return false;
  }
  const scope = activeDataScope();
  if (!scope) return false;

  try {
    return await invoke<boolean>("record_action_history", {
      request,
      ...scope,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Optional cloud identity.
//
// Rust owns Clerk OAuth, refresh, token validation, and keyring storage. These
// wrappers expose only the secret-free status surface to React.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Supported connectors.
//
// The runtime owns auth, credentials, provider health, and future network
// egress. Browser-only development returns null and cannot claim a connection.
// ---------------------------------------------------------------------------

export async function listRuntimeConnectorStatuses() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest[]>("list_connector_statuses", scope);
  } catch {
    return null;
  }
}

export async function startRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("start_connector_auth", {
      request,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function completeRuntimeConnectorAuth(
  request: ConnectorAuthRequest,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("complete_connector_auth", {
      request,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Begin an end-to-end loopback OAuth flow. Rust binds a redirect URI, starts
 * the transaction, opens the browser, accepts one callback, and completes the
 * token exchange inside the credential boundary. Confidential providers route
 * exchange through the configured auth broker; public Google clients call
 * Google directly. Returns null outside Tauri.
 */
export async function beginRuntimeConnectorOAuth(
  request: ConnectorAuthRequest,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("begin_connector_oauth", {
      request,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Listen for connector auth completion events emitted by the loopback OAuth
 * receiver. The shell re-reads connector statuses on a connected result. Returns
 * an unlisten function (or null outside Tauri).
 */
export async function listenRuntimeConnectorAuth(
  onComplete: (event: {
    connectorId: string;
    status: string;
    message: string;
  }) => void,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    const unlisten = await listen<{
      connectorId: string;
      status: string;
      message: string;
    }>("fable://connector/auth", (event) => {
      onComplete(event.payload);
    });
    return unlisten;
  } catch {
    return null;
  }
}

export async function clearRuntimeConnectorAuth(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("clear_connector_auth", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorAccounts(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAccountOption[]>("list_connector_accounts", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function switchRuntimeConnectorAccount(
  connectorId: string,
  connectionId: string,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("switch_connector_account", {
      connectorId,
      connectionId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function refreshRuntimeConnectorHealth(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("refresh_connector_health", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorSyncStates(
  workspaceId = activeDataScope()?.workspaceId,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<ConnectorSyncState[]>("list_connector_sync_states", {
      workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function syncRuntimeConnector(request: ConnectorSyncRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope || request.workspaceId !== scope.workspaceId) return null;
  try {
    return await invoke<ConnectorSyncState>("sync_connector", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function searchRuntimeConnector(
  request: ConnectorSearchRequest,
  connectionId?: string,
) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorSearchResult>("search_connector", {
      request,
      ...scope,
      connectionId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeConnectorItem(
  request: ConnectorImportRequest,
  connectionId?: string,
) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorImportResult>("import_connector_item", {
      request,
      ...scope,
      connectionId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

async function invokeConnectorKnowledge<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<T>(command, {
      ...args,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export function listRuntimeConnectorKnowledgeSources() {
  return invokeConnectorKnowledge<KnowledgeSource[]>(
    "list_connector_knowledge_sources",
  );
}

export async function setRuntimeConnectorKnowledgeSourceDisabled(
  sourceId: string,
  disabled: boolean,
) {
  return invokeConnectorKnowledge<KnowledgeSource>(
    "set_connector_knowledge_source_disabled",
    { sourceId, disabled },
  );
}

export function deleteRuntimeConnectorKnowledgeSource(sourceId: string) {
  return invokeConnectorKnowledge<KnowledgeSource>(
    "delete_connector_knowledge_source",
    { sourceId },
  );
}

export async function prepareRuntimeConnectorAction(
  request: ConnectorActionRequest,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorActionRequest>("prepare_connector_action", {
      request,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function executeRuntimeConnectorAction(request: {
  action: ConnectorActionRequest;
  approval: ApprovalResolutionRequest;
}) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorActionResult>(
      "execute_approved_connector_action",
      {
        request,
        workspaceId: scope.workspaceId,
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Agent-runtime backends (Codex browser sign-in and direct provider APIs)
//
// The Rust credential boundary owns secrets. These wrappers expose auth state
// + capabilities only. Outside Tauri they return null so the shell falls back
// to the preview backend registry and stays testable.
// ---------------------------------------------------------------------------

export async function listRuntimeBackends() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<BackendProvider[]>("list_backends");
  } catch {
    return null;
  }
}

export async function connectRuntimeBackend(request: BackendCredentialRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<string>("store_backend_credential", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Verify a stored native-API credential. Rust looks the key up inside the
 * credential boundary and hit-tests it against the provider; the secret never
 * crosses into JavaScript. Returns null outside Tauri so the onboarding shell
 * falls back to a local preview connection and stays fixture-testable.
 *
 * Outcomes map to the onboarding flow:
 *   - `ready` → the provider is connected; reflect it as connected.
 *   - `auth-failed` → the key was rejected; clear it and surface a useful error.
 *   - `offline` / `unsupported` / `failed` → keep the stored key, show a warning.
 */
export async function verifyRuntimeBackend(
  providerId: string,
): Promise<BackendVerifyResult | null> {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<BackendVerifyResult>("verify_backend_credential", {
      providerId,
    });
  } catch (error) {
    // A command failure is treated as a transient failure, not auth failure:
    // the stored key may still be good.
    return {
      providerId,
      outcome: "failed",
      message: toRuntimeError(error).message,
    };
  }
}

export async function clearRuntimeBackend(providerId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<string>("clear_backend_credential", { providerId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Record a backend-originated consequential event as an approval audit entry.
 * Backends that already approved something internally are recorded as `once`
 * audit; they never bypass Fable's approval layer for future actions.
 */
export async function recordRuntimeBackendEvent(
  event: BackendConsequentialEvent,
  decidedAt: string,
) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<ApprovalAuditEntry>("record_backend_event", {
      event,
      decidedAt,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Native-API agent-loop transport bridge.
//
// The TypeScript layer owns orchestration (loop control, tool-call handling,
// approval routing) as pure logic; Rust owns the API key + HTTP/SSE egress.
// `streamRuntimeCompletion` hands Rust an opaque request (no key) and Rust emits
// normalized SSE lines on the legacy `arden://backend/<requestId>` channel.
// The name is intentionally stable for compatibility with existing runtimes.
// Tauri these return null so the loop stays fixture-testable.
// ---------------------------------------------------------------------------

export interface RuntimeStreamRequest {
  providerId: string;
  requestId: string;
  model: string;
  body: unknown;
  providerRoute?: import("@fable/protocol").ProviderRouteExecutionBinding;
}

export type RuntimeNativeProviderRoute = Spine.Connections.ProviderRoute & {
  observationSummary?: {
    reference: string;
    sampleCount: number;
    medianLatencyMs: number;
    usageSampleCount: number;
    latestObservedAt: string;
  };
  pricingSummary?: ProviderRoutePricingEvidence;
  qualitySummary?: ProviderRouteQualitySnapshot;
};

export async function listRuntimeNativeProviderRoutes() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeNativeProviderRoute[]>(
      "list_native_provider_routes",
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Begin a streaming completion. Rust adds the key + performs the HTTP call. */
export async function streamRuntimeCompletion(request: RuntimeStreamRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<null>("stream_backend_completion", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Cancel an in-flight completion (real cancellation at the Rust boundary). */
export async function cancelRuntimeCompletion(requestId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<boolean>("cancel_backend_completion", { requestId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Discover the available model ids for a connected native provider. Rust looks
 * up the key (fail closed — no egress without a credential), issues a bounded
 * GET to the provider's list-models endpoint, and returns the parsed ids. Returns
 * null outside Tauri so the shell falls back to the curated catalogue and stays
 * fixture-testable. A null/empty result is treated as "discovery did not run".
 */
export interface RuntimeDiscoveredModel {
  id: string;
  available: boolean;
  capabilities?: import("@fable/protocol").ModelCapabilities;
}

export interface RuntimeModelDiscoveryResult {
  outcome: "success" | "unsupported" | "offline" | "failed" | "empty";
  models: RuntimeDiscoveredModel[];
  message?: string;
}

export async function listRuntimeBackendModels(providerId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    if (providerId === "antigravity") {
      const models = await invoke<BackendProvider["models"]>(
        "list_antigravity_models",
      );
      return {
        outcome: models.length ? ("success" as const) : ("empty" as const),
        models,
      };
    }
    if (["claude", "cursor", "grok", "opencode"].includes(providerId)) {
      const models = await invoke<BackendProvider["models"]>(
        "list_managed_runtime_models",
        {
          providerId,
        },
      );
      return {
        outcome: models.length ? ("success" as const) : ("empty" as const),
        models,
      };
    }
    return await invoke<RuntimeModelDiscoveryResult>("list_backend_models", {
      providerId,
    });
  } catch (error) {
    return {
      outcome: "failed" as const,
      models: [],
      message: toRuntimeError(error).message,
    };
  }
}

export async function listenRuntimeBackendEvents(
  requestId: string,
  onLine: (line: string) => void,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    const unlisten = await listen<string>(
      `arden://backend/${requestId}`,
      (event) => {
        onLine(event.payload as string);
      },
    );
    return unlisten;
  } catch {
    return null;
  }
}

export interface RuntimeCodexStatus {
  installed: boolean;
  authenticated: boolean;
  authMethod?: "chatgpt" | "api-key" | "provider-login";
  version?: string;
  message?: string;
}

export interface RuntimeCodexBrowserLoginResult {
  providerId: "codex";
  outcome: "ready";
  message: string;
}

export interface RuntimeCodexTurnStartRequest {
  requestId: string;
  providerId: string;
  threadId: string | null;
  request: AgentTurnRequest;
  options: {
    contextPrefix?: string;
    permissionMode?: string;
    runId?: string;
  };
}

export type RuntimeCodexEvent =
  | { type: "thread"; threadId: string }
  | { type: "turn"; turnId: string }
  | { type: "retrying" }
  | { type: "process-exited" }
  | {
      type: "approval-request";
      requestId: string;
      callId: string;
      tool: string;
      arguments: string;
      approval: import("@fable/protocol").ApprovalRequest;
    }
  | { type: "text-delta"; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export async function getRuntimeCodexStatus() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeCodexStatus>("codex_cli_status");
  } catch {
    return {
      installed: false,
      authenticated: false,
      message: "Fable could not inspect the Codex CLI.",
    };
  }
}

export async function startRuntimeCodexBrowserLogin() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeCodexBrowserLoginResult>(
      "start_codex_browser_login",
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function startRuntimeCodexTurn(
  request: RuntimeCodexTurnStartRequest,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("start_codex_app_server_turn", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function respondRuntimeCodexApproval(request: {
  requestId: string;
  approvalRequestId: string;
  result: { callId: string; ok: boolean; output: string };
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("respond_codex_app_server_approval", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function interruptRuntimeCodexTurn(request: {
  requestId: string;
  threadId: string;
  turnId?: string;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("interrupt_codex_app_server_turn", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function shutdownRuntimeCodexTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_codex_app_server_turn", { requestId });
  } catch {
    return null;
  }
}

export async function listenRuntimeCodexEvents(
  requestId: string,
  onEvent: (event: RuntimeCodexEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<RuntimeCodexEvent>(
      `fable://codex/${requestId}`,
      (event) => {
        onEvent(event.payload);
      },
    );
    return unlisten;
  } catch {
    return null;
  }
}

export interface RuntimeAntigravityStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message?: string;
}

export type RuntimeAntigravityEvent = Extract<
  RuntimeCodexEvent,
  {
    type:
      | "approval-request"
      | "text-delta"
      | "done"
      | "error"
      | "cancelled"
      | "process-exited";
  }
>;

export async function getRuntimeAntigravityStatus() {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeAntigravityStatus>("antigravity_status").catch(() => ({
    installed: false,
    authenticated: false,
    message: "Fable could not inspect the Antigravity runtime.",
  }));
}

export async function installRuntimeAntigravity() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      providerId: "antigravity";
      version: string;
      installed: boolean;
    }>("install_antigravity_runtime");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function startRuntimeAntigravityBrowserLogin() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      providerId: "antigravity";
      outcome: "ready";
      message: string;
    }>("start_antigravity_browser_login");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function checkRuntimeAntigravityConnection() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<BackendVerifyResult>("check_antigravity_connection");
  } catch (error) {
    return {
      providerId: "antigravity",
      outcome: "failed" as const,
      message: toRuntimeError(error).message,
    };
  }
}

export async function startRuntimeAntigravityTurn(request: {
  requestId: string;
  providerId: string;
  request: AgentTurnRequest;
  options: { contextPrefix?: string; permissionMode?: string; runId?: string };
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("start_antigravity_acp_turn", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function respondRuntimeAntigravityApproval(request: {
  requestId: string;
  approvalRequestId: string;
  approved: boolean;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("respond_antigravity_acp_approval", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function interruptRuntimeAntigravityTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("interrupt_antigravity_acp_turn", { requestId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function shutdownRuntimeAntigravityTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_antigravity_acp_turn", { requestId });
  } catch {
    return null;
  }
}

export async function logoutRuntimeAntigravity() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("logout_antigravity");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeAntigravityEvents(
  requestId: string,
  onEvent: (event: RuntimeAntigravityEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<RuntimeAntigravityEvent>(
      `fable://antigravity/${requestId}`,
      (event) => onEvent(event.payload),
    );
  } catch {
    return null;
  }
}

export type ManagedRuntimeProviderId =
  "claude" | "cursor" | "grok" | "opencode";

export interface RuntimeManagedStatus {
  providerId: ManagedRuntimeProviderId;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message?: string;
}

export type RuntimeManagedEvent = RuntimeCodexEvent;

export async function getRuntimeManagedStatus(
  providerId: ManagedRuntimeProviderId,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeManagedStatus>("managed_runtime_status", {
      providerId,
    });
  } catch {
    return {
      providerId,
      installed: false,
      authenticated: false,
      message: `Fable could not inspect the ${providerId} runtime.`,
    };
  }
}

export async function checkRuntimeManagedConnection(
  providerId: ManagedRuntimeProviderId,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<BackendVerifyResult>(
      "check_managed_runtime_connection",
      { providerId },
    );
  } catch (error) {
    return {
      providerId,
      outcome: "failed" as const,
      message: toRuntimeError(error).message,
    };
  }
}

export async function startRuntimeManagedLogin(
  providerId: Exclude<ManagedRuntimeProviderId, "opencode">,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      providerId: string;
      outcome: "ready";
      message: string;
    }>("start_managed_runtime_login", { providerId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function startRuntimeManagedTurn(request: {
  requestId: string;
  providerId: ManagedRuntimeProviderId;
  request: AgentTurnRequest;
  options: { contextPrefix?: string; permissionMode?: string; runId?: string };
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("start_managed_runtime_turn", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function respondRuntimeManagedApproval(request: {
  requestId: string;
  approvalRequestId: string;
  approved: boolean;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("respond_managed_runtime_approval", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function interruptRuntimeManagedTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("interrupt_managed_runtime_turn", { requestId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function shutdownRuntimeManagedTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_managed_runtime_turn", { requestId });
  } catch {
    return null;
  }
}

export async function logoutRuntimeManaged(
  providerId: ManagedRuntimeProviderId,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("logout_managed_runtime", { providerId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeManagedEvents(
  providerId: ManagedRuntimeProviderId,
  requestId: string,
  onEvent: (event: RuntimeManagedEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<RuntimeManagedEvent>(
      `fable://managed-runtime/${providerId}/${requestId}`,
      (event) => onEvent(event.payload),
    );
  } catch {
    return null;
  }
}

// Authenticated provider composition. These wrappers carry only prompt content and
// opaque event identities; Rust derives account, workspace, member, actor,
// authority, revisions, timestamps, evaluation, and terminal results.
export interface RuntimeSpawnedMcpProcess {
  sessionId: string;
  channel: string;
  launchReference: string;
  connectionId: string;
  connectionRevision: number;
}

export interface RuntimeMcpConnectionDetails {
  connectionId: string;
  connectionRevision: number;
  transport: "stdio" | "streamable-http";
  launchReference: string;
  discoveryState: string;
  discoveredAt?: string;
  discoveredTools: string[];
  discoveredResources: string[];
  enabledTools: string[];
  enabledResources: string[];
  capabilityBindings: Array<{
    capabilityId: "knowledge.content.search";
    toolName: string;
    contractVersion: "fable.connected-source-search.v1";
    consequence: "read";
    trust: "untrusted";
  }>;
}

export interface RuntimeResolvedMcpCapabilityRoute {
  configurationReference: string;
  transport: "stdio" | "streamable-http";
  connectionId: string;
  connectionRevision: number;
  capabilityId: "knowledge.content.search";
  toolName: string;
}

export async function resolveRuntimeMcpCapabilityRoute(
  workspaceId: string,
  capabilityId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeResolvedMcpCapabilityRoute | null>(
    "resolve_mcp_capability_route",
    {
      request: { workspaceId, capabilityId },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export interface RuntimeMcpToolProposal {
  workspaceId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface RuntimePreparedMcpToolCall {
  proposalFingerprint: string;
  approval: import("@fable/protocol").ApprovalRequest;
}

export interface RuntimeAuthorizedMcpToolCall {
  permitId: string;
  expiresInSeconds: number;
}

export interface RuntimeMcpServerConfiguration {
  workspaceId: string;
  id: string;
  displayName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  endpoint?: string;
  expectedRevision?: number;
}

export interface RuntimeMcpServerSummary {
  id: string;
  workspaceId: string;
  displayName: string;
  transport: "stdio" | "streamable-http";
  revision: number;
  disabled: boolean;
  createdByInternalUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimePreparedMcpServerConfiguration {
  configurationFingerprint: string;
  approval: import("@fable/protocol").ApprovalRequest;
}

export interface RuntimeCapabilityGrantProposal {
  workspaceId: string;
  capabilityId: string;
  connectionId?: string;
  maxUses?: number;
  expiresAt?: string;
}

export interface RuntimeCapabilityGrant {
  id: string;
  capabilityId: string;
  connectionId: string;
  consequence: string;
  scopeKind: "workspace";
  workspaceId: string;
  state: "active" | "suspended" | "expired" | "revoked";
  maxUses?: number;
  usesConsumed: number;
  expiresAt?: string;
  approvalRequirement: "required-for-every-action";
  revision: number;
  grantedAt: string;
  updatedAt: string;
}

export type RuntimePreparedCapabilityGrant =
  | { status: "granted"; grant: RuntimeCapabilityGrant }
  | {
      status: "confirmation-required";
      proposalFingerprint: string;
      target: {
        capabilityId: string;
        connectionId: string;
        connectionRevision: number;
        connectionDisplayName: string;
        consequence: string;
        availability: string;
      };
      approval: import("@fable/protocol").ApprovalRequest;
    };

export async function prepareRuntimeCapabilityGrant(
  proposal: RuntimeCapabilityGrantProposal,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedCapabilityGrant>("prepare_capability_grant", {
    proposal,
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function commitRuntimeCapabilityGrant(
  proposal: RuntimeCapabilityGrantProposal,
  resolution: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeCapabilityGrant>("commit_capability_grant", {
    request: { proposal, resolution },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function prepareRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedMcpServerConfiguration>(
    "prepare_mcp_server_configuration",
    {
      configuration,
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function commitRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration,
  resolution: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary>("commit_mcp_server_configuration", {
    request: { configuration, resolution },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function listRuntimeMcpServerConfigurations(workspaceId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary[]>("list_mcp_server_configurations", {
    workspaceId,
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function spawnRuntimeMcpProcess(
  workspaceId: string,
  launchReference: string,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeSpawnedMcpProcess>("spawn_mcp_process", {
      request: { workspaceId, launchReference },
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export interface RuntimeOpenedRemoteMcpSession {
  sessionId: string;
  configurationReference: string;
  connectionId: string;
  connectionRevision: number;
}

export interface RuntimeRemoteMcpAuthorizationSummary {
  issuer: string;
  scopes: string[];
  pkceMethod: "S256";
  clientIdMetadataDocumentSupported: boolean;
  dynamicRegistrationSupported: boolean;
  clientRegistrationStrategy:
    | "pre-registered"
    | "client-id-metadata-document"
    | "dynamic-client-registration"
    | "manual-client-information";
  clientRegistrationStatus: "selected" | "configuration-required";
  clientRegistrationReason: string;
}

export interface RuntimeRemoteMcpAuthorizationResult {
  status: "connected";
  issuer: string;
  scopes: string[];
  clientRegistrationStrategy: RuntimeRemoteMcpAuthorizationSummary["clientRegistrationStrategy"];
  message: string;
}

export async function inspectRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationSummary>(
    "inspect_remote_mcp_authorization",
    {
      request: { workspaceId, configurationReference },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function beginRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationResult>(
    "begin_remote_mcp_authorization",
    {
      request: { workspaceId, configurationReference },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function disconnectRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<{ status: "disconnected"; message: string }>(
    "disconnect_remote_mcp_authorization",
    { request: { workspaceId, configurationReference } },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function openRuntimeRemoteMcpSession(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeOpenedRemoteMcpSession>("open_remote_mcp_session", {
    request: { workspaceId, configurationReference },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function sendRuntimeRemoteMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<string[]>("send_remote_mcp_frame", {
    request: { workspaceId, sessionId, frame },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export interface RuntimeRemoteMcpPollResult {
  supported: boolean;
  frames: string[];
  retryAfterMs: number;
}

export async function pollRuntimeRemoteMcpMessages(
  workspaceId: string,
  sessionId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpPollResult>("poll_remote_mcp_messages", {
    request: { workspaceId, sessionId },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function closeRuntimeRemoteMcpSession(
  workspaceId: string,
  sessionId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<null>("close_remote_mcp_session", {
    request: { workspaceId, sessionId },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function writeRuntimeMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("write_mcp_frame", {
      request: { workspaceId, sessionId, frame },
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function closeRuntimeMcpProcess(
  workspaceId: string,
  sessionId: string,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("close_mcp_process", {
      request: { workspaceId, sessionId },
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function recordRuntimeMcpDiscovery(
  workspaceId: string,
  sessionId: string,
  tools: string[],
  resources: string[],
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeMcpConnectionDetails>(
      "record_mcp_server_discovery",
      {
        request: { workspaceId, sessionId, tools, resources },
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function setRuntimeMcpEnablement(
  workspaceId: string,
  connectionId: string,
  expectedRevision: number,
  enabledTools: string[],
  enabledResources: string[],
  capabilityBindings: Array<{
    capabilityId: "knowledge.content.search";
    toolName: string;
  }>,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeMcpConnectionDetails>(
      "set_mcp_server_enablement",
      {
        request: {
          workspaceId,
          connectionId,
          expectedRevision,
          enabledTools,
          enabledResources,
          capabilityBindings,
        },
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeMcpToolCall(
  proposal: RuntimeMcpToolProposal,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimePreparedMcpToolCall>("prepare_mcp_tool_call", {
      proposal,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function authorizeRuntimeMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  resolution: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeAuthorizedMcpToolCall>(
      "authorize_mcp_tool_call",
      {
        request: { proposal, resolution },
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function executeRuntimeApprovedMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  permitId: string,
  requestId: string,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<string[]>("execute_approved_mcp_tool_call", {
      request: { proposal, permitId, requestId },
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeMcpFrames(
  channel: string,
  onFrame: (line: string) => void,
) {
  if (!hasTauriRuntime()) return null;
  if (!/^fable:\/\/mcp\/mcp-[0-9a-f]{32}$/.test(channel)) {
    throw new Error("The MCP event channel is invalid.");
  }
  try {
    return await listen<string>(channel, (event) => onFrame(event.payload));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fable-owned tool execution boundary.
//
// Each approved tool call crosses back into Rust, which re-validates the
// approval and performs the side effect (read/write file, run-shell, web-fetch).
// The shell NEVER spawns a process or writes files from JavaScript directly —
// every consequential tool routes through executeRuntimeToolCall. Outside Tauri
// the wrapper returns null so the executor stays fixture-testable.
// ---------------------------------------------------------------------------

export interface RuntimeToolRequest {
  /** The registered tool name (read-file/write-file/run-shell/web-fetch). */
  tool: string;
  /** The tool-call arguments as a parsed JSON value. */
  arguments: unknown;
  /** The approval resolution request the shell used to grant the call. Rust
   *  re-validates it before running the tool (defense in depth). */
  approval: ApprovalResolutionRequest;
  /** Authenticated scope assertion; Rust re-resolves it from active account state. */
  workspaceId?: string;
  /** Active teammate scope used by native code to resolve isolated local files. */
  agentId?: string;
  /** Native-owned live MCP session selected from an explicit semantic binding. */
  mcpSessionId?: string;
  /** Test-only compatibility field. Production Rust ignores caller-supplied roots. */
  workspaceRoot?: string;
}

export interface RuntimeToolResult {
  ok: boolean;
  output: string;
}

/** Execute an approved tool call through the Rust boundary. Null outside Tauri. */
export async function executeRuntimeToolCall(request: RuntimeToolRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<RuntimeToolResult>("execute_tool_call", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}
