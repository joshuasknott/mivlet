import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getActiveRuntimeDataScope } from "./runtime-scope";
import { importLocalTextFile, searchKnowledgeSources } from "@fable/connectors";
import type { LocalTextFileCandidate } from "@fable/connectors";
import type {
  ActionHistoryCategory,
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
  BackendConsequentialEvent,
  BackendCredentialRequest,
  AgentRunRequest,
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
  JobAttempt,
  KnowledgeSearchResponse,
  KnowledgeCitation,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  NotificationRecord,
  PersistedAgentRun,
  RecordActionHistoryRequest,
  RemoteControlPreferenceRequest,
  RemoteControlStatusSnapshot,
  RemoteDevice,
  RuntimeSnapshot,
  ScheduledExecutionRoute,
  ScheduledJob,
  ScheduledJobStatus,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  IdentityStatus,
  CloudMutationOutboxRow,
  CloudSyncEnqueueRequest,
  CloudSyncFlushResult,
  CloudSyncPullResult,
  CloudSyncStatus,
  CloudWorkspaceLinkState,
  AccountWorkspaceStatus
} from "@fable/protocol";
import type { Spine } from "@fable/protocol";

interface ApprovalAuditRecordResponse {
  persisted: boolean;
  entry: ApprovalAuditEntry;
  auditLen: number;
}

function hasTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

function toRuntimeError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new Error(error.message);
  }

  return new Error(typeof error === "string" ? error : "Fable runtime request failed.");
}

/**
 * Native workspace repositories fail closed until account reconciliation has
 * selected a verified local directory. Browser/test mode receives the explicit
 * preview fixture scope from runtime-scope.ts.
 */
function activeDataScope() {
  return getActiveRuntimeDataScope();
}

export interface RuntimeKnowledgeScopeOverride {
  workspaceId: string;
  projectId: string;
}

const previewProjectKnowledge = new Map<string, LocalFileImport[]>();

function knowledgeScope(scopeOverride?: RuntimeKnowledgeScopeOverride) {
  const active = activeDataScope();
  if (!scopeOverride) return active;
  const workspaceId = scopeOverride.workspaceId.trim();
  const projectId = scopeOverride.projectId.trim();
  if (!workspaceId || !projectId) {
    throw new Error("Project knowledge requires a workspace and project.");
  }
  if (!active || active.workspaceId !== workspaceId) {
    throw new Error("The active knowledge workspace changed. Refresh and try again.");
  }
  return { workspaceId, projectId };
}

function previewKnowledgeKey(scope: RuntimeKnowledgeScopeOverride) {
  return `${scope.workspaceId}\u0000${scope.projectId}`;
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

export async function resolveRuntimeApprovalRequest(request: ApprovalResolutionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ApprovalResolutionResponse>("resolve_approval_request", {
      request,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function loadRuntimeImportedKnowledgeSources(scopeOverride?: RuntimeKnowledgeScopeOverride) {
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    return scopeOverride ? [...(previewProjectKnowledge.get(previewKnowledgeKey(scopeOverride)) ?? [])] : null;
  }

  try {
    return await invoke<LocalFileImport[]>("list_imported_knowledge_sources", scope);
  } catch (error) {
    if (scopeOverride) throw toRuntimeError(error);
    return null;
  }
}

export async function saveRuntimeImportedKnowledgeSources(
  sources: LocalFileImport[],
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const scoped = sources.map((source) => ({
      ...source,
      workspaceId: scopeOverride.workspaceId,
      scope: { level: "project" as const, projectId: scopeOverride.projectId }
    }));
    previewProjectKnowledge.set(previewKnowledgeKey(scopeOverride), scoped);
    return [...scoped];
  }

  try {
    return await invoke<LocalFileImport[]>("save_imported_knowledge_sources", {
      sources,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeLocalKnowledgeSource(
  candidate: LocalTextFileCandidate,
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const imported = {
      ...importLocalTextFile(candidate),
      workspaceId: scopeOverride.workspaceId,
      scope: { level: "project" as const, projectId: scopeOverride.projectId }
    };
    const key = previewKnowledgeKey(scopeOverride);
    const current = previewProjectKnowledge.get(key) ?? [];
    previewProjectKnowledge.set(key, [imported, ...current.filter((source) => source.id !== imported.id)]);
    return imported;
  }

  try {
    return await invoke<LocalFileImport>("import_local_knowledge_source", {
      candidate,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function searchRuntimeKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limit?: number,
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const outsideScope = sources.some((source) =>
      source.workspaceId !== scopeOverride.workspaceId ||
      source.scope?.level !== "project" ||
      source.scope.projectId !== scopeOverride.projectId
    );
    if (outsideScope) throw new Error("Knowledge search received a source outside this project.");
    return searchKnowledgeSources(query, sources, limit);
  }

  try {
    return await invoke<KnowledgeSearchResponse>("search_knowledge_sources", {
      query,
      sources,
      limit,
      ...scope
    });
  } catch (error) {
    if (scopeOverride) throw toRuntimeError(error);
    return null;
  }
}

export async function loadRuntimeMemoryState() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

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
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeAgentRun(run: PersistedAgentRun) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<PersistedAgentRun>("save_agent_run", { run, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeAgentRuns() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<PersistedAgentRun[]>("list_agent_runs", scope);
  } catch {
    return null;
  }
}

export async function recoverRuntimeAgentRuns(recoveredAt: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<PersistedAgentRun[]>("recover_interrupted_agent_runs", { recoveredAt, ...scope });
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
export type RuntimeConversationThreadCreate = Spine.Conversations.ThreadCreateInput;
export type RuntimeConversationThreadUpdate = Spine.Conversations.ThreadUpdateInput;
export type RuntimeConversationMessageAppend = Spine.Conversations.MessageAppendInput;
export type RuntimeConversationMessageRevision = Spine.Conversations.MessageRevisionCreateInput;

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
  projectId: string | null;
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
  if (!scope) throw new Error("A selected workspace is required for conversations.");
  return scope;
}

function previewConversationStore(workspaceId: string): PreviewConversationStore {
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

function assertScopedConversationRecord(value: unknown, workspaceId: string, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.workspaceId !== workspaceId || typeof value.id !== "string") {
    throw new Error(`Malformed or cross-workspace ${label} response.`);
  }
}

function assertNativeThread(value: unknown): asserts value is NativeConversationThreadRow {
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

function assertNativeMessage(value: unknown): asserts value is NativeConversationMessageRow {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.threadId !== "string") {
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

function assertDraft(value: unknown, workspaceId: string): asserts value is RuntimeConversationDraft {
  if (
    !isRecord(value) ||
    value.workspaceId !== undefined && value.workspaceId !== workspaceId ||
    typeof value.draftKey !== "string" ||
    typeof value.content !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.threadId !== undefined && typeof value.threadId !== "string")
  ) {
    throw new Error("Malformed or cross-workspace conversation draft response.");
  }
}

function previewThread(input: RuntimeConversationThreadCreate, workspaceId: string): ConversationThread {
  const now = new Date().toISOString();
  const id = `thread-preview-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}` as never;
  return {
    id,
    workspaceId: workspaceId as never,
    authority: input.authorityScope.authority,
    visibility: input.authorityScope.visibility,
    ...(input.authorityScope.authority === "local" ? { ownerMemberId: input.authorityScope.ownerMemberId } : {}),
    schemaVersion: 1,
    revision: 0,
    createdByInternalUserId: "preview-user" as never,
    createdByDeviceId: "preview-device" as never,
    createdAt: now,
    updatedAt: now,
    projectId: input.projectId,
    title: input.title,
    lifecycle: "active",
    messageHead: { lastSequence: 0 }
  } as ConversationThread;
}

function nativeMetadata(workspaceId: string, createdAt: string, updatedAt = createdAt) {
  return {
    workspaceId: workspaceId as never,
    authority: "local" as const,
    visibility: "member-private" as const,
    ownerMemberId: workspaceId as never,
    schemaVersion: 1 as never,
    revision: 0 as never,
    createdByInternalUserId: workspaceId as never,
    createdAt: createdAt as never,
    updatedAt: updatedAt as never
  };
}

function fromNativeThread(row: NativeConversationThreadRow, workspaceId: string): ConversationThread {
  return {
    ...nativeMetadata(workspaceId, row.createdAt, row.updatedAt),
    id: row.id as never,
    projectId: row.projectId ?? undefined,
    title: row.title,
    lifecycle: row.lifecycle,
    messageHead: {
      lastSequence: row.lastSequence,
      lastMessageId: row.lastMessageId as never ?? undefined
    }
  } as ConversationThread;
}

function fromNativeMessage(row: NativeConversationMessageRow, workspaceId: string): RuntimeConversationMessageView {
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
    currentRevisionState: row.currentRevisionState
  } as unknown as ConversationMessage;
  const body = row.currentRevisionState === "redacted"
    ? { state: "redacted" as const, redaction: row.content }
    : { state: row.currentRevisionState, content: typeof row.content === "string" ? row.content : JSON.stringify(row.content) };
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
    checkpointedAt: row.createdAt
  } as unknown as ConversationRevision;
  return { message, currentRevision };
}

function draftThreadId(draftKey: string) {
  return draftKey.startsWith("thread:") ? draftKey.slice("thread:".length) : undefined;
}

export async function createRuntimeConversationThread(input: RuntimeConversationThreadCreate) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const thread = previewThread(input, scope.workspaceId);
    previewConversationStore(scope.workspaceId).threads.push(thread);
    return thread;
  }
  if (input.authorityScope.authority !== "local") {
    throw new Error("Shared conversations are not available in the local desktop store.");
  }
  const nativeInput = {
    id: `thread-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    projectId: input.projectId,
    title: input.title,
    payload: input
  };
  const result = await invoke<unknown>("conversation_create_thread", { input: nativeInput });
  assertNativeThread(result);
  return fromNativeThread(result, scope.workspaceId);
}

export async function listRuntimeConversationThreads(projectId?: string | null) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    return previewConversationStore(scope.workspaceId).threads.filter((thread) =>
      projectId === undefined ? true : (thread.projectId ?? null) === projectId
    );
  }
  // `projectId` is an optional thread filter, not a caller-supplied runtime
  // scope. Strip the fixed `projectId: null` scope field before adding it.
  const { projectId: _fixedProjectScope, ...workspaceScope } = scope;
  const result = await invoke<unknown>("conversation_list_threads");
  if (!Array.isArray(result)) throw new Error("Malformed conversation thread list response.");
  result.forEach(assertNativeThread);
  return result.map((thread) => fromNativeThread(thread, scope.workspaceId)).filter((thread) =>
    projectId === undefined ? true : (thread.projectId ?? null) === projectId
  );
}

export async function getRuntimeConversationThread(threadId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    return previewConversationStore(scope.workspaceId).threads.find((thread) => thread.id === threadId) ?? null;
  }
  const result = await invoke<unknown>("conversation_get_thread", { threadId });
  if (result === null) return null;
  assertNativeThread(result);
  return fromNativeThread(result, scope.workspaceId);
}

export async function updateRuntimeConversationThread(input: RuntimeConversationThreadUpdate) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const index = store.threads.findIndex((thread) => thread.id === input.threadId);
    if (index < 0) throw new Error("Conversation thread was not found in this workspace.");
    const previous = store.threads[index];
    const { projectId, ...changes } = input;
    const next = { ...previous, ...changes, projectId: projectId === undefined ? previous.projectId : projectId ?? undefined, updatedAt: new Date().toISOString(), revision: previous.revision + 1 } as ConversationThread;
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
    return previewConversationStore(scope.workspaceId).messages.filter((view) => view.message.threadId === threadId);
  }
  const result = await invoke<unknown>("conversation_list_messages", { threadId });
  if (!Array.isArray(result)) throw new Error("Malformed conversation message list response.");
  result.forEach(assertNativeMessage);
  return result.map((message) => fromNativeMessage(message, scope.workspaceId));
}

export async function appendRuntimeConversationMessage(input: RuntimeConversationMessageAppend) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const thread = store.threads.find((candidate) => candidate.id === input.threadId);
    if (!thread) throw new Error("Conversation thread was not found in this workspace.");
    const revision = { ...input.initialRevision, id: input.initialRevision.revisionId, messageId: input.messageId, threadId: input.threadId, messageRevisionNumber: 1, baseMessageRevisionNumber: 0, workspaceId: scope.workspaceId as never, authority: thread.authority, visibility: thread.visibility, schemaVersion: 1, revision: 0, createdByInternalUserId: "preview-user" as never, createdAt: input.initialRevision.checkpointedAt, updatedAt: input.initialRevision.checkpointedAt } as unknown as ConversationRevision;
    const message = { ...input, id: input.messageId, workspaceId: scope.workspaceId as never, authority: thread.authority, visibility: thread.visibility, schemaVersion: 1, revision: 0, createdByInternalUserId: "preview-user" as never, createdAt: input.initialRevision.checkpointedAt, updatedAt: input.initialRevision.checkpointedAt, currentRevisionId: revision.id, currentRevisionNumber: 1, currentRevisionState: revision.state } as unknown as ConversationMessage;
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
    content: initialRevision.state === "redacted" ? initialRevision.redaction : initialRevision.content,
    checkpointedAt: initialRevision.checkpointedAt
  };
  const result = await invoke<unknown>("conversation_append_message", { input: nativeInput });
  assertNativeMessage(result);
  return fromNativeMessage(result, scope.workspaceId);
}

export async function reviseRuntimeConversationMessage(input: RuntimeConversationMessageRevision) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const store = previewConversationStore(scope.workspaceId);
    const index = store.messages.findIndex((view) => view.message.id === input.messageId && view.message.threadId === input.threadId);
    if (index < 0) throw new Error("Conversation message was not found in this workspace.");
    const previous = store.messages[index];
    const revision = { ...input, id: input.revisionId, workspaceId: scope.workspaceId as never, authority: previous.message.authority, visibility: previous.message.visibility, schemaVersion: 1, revision: 0, createdByInternalUserId: "preview-user" as never, createdAt: input.checkpointedAt, updatedAt: input.checkpointedAt, messageRevisionNumber: previous.message.currentRevisionNumber + 1 } as unknown as ConversationRevision;
    const message = { ...previous.message, currentRevisionId: revision.id, currentRevisionNumber: revision.messageRevisionNumber, currentRevisionState: revision.state, updatedAt: input.checkpointedAt } as ConversationMessage;
    const view = { message, currentRevision: revision };
    store.messages[index] = view;
    return view;
  }
  const nativeInput = {
    ...input,
    content: input.state === "redacted" ? input.redaction : input.content
  };
  const result = await invoke<unknown>("conversation_revise_message", { input: nativeInput });
  assertNativeMessage(result);
  return fromNativeMessage(result, scope.workspaceId);
}

export async function loadRuntimeConversationDraft(draftKey: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) return previewConversationStore(scope.workspaceId).drafts.get(draftKey) ?? null;
  const result = await invoke<unknown>("conversation_load_draft", { id: draftKey, threadId: draftThreadId(draftKey) });
  if (result === null) return null;
  assertDraft(result, scope.workspaceId);
  return result;
}

export async function saveRuntimeConversationDraft(draft: RuntimeConversationDraft) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    previewConversationStore(scope.workspaceId).drafts.set(draft.draftKey, { ...draft });
    return draft;
  }
  await invoke<void>("conversation_save_draft", {
    input: { id: draft.draftKey, threadId: draft.threadId, payload: draft }
  });
  return draft;
}

export async function deleteRuntimeConversationDraft(draftKey: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    previewConversationStore(scope.workspaceId).drafts.delete(draftKey);
    return;
  }
  await invoke<void>("conversation_delete_draft", { id: draftKey, threadId: draftThreadId(draftKey) });
}

export interface RuntimeArtifactBundle {
  artifact: Spine.ArtifactsAndRoutines.Artifact;
  version: Spine.ArtifactsAndRoutines.ArtifactVersion;
  sourceMessageId: string;
}

export interface CreateResponseArtifactInput {
  threadId: string;
  messageId: string;
  runId: string;
  title: string;
  content: string;
  citations: readonly KnowledgeCitation[];
}

const previewArtifacts = new Map<string, RuntimeArtifactBundle[]>();

function assertArtifactBundle(value: unknown, workspaceId: string): asserts value is RuntimeArtifactBundle {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.version) ||
      value.artifact.workspaceId !== workspaceId || typeof value.artifact.id !== "string" ||
      typeof value.version.id !== "string" || typeof value.sourceMessageId !== "string") {
    throw new Error("Malformed or cross-workspace artifact response.");
  }
}

export async function createRuntimeResponseArtifact(input: CreateResponseArtifactInput) {
  const scope = conversationScopeOrThrow();
  const artifactId = `artifact-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const versionId = `artifact-version-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const nativeInput = {
    ...input,
    artifactId,
    versionId,
    citations: input.citations.map((citation) => ({
      sourceId: citation.sourceId
    }))
  };
  if (!hasTauriRuntime()) {
    const now = new Date().toISOString();
    const media = { mediaType: "text/markdown", byteLength: new TextEncoder().encode(input.content).byteLength, encoding: "utf-8" };
    const contentHash = { algorithm: "sha-256" as const, value: `preview-${input.content.length}` };
    const provenance = { kind: "run" as const, runId: input.runId as never, externalReference: `message:${input.messageId}`, observedAt: now };
    const bundle = {
      artifact: { id: artifactId, workspaceId: scope.workspaceId, authority: "local", visibility: "member-private", ownerMemberId: "preview-member", schemaVersion: 1, revision: 0, createdByInternalUserId: "preview-user", createdAt: now, updatedAt: now, kind: "document", status: "draft", title: input.title, currentVersionId: versionId, producingRunId: input.runId, sourceProvenance: [provenance], context: { threadId: input.threadId }, reviews: [], retention: { status: "active" } },
      version: { id: versionId, artifactId, version: 1, status: "available", createdAt: now, createdByInternalUserId: "preview-user", content: { kind: "inline", text: input.content, media, contentHash }, media, contentHash, provenance, citations: input.citations.map((citation, index) => ({ id: `citation-${index + 1}`, label: citation.title, source: { kind: "import", externalReference: citation.sourceId, observedAt: now }, locator: citation.chunkId ?? citation.sourcePath, quotedText: citation.snippet })), lineage: [] },
      sourceMessageId: input.messageId
    } as unknown as RuntimeArtifactBundle;
    const records = previewArtifacts.get(scope.workspaceId) ?? [];
    previewArtifacts.set(scope.workspaceId, [...records, bundle]);
    return bundle;
  }
  const result = await invoke<unknown>("artifact_create_from_response", { input: nativeInput });
  assertArtifactBundle(result, scope.workspaceId);
  return result;
}

export async function listRuntimeThreadArtifacts(threadId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) return (previewArtifacts.get(scope.workspaceId) ?? []).filter((entry) => entry.artifact.context.threadId === threadId);
  const result = await invoke<unknown>("artifact_list_for_thread", { threadId });
  if (!Array.isArray(result)) throw new Error("Malformed artifact list response.");
  result.forEach((entry) => assertArtifactBundle(entry, scope.workspaceId));
  return result;
}

export async function getRuntimeArtifact(artifactId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) return (previewArtifacts.get(scope.workspaceId) ?? []).find((entry) => entry.artifact.id === artifactId) ?? null;
  const result = await invoke<unknown>("artifact_get", { artifactId });
  if (result === null) return null;
  assertArtifactBundle(result, scope.workspaceId);
  return result;
}

export async function saveRuntimeMemoryState(state: MemoryControlState) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<MemoryControlState>("save_memory_state", {
      state,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(_state: MemoryControlState) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<string>("export_memory_state", {
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function promoteRuntimeKnowledgeSourceToMemory(request: MemoryPromotionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<MemoryPromotionResponse>("promote_knowledge_source_to_memory", {
      request,
      ...scope
    });
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
    const response = await invoke<ApprovalAuditRecordResponse>("record_approval_decision", {
      entry,
      ...scope
    });
    return response.persisted ? response.entry : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inspectable action history.
//
// Audit observes actions across model calls, connector actions, shell/tool
// actions, browser/web actions, approvals, schedules, and blocked policy
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
  limit?: number
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
      ...scope
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
  request: RecordActionHistoryRequest
) {
  if (!hasTauriRuntime()) {
    return false;
  }
  const scope = activeDataScope();
  if (!scope) return false;

  try {
    return await invoke<boolean>("record_action_history", { request, ...scope });
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

export async function loadRuntimeIdentityStatus() {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<IdentityStatus>("identity_status");
  } catch (error) {
    return {
      enabled: true,
      state: "error",
      message: toRuntimeError(error).message,
      scopes: []
    } satisfies IdentityStatus;
  }
}

export async function beginRuntimeIdentitySignIn() {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<IdentityStatus>("identity_begin_sign_in");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function beginRuntimeIdentityRecovery() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<IdentityStatus>("identity_begin_recovery");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function refreshRuntimeIdentity() {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<IdentityStatus>("identity_refresh");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function signOutRuntimeIdentity() {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<IdentityStatus>("identity_sign_out");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** The authoritative account directory; no local scope is trusted before this succeeds. */
export async function loadRuntimeAccountWorkspaceStatus() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<AccountWorkspaceStatus>("account_workspace_status");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function reconcileRuntimeAccountWorkspace() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<AccountWorkspaceStatus>("account_workspace_reconcile");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function createRuntimeAccountWorkspace(name: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<AccountWorkspaceStatus>("account_workspace_create", { name });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function selectRuntimeAccountWorkspace(fableWorkspaceId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<AccountWorkspaceStatus>("account_workspace_select", { fableWorkspaceId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function revokeRuntimeAccountDevice(deviceId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<AccountWorkspaceStatus>("account_device_revoke", { deviceId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function clearRuntimeAccountWorkspaceSession() {
  if (!hasTauriRuntime()) return null;
  try {
    await invoke<void>("account_workspace_clear_session");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function loadRuntimeCloudSyncStatus(workspaceId = activeDataScope()?.workspaceId) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<CloudSyncStatus>("cloud_sync_status", { workspaceId });
  } catch {
    return null;
  }
}

export async function loadRuntimeCloudSyncLinkState(workspaceId = activeDataScope()?.workspaceId) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<CloudWorkspaceLinkState | null>("cloud_sync_link_state", { workspaceId });
  } catch {
    return null;
  }
}

export async function enqueueRuntimeCloudSyncMutation(request: CloudSyncEnqueueRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope || request.localWorkspaceId !== scope.workspaceId) return null;
  try {
    return await invoke<CloudMutationOutboxRow>("cloud_sync_enqueue_shared_mutation", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function flushRuntimeCloudSyncOutbox(workspaceId = activeDataScope()?.workspaceId) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<CloudSyncFlushResult>("cloud_sync_flush_outbox", { workspaceId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function pullRuntimeCloudSyncAfterCursor(workspaceId = activeDataScope()?.workspaceId) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<CloudSyncPullResult>("cloud_sync_pull_after_cursor", { workspaceId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Mobile remote control.
//
// Rust owns status and trust metadata. Browser preview returns null, so the UI
// never implies that a live connection exists outside the desktop runtime.
// ---------------------------------------------------------------------------

export async function getRuntimeRemoteControlStatus() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RemoteControlStatusSnapshot>("remote_control_status");
  } catch {
    return null;
  }
}

export async function enableRuntimeRemoteControl(request?: RemoteControlPreferenceRequest) {
  if (!hasTauriRuntime()) return null;
  return invoke<RemoteControlStatusSnapshot>("remote_control_enable", {
    request: request ?? null
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function disableRuntimeRemoteControl(request?: RemoteControlPreferenceRequest) {
  if (!hasTauriRuntime()) return null;
  return invoke<RemoteControlStatusSnapshot>("remote_control_disable", {
    request: request ?? null
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function listRuntimeRemoteDevices() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RemoteDevice[]>("remote_list_devices");
  } catch {
    return null;
  }
}

export async function revokeRuntimeRemoteDevice(deviceId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RemoteDevice>("remote_revoke_device", { deviceId }).catch((error) => {
    throw toRuntimeError(error);
  });
}

// ---------------------------------------------------------------------------
// First-wave connectors.
//
// The runtime owns auth, credentials, provider health, and future network
// egress. Browser preview returns null so the shell can use explicit fixture
// adapters without claiming a live connection.
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
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function completeRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("complete_connector_auth", {
      request,
      workspaceId: scope.workspaceId
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
export async function beginRuntimeConnectorOAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("begin_connector_oauth", {
      request,
      workspaceId: scope.workspaceId
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
  onComplete: (event: { connectorId: string; status: string; message: string }) => void
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
      workspaceId: scope.workspaceId
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
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function switchRuntimeConnectorAccount(connectorId: string, accountId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("switch_connector_account", {
      connectorId,
      accountId,
      workspaceId: scope.workspaceId
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
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorSyncStates(workspaceId = activeDataScope()?.workspaceId) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<ConnectorSyncState[]>("list_connector_sync_states", { workspaceId });
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

export async function searchRuntimeConnector(request: ConnectorSearchRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorSearchResult>("search_connector", {
      request,
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeConnectorItem(request: ConnectorImportRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorImportResult>("import_connector_item", {
      request,
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeConnectorAction(request: ConnectorActionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorActionRequest>("prepare_connector_action", {
      request,
      workspaceId: scope.workspaceId
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
    return await invoke<ConnectorActionResult>("execute_approved_connector_action", {
      request,
      workspaceId: scope.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Agent-runtime backends (Codex, Cursor, Copilot, Grok)
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
  providerId: string
): Promise<BackendVerifyResult | null> {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<BackendVerifyResult>("verify_backend_credential", { providerId });
  } catch (error) {
    // A command failure is treated as a transient failure, not auth failure:
    // the stored key may still be good.
    return {
      providerId,
      outcome: "failed",
      message: toRuntimeError(error).message
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
  decidedAt: string
) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<ApprovalAuditEntry>("record_backend_event", {
      event,
      decidedAt
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
    if (providerId === "ollama") {
      return await invoke<RuntimeModelDiscoveryResult>("list_local_model_models", { providerId });
    }
    return await invoke<RuntimeModelDiscoveryResult>("list_backend_models", { providerId });
  } catch (error) {
    return {
      outcome: "failed" as const,
      models: [],
      message: toRuntimeError(error).message
    };
  }
}

export interface RuntimeLocalModelStatus {
  providerId: string;
  authState: import("@fable/protocol").BackendAuthState;
  version?: string;
  endpoint?: string;
  message: string;
  models: import("@fable/protocol").BackendModel[];
}

export async function detectRuntimeLocalModel(providerId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<RuntimeLocalModelStatus>("detect_local_model_runtime", { providerId });
  } catch {
    return {
      providerId,
      authState: "unavailable" as const,
      message: "Fable could not inspect the local model runtime.",
      models: []
    };
  }
}

/**
 * Listen for normalized SSE lines for a request. Returns an unlisten function
 * (or null outside Tauri).
 */
export async function listenRuntimeBackendEvents(
  requestId: string,
  onLine: (line: string) => void
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    const unlisten = await listen<string>(`arden://backend/${requestId}`, (event) => {
      onLine(event.payload as string);
    });
    return unlisten;
  } catch {
    return null;
  }
}

export interface RuntimeLocalModelStreamRequest {
  providerId: string;
  requestId: string;
  model: string;
  body: unknown;
}

export async function streamRuntimeLocalModelCompletion(request: RuntimeLocalModelStreamRequest) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("stream_local_model_completion", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function cancelRuntimeLocalModelCompletion(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("cancel_local_model_completion", { requestId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeLocalModelEvents(
  requestId: string,
  onLine: (line: string) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<string>(`arden://local-model/${requestId}`, (event) => {
      onLine(event.payload as string);
    });
    return unlisten;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex app-server bridge.
//
// Fable never handles ChatGPT subscription tokens. Rust starts/supervises the
// Codex-owned app-server process; JavaScript only receives normalized runtime
// events and sends approval decisions back by opaque request id.
// ---------------------------------------------------------------------------

export interface RuntimeCodexStatus {
  installed: boolean;
  authenticated: boolean;
  authMethod?: "chatgpt" | "api-key" | "provider-login";
  executablePath?: string;
  version?: string;
  message?: string;
}

export interface RuntimeCodexTurnStartRequest {
  requestId: string;
  providerId: string;
  threadId: string | null;
  request: AgentRunRequest;
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
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
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
      message: "Fable could not inspect the Codex CLI."
    };
  }
}

export async function startRuntimeCodexTurn(request: RuntimeCodexTurnStartRequest) {
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
  onEvent: (event: RuntimeCodexEvent) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<RuntimeCodexEvent>(`fable://codex/${requestId}`, (event) => {
      onEvent(event.payload);
    });
    return unlisten;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ACP (Agent Client Protocol) CLI process bridge.
//
// Rust owns the CLI child process for catalog-declared ACP providers: it spawns
// the provider's CLI with piped stdio, emits each stdout line on
// `arden://acp/<sessionId>`, writes stdin frames on command, and kills the
// child on close. Auth is provider-owned, so Fable never collects a subscription
// token. These wrappers are thin invoke/listen seams over those Rust commands;
// outside Tauri they return null so the transport stays fixture-testable.
// ---------------------------------------------------------------------------

export interface RuntimeSpawnAcpProcessRequest {
  providerId: string;
  extraArgs?: string[];
}

export interface RuntimeSpawnedAcpProcess {
  sessionId: string;
  /** Canonical workspace directory the Rust boundary assigned to the child. */
  cwd: string;
}

export async function spawnRuntimeAcpProcess(request: RuntimeSpawnAcpProcessRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<RuntimeSpawnedAcpProcess>("spawn_acp_process", {
      request: { providerId: request.providerId, extraArgs: request.extraArgs ?? [] }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function writeRuntimeAcpFrame(sessionId: string, frame: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<null>("write_acp_frame", { request: { sessionId, frame } });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function closeRuntimeAcpProcess(sessionId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<boolean>("close_acp_process", { sessionId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export type RuntimeAcpCliProbeResult =
  | "not-installed"
  | "signed-out"
  | "connected"
  | "auth-failed"
  | "unavailable";

export async function detectRuntimeAcpCli(
  providerId: string
): Promise<RuntimeAcpCliProbeResult | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<RuntimeAcpCliProbeResult>("detect_acp_cli", { providerId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeAcpFrames(
  sessionId: string,
  onFrame: (line: string) => void
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    const unlisten = await listen<string>(`arden://acp/${sessionId}`, (event) => {
      onFrame(event.payload as string);
    });
    return unlisten;
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

// ---------------------------------------------------------------------------
// Scheduler durable store (jobs + queue). The Rust boundary owns durability +
// the in-process tick that leases due entries and emits run-request events.
// Because Tauri is a single shared process, the lease map is the cross-window
// duplicate-execution guard. Outside Tauri these return null so the shell
// stays fixture-testable without claiming live scheduling.
// ---------------------------------------------------------------------------

export async function listRuntimeSchedulerJobs() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ScheduledJob[]>("list_scheduler_jobs", scope);
  } catch {
    return null;
  }
}

export async function listRuntimeSchedulerQueue() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<SchedulerQueueEntry[]>("list_scheduler_queue", scope);
  } catch {
    return null;
  }
}

export async function saveRuntimeScheduledJob(job: ScheduledJob) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ScheduledJob>("save_scheduled_job", { job, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function deleteRuntimeScheduledJob(jobId: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<void>("delete_scheduled_job", { jobId, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function setRuntimeJobStatus(jobId: string, status: ScheduledJobStatus) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<void>("set_job_status", { jobId, status, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function enqueueRuntimeJobRun(jobId: string, runId: string, scheduledAt: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<SchedulerQueueEntry>("enqueue_job_run", {
      jobId,
      runId,
      scheduledAt,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function reportRuntimeJobAttempt(runId: string, attempt: JobAttempt) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<void>("report_job_attempt", { runId, attempt, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Renew a running entry's lease (heartbeat). Rejects stale tokens in Rust. */
export async function renewRuntimeJobLease(runId: string, leaseToken: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<boolean>("renew_job_lease", {
      runId,
      leaseToken,
      ...scope
    });
  } catch {
    return null;
  }
}

/** Re-queue a blocked-auth entry once its backend reconnected. */
export async function requeueRuntimeBlockedJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<boolean>("requeue_blocked_job_run", { runId, ...scope });
  } catch {
    return null;
  }
}

/** Cancel a queued/leased/running entry from the Schedules UI. */
export async function cancelRuntimeJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<boolean>("cancel_job_run", { runId, ...scope });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Listen for the Rust tick's run-request events (a due occurrence was leased).
 * The TS scheduler driver starts a workflow run in response. The payload now
 * carries a fencing `leaseToken` and the frozen `execution` route so the
 * headless runner can resolve the backend/model without a job lookup. Returns
 * an unlisten function (or null outside Tauri).
 */
export async function listenRuntimeSchedulerRunRequest(
  onRun: (event: {
    workspaceId?: string;
    projectId?: string;
    jobId: string;
    runId: string;
    scheduledAt: string;
    leaseToken?: string;
    attemptNumber?: number;
    execution?: ScheduledExecutionRoute;
  }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<{
      workspaceId?: string;
      projectId?: string;
      jobId: string;
      runId: string;
      scheduledAt: string;
      leaseToken?: string;
      attemptNumber?: number;
      execution?: ScheduledExecutionRoute;
    }>("fable://scheduler/run-request", (event) => {
      const scope = activeDataScope();
      if (!scope) return;
      const workspaceId = event.payload.workspaceId;
      if (
        workspaceId === scope.workspaceId &&
        (event.payload.projectId ?? null) === scope.projectId
      ) {
        onRun(event.payload);
      }
    });
    return unlisten;
  } catch {
    return null;
  }
}

/** Listen for durable run cancellation and forward it to the active backend. */
export async function listenRuntimeSchedulerCancelRequest(
  onCancel: (event: { runId: string }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<{ runId: string; workspaceId?: string; projectId?: string }>(
      "fable://scheduler/cancel-request",
      (event) => {
        const scope = activeDataScope();
        if (scope && event.payload.workspaceId === scope.workspaceId) {
          onCancel({ runId: event.payload.runId });
        }
      }
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workflow-run journal. The Rust boundary owns atomic persistence + bounded
// history. The TS layer owns run execution + restart-recovery marking.
// ---------------------------------------------------------------------------

/** The wire shape crossing the Rust boundary (camelCase mirrors the Rust struct). */
export interface WorkflowRunRecordWire {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: WorkflowRunStatus;
  trigger: WorkflowRun["trigger"];
  scheduledJobId?: string;
  permissionProfile?: WorkflowRun["permissionProfile"];
  input: unknown;
  steps: unknown;
  failureReason?: string;
  idempotencyKey?: string;
  attemptNumber?: number;
  nextRetryAt?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

function toWorkflowRunWire(run: WorkflowRun): WorkflowRunRecordWire {
  return {
    id: run.id,
    definitionId: run.definitionId,
    definitionVersion: run.definitionVersion,
    status: run.status,
    trigger: run.trigger,
    scheduledJobId: run.scheduledJobId,
    permissionProfile: run.permissionProfile,
    input: run.input,
    steps: run.steps,
    failureReason: run.failureReason,
    idempotencyKey: run.idempotencyKey,
    attemptNumber: run.attemptNumber,
    nextRetryAt: run.nextRetryAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt
  };
}

/** Convert a wire record back into the protocol WorkflowRun shape. */
export function wireToWorkflowRun(record: WorkflowRunRecordWire): WorkflowRun {
  return {
    id: record.id,
    definitionId: record.definitionId,
    definitionVersion: record.definitionVersion,
    status: record.status,
    trigger: record.trigger,
    scheduledJobId: record.scheduledJobId,
    permissionProfile: record.permissionProfile,
    input: (record.input as Record<string, unknown>) ?? {},
    steps: (record.steps as WorkflowRun["steps"]) ?? [],
    failureReason: record.failureReason,
    idempotencyKey: record.idempotencyKey,
    attemptNumber: record.attemptNumber,
    nextRetryAt: record.nextRetryAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt
  };
}

export async function saveRuntimeWorkflowRun(run: WorkflowRun) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  const record = toWorkflowRunWire(run);
  try {
    return await invoke<WorkflowRunRecordWire>("save_workflow_run", {
      run: record,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeWorkflowDefinition(definition: WorkflowDefinition) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<WorkflowDefinition>("save_workflow_definition", {
      definition,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeWorkflowDefinitions() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<WorkflowDefinition[]>("list_workflow_definitions", scope);
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRuns() {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs", scope);
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRunsForDefinition(definitionId: string) {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs_for_definition", {
      definitionId,
      ...scope
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OS notifications. The TS layer shapes private/public bodies; Rust only
// delivers them and emits the click deep-link so the shell navigates to the run.
// ---------------------------------------------------------------------------

export async function deliverRuntimeNotification(record: NotificationRecord) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("deliver_notification", {
      request: {
        id: record.id,
        title: record.title,
        body: record.body,
        deepLinkPage: record.deepLink?.page,
        runId: record.deepLink?.runId
      }
    });
  } catch {
    return null;
  }
}

/**
 * Listen for notification click deep-links so the shell navigates to the run.
 * Returns an unlisten function (or null outside Tauri).
 */
export async function listenRuntimeNotificationClick(
  onClick: (event: { page: string; runId: string; notificationId: string }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<{
      page: string;
      runId: string;
      notificationId: string;
    }>("fable://notification/click", (event) => onClick(event.payload));
    return unlisten;
  } catch {
    return null;
  }
}
