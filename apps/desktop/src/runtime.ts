import { getActiveRuntimeDataScope } from "./runtime-scope";
import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter
} from "./runtime/adapters/select";
import type { RuntimeEvent, RuntimeUnlisten } from "./runtime/ports";
import { toRuntimeError } from "./runtime/errors";
export {
  createRuntimeLocalBackup,
  deleteRuntimeLocalData,
  exportRuntimeProjectArchive,
  exportRuntimeWorkspaceArchive,
  importRuntimeWorkspaceArchive,
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
  type RuntimePortableExportReceipt,
  type RuntimePortableImportReport
} from "./runtime/domains/local-data";
export {
  acceptRuntimePendingInvitation,
  beginRuntimeIdentityRecovery,
  beginRuntimeIdentitySignIn,
  changeRuntimeWorkspaceMember,
  clearRuntimeAccountWorkspaceSession,
  createRuntimeAccountWorkspace,
  createRuntimeWorkspaceInvitation,
  disableRuntimeRemoteControl,
  enableRuntimeRemoteControl,
  enqueueRuntimeCloudSyncMutation,
  flushRuntimeCloudSyncOutbox,
  getRuntimeRemoteControlStatus,
  listRuntimeRemoteDevices,
  loadRuntimeAccountWorkspaceStatus,
  loadRuntimeCloudSyncLinkState,
  loadRuntimeCloudSyncStatus,
  loadRuntimeIdentityStatus,
  loadRuntimePendingInvitations,
  loadRuntimeWorkspaceMembers,
  pullRuntimeCloudSyncAfterCursor,
  reconcileRuntimeAccountWorkspace,
  refreshRuntimeIdentity,
  revokeRuntimeAccountDevice,
  revokeRuntimeRemoteDevice,
  selectRuntimeAccountWorkspace,
  signOutRuntimeIdentity,
  type AccountRuntimePort
} from "./runtime/domains/account";
export {
  inspectRuntimeHostedProcess,
  inspectRuntimeHostedProcessSchedule,
  listRuntimeHostedProcessSchedules,
  listRuntimeHostedProcessScheduleRuns,
  cancelRuntimeHostedProcessSchedule,
  controlRuntimeHostedProcessSchedule,
  prepareRuntimeHostedAgentRoutine,
  createRuntimeHostedAgentRoutine,
  listRuntimeHostedAgentRoutines,
  listRuntimeHostedAgentRoutineRuns,
  prepareRuntimeHostedAgentRoutineCancel,
  cancelRuntimeHostedAgentRoutine,
  prepareRuntimeHostedAgentRoutineControl,
  controlRuntimeHostedAgentRoutine,
  killRuntimeHostedProcess,
  launchRuntimeHostedProcess,
  loadRuntimeHostedComputer,
  createRuntimeHostedProcessSchedule,
  navigateRuntimeHostedBrowser,
  actRuntimeHostedBrowser,
  prepareRuntimeHostedBrowser,
  prepareRuntimeHostedBrowserAction,
  prepareRuntimeHostedProcess,
  prepareRuntimeHostedProcessSchedule,
  prepareRuntimeHostedProcessScheduleCancel,
  prepareRuntimeHostedProcessScheduleControl,
  provisionRuntimeHostedComputer,
  snapshotRuntimeHostedBrowser,
  type HostedComputerRuntimePort
} from "./runtime/domains/hosted-computer";
export {
  historyRuntimeLocalBrowser,
  keyRuntimeLocalBrowser,
  listRuntimeLocalComputerFiles,
  previewRuntimeLocalComputerFile,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  provisionRuntimeLocalComputer,
  setRuntimeLocalComputerController,
  snapshotRuntimeLocalBrowser,
} from "./runtime/domains/local-computer";
import { importLocalTextFile } from "@fable/connectors/local-files";
import { searchKnowledgeSources } from "@fable/connectors/knowledge-search";
import type { LocalTextFileCandidate } from "@fable/connectors/local-files";
import type {
  LegacyRoutineMigrationInput,
  LegacyRoutineMigrationPlan
} from "@fable/connectors/routines";
import { applyLocalKnowledgeRefresh } from "./lib/local-knowledge-refresh";
import { getRuntimeProject } from "./lib/project-runtime";
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
  LocalKnowledgeRefreshResponse,
  RefreshLocalKnowledgeSourceRequest,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  NotificationRecord,
  PersistedAgentRun,
  RecordActionHistoryRequest,
  RuntimeSnapshot,
  ScheduledExecutionRoute,
  ScheduledJob,
  ScheduledJobStatus,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus
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
  handler: (event: RuntimeEvent<T>) => void
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

export interface RuntimeKnowledgeScopeOverride {
  workspaceId: string;
  projectId: string;
}

export interface RuntimeMemoryScopeOverride {
  workspaceId: string;
  projectId: string;
}

const previewProjectKnowledge = new Map<string, LocalFileImport[]>();
const previewProjectMemory = new Map<string, MemoryControlState>();

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

function memoryScope(scopeOverride?: RuntimeMemoryScopeOverride) {
  const active = activeDataScope();
  if (!scopeOverride) return active;
  const workspaceId = scopeOverride.workspaceId.trim();
  const projectId = scopeOverride.projectId.trim();
  if (!workspaceId || !projectId) {
    throw new Error("Project memory requires a workspace and project.");
  }
  if (!active || active.workspaceId !== workspaceId) {
    throw new Error("The active memory workspace changed. Refresh and try again.");
  }
  return { workspaceId, projectId };
}

function previewMemoryKey(scope: RuntimeMemoryScopeOverride) {
  return `${scope.workspaceId}\u0000${scope.projectId}`;
}

function canonicalProjectMemoryState(
  state: MemoryControlState,
  scope: RuntimeMemoryScopeOverride
): MemoryControlState {
  return {
    disabled: state.disabled,
    records: state.records.map((record) => {
      if (record.workspaceId && record.workspaceId !== scope.workspaceId) {
        throw new Error("Memory records cannot cross workspace boundaries.");
      }
      if (record.scope && (
        record.scope.level !== "project" || record.scope.projectId !== scope.projectId
      )) {
        throw new Error("Memory records cannot cross project boundaries.");
      }
      return {
        ...record,
        workspaceId: scope.workspaceId,
        scope: { level: "project" as const, projectId: scope.projectId }
      };
    })
  };
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

export async function refreshRuntimeLocalKnowledgeSource(
  request: RefreshLocalKnowledgeSourceRequest,
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const key = previewKnowledgeKey(scopeOverride);
    const sources = previewProjectKnowledge.get(key) ?? [];
    const index = sources.findIndex((source) => source.id === request.sourceId.trim());
    if (index < 0) throw new Error("That local knowledge source is no longer available.");
    const source = sources[index];
    if (source.workspaceId !== scopeOverride.workspaceId ||
        source.scope?.level !== "project" || source.scope.projectId !== scopeOverride.projectId) {
      throw new Error("Knowledge source does not belong to this project.");
    }
    const response = applyLocalKnowledgeRefresh(source, request);
    if (response.outcome === "updated") {
      const next = [...sources];
      next[index] = response.source;
      previewProjectKnowledge.set(key, next);
    }
    return response;
  }
  try {
    return await invoke<LocalKnowledgeRefreshResponse>("refresh_local_knowledge_source", {
      request,
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

export async function loadRuntimeMemoryState(scopeOverride?: RuntimeMemoryScopeOverride) {
  const scope = memoryScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    return previewProjectMemory.get(previewMemoryKey(scopeOverride)) ?? { disabled: false, records: [] };
  }

  try {
    return await invoke<MemoryControlState>("list_memory_state", scope);
  } catch (error) {
    if (scopeOverride) throw toRuntimeError(error);
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

export type RuntimeArtifactBundle = Spine.ArtifactsAndRoutines.ArtifactBundle;

export interface CreateResponseArtifactInput {
  threadId: string;
  messageId: string;
  runId: string;
  title: string;
  content: string;
  citations: readonly KnowledgeCitation[];
}

const previewArtifacts = new Map<string, RuntimeArtifactBundle[]>();
const previewArtifactProjectAssociations = new Map<string, Map<string, Map<string, string>>>();
const ARTIFACT_MAX_INLINE_CONTENT_BYTES = 65_536;

function isArtifactMedia(value: unknown): value is Spine.ArtifactsAndRoutines.ArtifactMediaMetadata {
  return isRecord(value) &&
    typeof value.mediaType === "string" &&
    typeof value.byteLength === "number" &&
    Number.isInteger(value.byteLength) &&
    value.byteLength >= 0;
}

function isContentHash(value: unknown): value is Spine.ArtifactsAndRoutines.ContentHash {
  return isRecord(value) &&
    typeof value.algorithm === "string" &&
    typeof value.value === "string" &&
    value.value.length > 0;
}

function isArtifactContent(value: unknown): value is Spine.ArtifactsAndRoutines.ArtifactContent {
  if (!isRecord(value) || !isArtifactMedia(value.media) || !isContentHash(value.contentHash)) return false;
  if (value.kind === "inline") return typeof value.text === "string";
  return value.kind === "locator" && typeof value.locator === "string";
}

function isArtifactCitation(value: unknown) {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isRecord(value.source) &&
    typeof value.source.kind === "string" &&
    typeof value.source.observedAt === "string" &&
    (value.locator === undefined || typeof value.locator === "string") &&
    (value.quotedText === undefined || typeof value.quotedText === "string");
}

function isArtifactLineage(value: unknown) {
  return isRecord(value) &&
    typeof value.relation === "string" &&
    typeof value.artifactId === "string" &&
    typeof value.recordedAt === "string" &&
    (value.artifactVersionId === undefined || typeof value.artifactVersionId === "string");
}

function isArtifactVersion(value: unknown, artifactId: string, expectedNumber: number) {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.artifactId === artifactId &&
    value.version === expectedNumber &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.createdByInternalUserId === "string" &&
    isArtifactContent(value.content) &&
    isArtifactMedia(value.media) &&
    isContentHash(value.contentHash) &&
    structurallyEqual(value.content.media, value.media) &&
    structurallyEqual(value.content.contentHash, value.contentHash) &&
    isRecord(value.provenance) &&
    typeof value.provenance.kind === "string" &&
    typeof value.provenance.observedAt === "string" &&
    Array.isArray(value.citations) &&
    value.citations.every(isArtifactCitation) &&
    Array.isArray(value.lineage) &&
    value.lineage.every(isArtifactLineage) &&
    (value.inputs === undefined || (Array.isArray(value.inputs) && value.inputs.every(isRecord))) &&
    (value.decisions === undefined || (Array.isArray(value.decisions) && value.decisions.every(isRecord)));
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => structurallyEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
}

const ARTIFACT_REVIEW_STATUS_VALUES = new Set(["requested", "approved", "changes-requested"]);
const ARTIFACT_REVIEW_TEXT_MAX_CHARS = 2_000;

function isArtifactReview(value: unknown, artifact: Record<string, unknown>, versions: unknown[]) {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !value.id ||
      typeof value.status !== "string" || !ARTIFACT_REVIEW_STATUS_VALUES.has(value.status) ||
      typeof value.requestedByInternalUserId !== "string" || !value.requestedByInternalUserId ||
      typeof value.versionId !== "string" ||
      !versions.some((version) => isRecord(version) && version.id === value.versionId) ||
      typeof value.requestedAt !== "string" || Number.isNaN(Date.parse(value.requestedAt)) ||
      (value.resolvedAt !== undefined &&
        (typeof value.resolvedAt !== "string" || Number.isNaN(Date.parse(value.resolvedAt)))) ||
      (value.reviewerMemberId !== undefined &&
        (typeof value.reviewerMemberId !== "string" || value.reviewerMemberId !== artifact.ownerMemberId)) ||
      (value.summary !== undefined &&
        (typeof value.summary !== "string" || value.summary.length > ARTIFACT_REVIEW_TEXT_MAX_CHARS)) ||
      (value.requestedChanges !== undefined &&
        (!Array.isArray(value.requestedChanges) || value.requestedChanges.length === 0 ||
          value.requestedChanges.some((entry) =>
            typeof entry !== "string" || !entry.trim() || entry.length > ARTIFACT_REVIEW_TEXT_MAX_CHARS
          )))) {
    return false;
  }
  const resolved = value.status === "approved" || value.status === "changes-requested";
  if (resolved !== (typeof value.resolvedAt === "string")) return false;
  if (value.status === "requested") {
    return value.requestedChanges === undefined && value.acceptance === undefined;
  }
  if (value.status === "changes-requested") {
    if (!Array.isArray(value.requestedChanges) || value.acceptance !== undefined) return false;
    const normalized = value.requestedChanges.map((entry) => (entry as string).trim());
    return new Set(normalized).size === normalized.length;
  }
  return value.requestedChanges === undefined &&
    isRecord(value.acceptance) &&
    value.acceptance.acceptedByInternalUserId === value.requestedByInternalUserId &&
    typeof value.acceptance.acceptedAt === "string" &&
    value.acceptance.acceptedAt === value.resolvedAt &&
    !Number.isNaN(Date.parse(value.acceptance.acceptedAt)) &&
    (value.acceptance.note === undefined ||
      (typeof value.acceptance.note === "string" &&
        value.acceptance.note.length <= ARTIFACT_REVIEW_TEXT_MAX_CHARS));
}

function assertArtifactBundle(value: unknown, workspaceId: string): asserts value is RuntimeArtifactBundle {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.currentVersion) || !Array.isArray(value.versions)) {
    throw new Error("Malformed or cross-workspace artifact response.");
  }
  const artifact = value.artifact;
  const currentVersion = value.currentVersion;
  const versions = value.versions;
  const finalVersion = versions[versions.length - 1];
  if (typeof artifact.id !== "string") {
    throw new Error("Malformed or cross-workspace artifact response.");
  }
  const artifactId = artifact.id;
  const malformed =
    artifact.workspaceId !== workspaceId ||
    typeof artifact.authority !== "string" ||
    typeof artifact.visibility !== "string" ||
    typeof artifact.schemaVersion !== "number" ||
    !Number.isInteger(artifact.schemaVersion) ||
    typeof artifact.title !== "string" ||
    typeof artifact.kind !== "string" ||
    typeof artifact.status !== "string" ||
    typeof artifact.createdByInternalUserId !== "string" ||
    typeof artifact.createdAt !== "string" ||
    typeof artifact.updatedAt !== "string" ||
    typeof artifact.currentVersionId !== "string" ||
    typeof artifact.revision !== "number" ||
    !Number.isInteger(artifact.revision) ||
    artifact.revision < 1 ||
    !Array.isArray(artifact.sourceProvenance) ||
    !artifact.sourceProvenance.every(isRecord) ||
    !isRecord(artifact.context) ||
    !Array.isArray(artifact.reviews) ||
    !artifact.reviews.every((review) => isArtifactReview(review, artifact, versions)) ||
    !isRecord(artifact.retention) ||
    typeof artifact.retention.status !== "string" ||
    (value.sourceMessageId !== undefined && typeof value.sourceMessageId !== "string") ||
    versions.length === 0 ||
    versions.some((version, index) => !isArtifactVersion(version, artifactId, index + 1)) ||
    !isRecord(finalVersion) ||
    artifact.currentVersionId !== finalVersion.id ||
    !structurallyEqual(currentVersion, finalVersion);
  if (malformed) {
    throw new Error("Malformed or cross-workspace artifact response.");
  }
  // Consumers receive the canonical final version object, never a divergent
  // duplicate supplied alongside the immutable ordered history.
  value.currentVersion = finalVersion as unknown as RuntimeArtifactBundle["currentVersion"];
}

function validateArtifactText(content: string) {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength === 0) throw new Error("Add some content before saving a new version.");
  if (byteLength > ARTIFACT_MAX_INLINE_CONTENT_BYTES) {
    throw new Error("This version is too large. Keep it under 64 KiB.");
  }
  return byteLength;
}

async function inlineArtifactContent(content: string): Promise<Extract<Spine.ArtifactsAndRoutines.ArtifactContent, { kind: "inline" }>> {
  const bytes = new TextEncoder().encode(content);
  const byteLength = validateArtifactText(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const media = { mediaType: "text/markdown", byteLength, encoding: "utf-8" };
  return {
    kind: "inline",
    text: content,
    media,
    contentHash: { algorithm: "sha-256", value: hash }
  };
}

function staleArtifactVersionError() {
  return new Error("This artifact changed elsewhere. Reopen it before saving a new version.");
}

export async function createRuntimeResponseArtifact(input: CreateResponseArtifactInput) {
  const scope = conversationScopeOrThrow();
  const artifactId = `artifact-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const versionId = `artifact-version-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  // The native boundary derives citations from the immutable completed-run
  // receipt. Renderer citation state is intentionally not part of this request.
  const nativeInput = {
    artifactId,
    versionId,
    runId: input.runId,
    threadId: input.threadId,
    messageId: input.messageId,
    title: input.title,
    content: input.content
  };
  if (!hasTauriRuntime()) {
    const now = new Date().toISOString();
    const content = await inlineArtifactContent(input.content);
    const provenance = { kind: "run" as const, runId: input.runId as never, externalReference: `message:${input.messageId}`, observedAt: now };
    const currentVersion = {
      id: versionId, artifactId, version: 1, status: "available", createdAt: now,
      createdByInternalUserId: "preview-user", content,
      media: content.media, contentHash: content.contentHash, provenance, citations: [], lineage: []
    };
    const bundle = {
      artifact: { id: artifactId, workspaceId: scope.workspaceId, authority: "local", visibility: "member-private", ownerMemberId: "preview-member", schemaVersion: 1, revision: 1, createdByInternalUserId: "preview-user", createdAt: now, updatedAt: now, kind: "document", status: "draft", title: input.title, currentVersionId: versionId, producingRunId: input.runId, sourceProvenance: [provenance], context: { threadId: input.threadId }, reviews: [], retention: { status: "active" } },
      currentVersion,
      versions: [currentVersion],
      sourceMessageId: input.messageId
    } as unknown as RuntimeArtifactBundle;
    assertArtifactBundle(bundle, scope.workspaceId);
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

export type RuntimeArtifactSearchResult = Spine.ArtifactsAndRoutines.ArtifactSearchResult;
export type RuntimeArtifactExport = Spine.ArtifactsAndRoutines.ArtifactExport;
export type RuntimeArtifactHandoff = Spine.ArtifactsAndRoutines.ArtifactHandoff;

const knownArtifactHandoffs = new Map<string, Map<string, RuntimeArtifactHandoff>>();

const ARTIFACT_MATCH_FIELDS = new Set(["title", "content", "source", "decision"]);

function assertArtifactSearchResult(
  value: unknown,
  workspaceId: string
): asserts value is RuntimeArtifactSearchResult {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.currentVersion) ||
      !Array.isArray(value.matchedOn)) {
    throw new Error("Malformed or cross-workspace artifact search response.");
  }
  const artifact = value.artifact;
  const currentVersion = value.currentVersion;
  if (typeof artifact.id !== "string" ||
      artifact.workspaceId !== workspaceId ||
      typeof artifact.title !== "string" ||
      typeof artifact.kind !== "string" ||
      typeof artifact.status !== "string" ||
      typeof artifact.currentVersionId !== "string" ||
      typeof artifact.revision !== "number" || !Number.isInteger(artifact.revision) || artifact.revision < 1 ||
      !Array.isArray(artifact.sourceProvenance) || !artifact.sourceProvenance.every(isRecord) ||
      !Array.isArray(artifact.reviews) || !artifact.reviews.every(isRecord) ||
      typeof currentVersion.version !== "number" || !Number.isInteger(currentVersion.version) ||
      !isArtifactVersion(currentVersion, artifact.id, currentVersion.version) ||
      artifact.currentVersionId !== currentVersion.id ||
      value.matchedOn.some((field) => typeof field !== "string" || !ARTIFACT_MATCH_FIELDS.has(field))) {
    throw new Error("Malformed or cross-workspace artifact search response.");
  }
}

function parseArtifactExport(
  value: unknown,
  artifactId: string,
  versionId: string
): RuntimeArtifactExport {
  const allowedKeys = new Set([
    "artifactId", "versionId", "title", "kind", "exportedAt", "content",
    "citations", "inputs", "decisions", "lineage"
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key)) ||
      value.artifactId !== artifactId || value.versionId !== versionId ||
      typeof value.title !== "string" || typeof value.kind !== "string" ||
      typeof value.exportedAt !== "string" || Number.isNaN(Date.parse(value.exportedAt)) ||
      !isArtifactContent(value.content) ||
      !Array.isArray(value.citations) || !value.citations.every(isArtifactCitation) ||
      !Array.isArray(value.inputs) || !value.inputs.every(isRecord) ||
      !Array.isArray(value.decisions) || !value.decisions.every(isRecord) ||
      !Array.isArray(value.lineage) || !value.lineage.every(isArtifactLineage)) {
    throw new Error("Malformed artifact export response.");
  }
  return value as unknown as RuntimeArtifactExport;
}

const HANDOFF_CONTEXT_KEYS = new Set([
  "workspaceId", "threadId", "projectId", "goalId", "missionId",
  "departmentId", "pipelineId", "routineId"
]);

function isHandoffContext(value: unknown, workspaceId: string) {
  return isRecord(value) && value.workspaceId === workspaceId &&
    Object.keys(value).every((key) => HANDOFF_CONTEXT_KEYS.has(key)) &&
    Object.entries(value).every(([key, entry]) =>
      key === "workspaceId" || (typeof entry === "string" && entry.length > 0)
    );
}

function parseArtifactHandoff(value: unknown, expected: {
  workspaceId: string;
  ownerMemberId: string;
  source: Spine.ArtifactsAndRoutines.HandoffContextReference;
  targetProjectId: string;
  versionId: string;
  status: "proposed" | "accepted";
  revision?: number;
  note?: string;
}) {
  const allowedKeys = new Set([
    "id", "workspaceId", "authority", "visibility", "ownerMemberId", "schemaVersion",
    "revision", "createdByInternalUserId", "createdByDeviceId", "createdAt", "updatedAt",
    "deletedAt", "status", "source", "target", "artifactVersionIds", "includedContext",
    "authorityTransfer", "proposedByInternalUserId", "proposedAt", "resolvedAt",
    "resolvedByInternalUserId", "rejectionReason", "note"
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key)) ||
      typeof value.id !== "string" || !value.id || value.workspaceId !== expected.workspaceId ||
      value.authority !== "local" || value.visibility !== "member-private" ||
      value.ownerMemberId !== expected.ownerMemberId ||
      typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 ||
      typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1 ||
      (expected.revision !== undefined && value.revision !== expected.revision) ||
      typeof value.createdByInternalUserId !== "string" || !value.createdByInternalUserId ||
      (value.createdByDeviceId !== undefined && typeof value.createdByDeviceId !== "string") ||
      typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt)) ||
      (value.deletedAt !== undefined && (typeof value.deletedAt !== "string" || Number.isNaN(Date.parse(value.deletedAt)))) ||
      value.status !== expected.status || !isHandoffContext(value.source, expected.workspaceId) ||
      !structurallyEqual(value.source, expected.source) || !isHandoffContext(value.target, expected.workspaceId) ||
      !structurallyEqual(value.target, { workspaceId: expected.workspaceId, projectId: expected.targetProjectId }) ||
      !Array.isArray(value.artifactVersionIds) || value.artifactVersionIds.length !== 1 ||
      value.artifactVersionIds[0] !== expected.versionId ||
      !Array.isArray(value.includedContext) || value.includedContext.length !== 0 ||
      value.authorityTransfer !== "none" ||
      typeof value.proposedByInternalUserId !== "string" || !value.proposedByInternalUserId ||
      value.proposedByInternalUserId !== value.createdByInternalUserId ||
      typeof value.proposedAt !== "string" || Number.isNaN(Date.parse(value.proposedAt)) ||
      value.note !== expected.note ||
      (value.rejectionReason !== undefined && typeof value.rejectionReason !== "string")) {
    throw new Error("Malformed or cross-workspace artifact handoff response.");
  }
  if (expected.status === "proposed") {
    if (value.resolvedAt !== undefined || value.resolvedByInternalUserId !== undefined || value.rejectionReason !== undefined) {
      throw new Error("Malformed or cross-workspace artifact handoff response.");
    }
  } else if (typeof value.resolvedAt !== "string" || Number.isNaN(Date.parse(value.resolvedAt)) ||
      typeof value.resolvedByInternalUserId !== "string" || !value.resolvedByInternalUserId ||
      value.rejectionReason !== undefined) {
    throw new Error("Malformed or cross-workspace artifact handoff response.");
  }
  return value as unknown as RuntimeArtifactHandoff;
}

function rememberArtifactHandoff(handoff: RuntimeArtifactHandoff) {
  let workspace = knownArtifactHandoffs.get(handoff.workspaceId);
  if (!workspace) {
    workspace = new Map();
    knownArtifactHandoffs.set(handoff.workspaceId, workspace);
  }
  workspace.set(handoff.id, handoff);
}

export async function searchRuntimeArtifacts(
  query: Spine.ArtifactsAndRoutines.ArtifactSearchQuery = {}
): Promise<RuntimeArtifactSearchResult[]> {
  const scope = conversationScopeOrThrow();
  const boundedQuery = {
    ...(query.query?.trim() ? { query: query.query.trim() } : {}),
    ...(query.threadId ? { threadId: query.threadId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.kinds ? { kinds: query.kinds } : {}),
    ...(query.statuses ? { statuses: query.statuses } : {}),
    limit: Math.max(1, Math.min(query.limit ?? 100, 100))
  };
  if (!hasTauriRuntime()) {
    const normalized = boundedQuery.query?.toLowerCase() ?? "";
    const records = previewArtifacts.get(scope.workspaceId) ?? [];
    return records.flatMap((entry) => {
      const { artifact, currentVersion } = entry;
      if (boundedQuery.threadId && artifact.context.threadId !== boundedQuery.threadId) return [];
      const associatedVersionId = boundedQuery.projectId
        ? previewArtifactProjectAssociations.get(scope.workspaceId)?.get(boundedQuery.projectId)?.get(artifact.id)
        : undefined;
      if (boundedQuery.projectId && artifact.context.projectId !== boundedQuery.projectId && !associatedVersionId) return [];
      const projectedVersion = associatedVersionId
        ? entry.versions.find((version) => version.id === associatedVersionId)
        : currentVersion;
      if (!projectedVersion) return [];
      if (boundedQuery.kinds && !boundedQuery.kinds.includes(artifact.kind)) return [];
      if (boundedQuery.statuses && !boundedQuery.statuses.includes(artifact.status)) return [];
      const currentText = projectedVersion.content.kind === "inline" ? projectedVersion.content.text : "";
      const sourceText = projectedVersion.citations.map((citation) =>
        `${citation.label} ${citation.quotedText ?? ""}`
      ).join(" ");
      const decisionText = JSON.stringify(projectedVersion.decisions ?? []);
      const matchedOn: RuntimeArtifactSearchResult["matchedOn"] = normalized ? [
        ...(artifact.title.toLowerCase().includes(normalized) ? ["title" as const] : []),
        ...(currentText.toLowerCase().includes(normalized) ? ["content" as const] : []),
        ...(sourceText.toLowerCase().includes(normalized) ? ["source" as const] : []),
        ...(decisionText.toLowerCase().includes(normalized) ? ["decision" as const] : [])
      ] : [];
      const projectedArtifact = associatedVersionId
        ? { ...artifact, currentVersionId: projectedVersion.id }
        : artifact;
      return normalized && matchedOn.length === 0 ? [] : [{ artifact: projectedArtifact, currentVersion: projectedVersion, matchedOn }];
    }).slice(0, boundedQuery.limit);
  }
  const result = await invoke<unknown>("artifact_search", { input: boundedQuery });
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while artifacts were loading.");
  }
  if (!Array.isArray(result)) throw new Error("Malformed artifact search response.");
  result.forEach((entry) => assertArtifactSearchResult(entry, scope.workspaceId));
  return result;
}

export async function exportRuntimeArtifact(artifactId: string, versionId: string) {
  const scope = conversationScopeOrThrow();
  if (!hasTauriRuntime()) {
    const bundle = (previewArtifacts.get(scope.workspaceId) ?? [])
      .find((entry) => entry.artifact.id === artifactId);
    const version = bundle?.versions.find((entry) => entry.id === versionId);
    if (!bundle || !version) throw new Error("This artifact version is no longer available.");
    return parseArtifactExport({
      artifactId: bundle.artifact.id,
      versionId: version.id,
      title: bundle.artifact.title,
      kind: bundle.artifact.kind,
      exportedAt: new Date().toISOString(),
      content: version.content,
      citations: version.citations,
      inputs: version.inputs ?? [],
      decisions: version.decisions ?? [],
      lineage: version.lineage
    }, artifactId, versionId);
  }
  const result = await invoke<unknown>("artifact_export", { input: { artifactId, versionId } });
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while the artifact was exporting.");
  }
  return parseArtifactExport(result, artifactId, versionId);
}

/** Resolves the artifact's canonical source project without guessing from UI placement. */
export async function getRuntimeArtifactSourceProjectId(artifactId: string): Promise<string | null> {
  const scope = conversationScopeOrThrow();
  const bundle = await getRuntimeArtifact(artifactId);
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while resolving the artifact source.");
  }
  if (!bundle) throw new Error("This artifact is no longer available.");
  if (bundle.artifact.context.projectId) return bundle.artifact.context.projectId;
  const threadId = bundle.artifact.context.threadId;
  if (!threadId) return null;
  const thread = await getRuntimeConversationThread(threadId);
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while resolving the artifact source.");
  }
  if (!thread) return null;
  if (thread.workspaceId !== scope.workspaceId || thread.authority !== "local" ||
      thread.visibility !== "member-private" ||
      (!hasTauriRuntime() && thread.ownerMemberId !== bundle.artifact.ownerMemberId)) {
    throw new Error("The artifact source conversation is outside its private scope.");
  }
  return thread.projectId ?? null;
}

export async function proposeRuntimeArtifactHandoff(input: {
  artifactId: string;
  versionId: string;
  targetProjectId: string;
  note?: string;
}) {
  const scope = conversationScopeOrThrow();
  const bundle = await getRuntimeArtifact(input.artifactId);
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while preparing the artifact handoff.");
  }
  if (!bundle || bundle.artifact.workspaceId !== scope.workspaceId ||
      bundle.artifact.authority !== "local" || bundle.artifact.visibility !== "member-private" ||
      typeof bundle.artifact.ownerMemberId !== "string") {
    throw new Error("This private artifact is no longer available.");
  }
  const ownerMemberId = bundle.artifact.ownerMemberId;
  if (!bundle.versions.some((version) => version.id === input.versionId)) {
    throw new Error("This artifact version is no longer available.");
  }
  let sourceProjectId = bundle.artifact.context.projectId;
  if (!hasTauriRuntime() && !sourceProjectId && bundle.artifact.context.threadId) {
    const sourceThread = await getRuntimeConversationThread(bundle.artifact.context.threadId);
    if (activeDataScope()?.workspaceId !== scope.workspaceId) {
      throw new Error("The active workspace changed while preparing the artifact handoff.");
    }
    if (sourceThread && (sourceThread.workspaceId !== scope.workspaceId ||
        sourceThread.authority !== "local" || sourceThread.visibility !== "member-private" ||
        sourceThread.ownerMemberId !== bundle.artifact.ownerMemberId)) {
      throw new Error("The artifact source conversation is outside its private scope.");
    }
    sourceProjectId = sourceThread?.projectId;
  }
  if (sourceProjectId === input.targetProjectId) {
    throw new Error("This artifact is already in that project.");
  }
  const target = await getRuntimeProject(scope.workspaceId, input.targetProjectId);
  if (activeDataScope()?.workspaceId !== scope.workspaceId) {
    throw new Error("The active workspace changed while preparing the artifact handoff.");
  }
  if (!target || target.lifecycle !== "active" || target.workspaceId !== scope.workspaceId ||
      target.authority !== "local" || target.visibility !== "member-private" ||
      target.ownerMemberId !== ownerMemberId) {
    throw new Error("Choose an active private project in this workspace.");
  }
  const source = { workspaceId: scope.workspaceId, ...bundle.artifact.context } as Spine.ArtifactsAndRoutines.HandoffContextReference;
  const duplicate = (knownArtifactHandoffs.get(scope.workspaceId)?.values() ?? []) as Iterable<RuntimeArtifactHandoff>;
  if (!hasTauriRuntime() && [...duplicate].some((handoff) =>
    (handoff.status === "proposed" || handoff.status === "accepted") &&
    handoff.artifactVersionIds[0] === input.versionId && handoff.target.projectId === input.targetProjectId
  )) {
    throw new Error("This artifact version has already been added to that project.");
  }
  const commandInput = {
    artifactId: input.artifactId,
    versionId: input.versionId,
    targetProjectId: input.targetProjectId,
    ...(input.note?.trim() ? { note: input.note.trim() } : {})
  };
  let handoff: RuntimeArtifactHandoff;
  if (!hasTauriRuntime()) {
    const now = new Date().toISOString();
    handoff = parseArtifactHandoff({
      id: `artifact-handoff-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      workspaceId: scope.workspaceId,
      authority: "local",
      visibility: "member-private",
      ownerMemberId,
      schemaVersion: 1,
      revision: 1,
      createdByInternalUserId: bundle.artifact.createdByInternalUserId,
      createdAt: now,
      updatedAt: now,
      status: "proposed",
      source,
      target: { workspaceId: scope.workspaceId, projectId: input.targetProjectId },
      artifactVersionIds: [input.versionId],
      includedContext: [],
      authorityTransfer: "none",
      proposedByInternalUserId: bundle.artifact.createdByInternalUserId,
      proposedAt: now,
      ...(commandInput.note ? { note: commandInput.note } : {})
    }, {
      workspaceId: scope.workspaceId,
      ownerMemberId,
      source,
      targetProjectId: input.targetProjectId,
      versionId: input.versionId,
      status: "proposed",
      revision: 1,
      note: commandInput.note
    });
  } else {
    const result = await invoke<unknown>("artifact_handoff_propose", { input: commandInput });
    if (activeDataScope()?.workspaceId !== scope.workspaceId) {
      throw new Error("The active workspace changed while preparing the artifact handoff.");
    }
    handoff = parseArtifactHandoff(result, {
      workspaceId: scope.workspaceId,
      ownerMemberId,
      source,
      targetProjectId: input.targetProjectId,
      versionId: input.versionId,
      status: "proposed",
      note: commandInput.note
    });
  }
  rememberArtifactHandoff(handoff);
  return handoff;
}

export async function acceptRuntimeArtifactHandoff(handoffId: string, expectedRevision: number) {
  const scope = conversationScopeOrThrow();
  const proposed = knownArtifactHandoffs.get(scope.workspaceId)?.get(handoffId);
  if (!proposed || proposed.status !== "proposed" || proposed.revision !== expectedRevision ||
      typeof proposed.ownerMemberId !== "string" || typeof proposed.target.projectId !== "string") {
    throw new Error("This project handoff changed elsewhere. Prepare it again.");
  }
  const ownerMemberId = proposed.ownerMemberId;
  const targetProjectId = proposed.target.projectId;
  let accepted: RuntimeArtifactHandoff;
  if (!hasTauriRuntime()) {
    const now = new Date().toISOString();
    accepted = parseArtifactHandoff({
      ...proposed,
      status: "accepted",
      revision: expectedRevision + 1,
      updatedAt: now,
      resolvedAt: now,
      resolvedByInternalUserId: proposed.proposedByInternalUserId
    }, {
      workspaceId: scope.workspaceId,
      ownerMemberId,
      source: proposed.source,
      targetProjectId,
      versionId: proposed.artifactVersionIds[0],
      status: "accepted",
      revision: expectedRevision + 1,
      note: proposed.note
    });
    let workspace = previewArtifactProjectAssociations.get(scope.workspaceId);
    if (!workspace) {
      workspace = new Map();
      previewArtifactProjectAssociations.set(scope.workspaceId, workspace);
    }
    let artifacts = workspace.get(targetProjectId);
    if (!artifacts) {
      artifacts = new Map();
      workspace.set(targetProjectId, artifacts);
    }
    const bundle = (previewArtifacts.get(scope.workspaceId) ?? [])
      .find((entry) => entry.versions.some((version) => version.id === proposed.artifactVersionIds[0]));
    if (bundle) artifacts.set(bundle.artifact.id, proposed.artifactVersionIds[0]);
  } else {
    const result = await invoke<unknown>("artifact_handoff_accept", { input: { handoffId, expectedRevision } });
    if (activeDataScope()?.workspaceId !== scope.workspaceId) {
      throw new Error("The active workspace changed while accepting the artifact handoff.");
    }
    accepted = parseArtifactHandoff(result, {
      workspaceId: scope.workspaceId,
      ownerMemberId,
      source: proposed.source,
      targetProjectId,
      versionId: proposed.artifactVersionIds[0],
      status: "accepted",
      revision: expectedRevision + 1,
      note: proposed.note
    });
  }
  rememberArtifactHandoff(accepted);
  return accepted;
}

export async function appendRuntimeArtifactVersion(input: {
  artifactId: string;
  expectedRevision: number;
  expectedCurrentVersionId: string;
  title?: string;
  content: string;
}) {
  const scope = conversationScopeOrThrow();
  const content = await inlineArtifactContent(input.content);
  const commandInput = {
    artifactId: input.artifactId,
    expectedRevision: input.expectedRevision,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    ...(input.title === undefined ? {} : { title: input.title }),
    content
  };
  if (!hasTauriRuntime()) {
    const records = previewArtifacts.get(scope.workspaceId) ?? [];
    const index = records.findIndex((entry) => entry.artifact.id === input.artifactId);
    if (index < 0) throw new Error("This artifact is no longer available.");
    const current = records[index];
    if (
      current.artifact.revision !== input.expectedRevision ||
      current.artifact.currentVersionId !== input.expectedCurrentVersionId
    ) {
      throw staleArtifactVersionError();
    }
    if (current.artifact.status === "in-review") {
      throw new Error("Resolve private review before editing.");
    }
    const now = new Date().toISOString();
    const versionId = `artifact-version-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const prior = current.currentVersion;
    const nextVersion = {
      id: versionId as never,
      artifactId: current.artifact.id,
      version: current.versions.length + 1,
      status: "available" as const,
      createdAt: now,
      createdByInternalUserId: "preview-user" as never,
      content,
      media: content.media,
      contentHash: content.contentHash,
      provenance: {
        kind: "artifact-version" as const,
        sourceArtifactVersionId: prior.id,
        observedAt: now
      },
      citations: [...prior.citations],
      lineage: [{
        relation: "supersedes" as const,
        artifactId: current.artifact.id,
        artifactVersionId: prior.id,
        recordedAt: now
      }],
      ...(prior.inputs ? { inputs: [...prior.inputs] } : {}),
      ...(prior.decisions ? { decisions: [...prior.decisions] } : {})
    } satisfies Spine.ArtifactsAndRoutines.ArtifactVersion;
    const updated: RuntimeArtifactBundle = {
      artifact: {
        ...current.artifact,
        ...(input.title === undefined ? {} : { title: input.title }),
        status: "draft",
        currentVersionId: nextVersion.id,
        revision: current.artifact.revision + 1,
        updatedAt: now
      },
      currentVersion: nextVersion,
      versions: [...current.versions, nextVersion],
      sourceMessageId: current.sourceMessageId
    };
    previewArtifacts.set(scope.workspaceId, records.map((entry, recordIndex) => recordIndex === index ? updated : entry));
    return updated;
  }
  try {
    const result = await invoke<unknown>("artifact_append_version", { input: commandInput });
    assertArtifactBundle(result, scope.workspaceId);
    return result;
  } catch (cause) {
    const error = toRuntimeError(cause);
    if (/stale|changed|revision|current version/i.test(error.message)) throw staleArtifactVersionError();
    throw error;
  }
}

export async function reviewRuntimeArtifact(input: {
  artifactId: string;
  versionId: string;
  expectedRevision: number;
  action: Spine.ArtifactsAndRoutines.ArtifactReviewActionInput["action"];
  note?: string;
  requestedChanges?: readonly string[];
}) {
  const scope = conversationScopeOrThrow();
  const commandInput = {
    artifactId: input.artifactId,
    versionId: input.versionId,
    expectedRevision: input.expectedRevision,
    action: input.action,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.requestedChanges === undefined ? {} : { requestedChanges: input.requestedChanges })
  };
  if (!hasTauriRuntime()) {
    const records = previewArtifacts.get(scope.workspaceId) ?? [];
    const index = records.findIndex((entry) => entry.artifact.id === input.artifactId);
    if (index < 0) throw new Error("This artifact is no longer available.");
    const current = records[index];
    if (
      current.artifact.revision !== input.expectedRevision ||
      current.artifact.currentVersionId !== input.versionId
    ) {
      throw staleArtifactVersionError();
    }
    const now = new Date().toISOString();
    let nextStatus = current.artifact.status;
    let reviews = [...current.artifact.reviews];
    if (input.action === "request-review") {
      if (nextStatus !== "draft") {
        throw new Error("This artifact is not ready to request review.");
      }
      nextStatus = "in-review";
      reviews.push({
        id: `artifact-review-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
        status: "requested",
        requestedByInternalUserId: "preview-user" as never,
        versionId: current.currentVersion.id,
        requestedAt: now
      });
    } else if (input.action === "accept" || input.action === "request-changes") {
      if (nextStatus !== "in-review") throw new Error("This artifact is not currently in review.");
      let reviewIndex = -1;
      for (let candidate = reviews.length - 1; candidate >= 0; candidate -= 1) {
        const review = reviews[candidate];
        if (review.versionId === current.currentVersion.id &&
            (review.status === "requested" || review.status === "in-review")) {
          reviewIndex = candidate;
          break;
        }
      }
      if (reviewIndex < 0) throw new Error("This artifact review is no longer available.");
      const review = reviews[reviewIndex];
      if (input.action === "accept") {
        nextStatus = "accepted";
        reviews[reviewIndex] = {
          ...review,
          status: "approved",
          resolvedAt: now,
          acceptance: {
            acceptedByInternalUserId: "preview-user" as never,
            acceptedAt: now,
            ...(input.note ? { note: input.note } : {})
          }
        };
      } else {
        const requestedChanges = (input.requestedChanges ?? []).map((entry) => entry.trim()).filter(Boolean);
        if (requestedChanges.length === 0) throw new Error("Describe the changes needed before confirming.");
        nextStatus = "changes-requested";
        reviews[reviewIndex] = {
          ...review,
          status: "changes-requested",
          resolvedAt: now,
          ...(input.note ? { summary: input.note } : {}),
          requestedChanges
        };
      }
    } else {
      throw new Error("This review action is not available here.");
    }
    const updated: RuntimeArtifactBundle = {
      ...current,
      artifact: {
        ...current.artifact,
        status: nextStatus,
        reviews,
        revision: current.artifact.revision + 1,
        updatedAt: now
      }
    };
    previewArtifacts.set(scope.workspaceId, records.map((entry, recordIndex) => recordIndex === index ? updated : entry));
    return updated;
  }
  try {
    const result = await invoke<unknown>("artifact_review_action", { input: commandInput });
    assertArtifactBundle(result, scope.workspaceId);
    return result;
  } catch (cause) {
    const error = toRuntimeError(cause);
    if (/stale|changed|revision|current version|version mismatch/i.test(error.message)) {
      throw staleArtifactVersionError();
    }
    throw error;
  }
}

export async function saveRuntimeMemoryState(
  state: MemoryControlState,
  scopeOverride?: RuntimeMemoryScopeOverride
) {
  const scope = memoryScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const canonical = canonicalProjectMemoryState(state, scopeOverride);
    previewProjectMemory.set(previewMemoryKey(scopeOverride), canonical);
    return canonical;
  }

  try {
    return await invoke<MemoryControlState>("save_memory_state", {
      state,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(
  _state: MemoryControlState,
  scopeOverride?: RuntimeMemoryScopeOverride
) {
  const scope = memoryScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const canonical = previewProjectMemory.get(previewMemoryKey(scopeOverride))
      ?? { disabled: false, records: [] };
    return JSON.stringify({
      format: "arden.memory.export.v1",
      workspaceId: scope.workspaceId,
      disabled: canonical.disabled,
      disabledRecordsIncluded: false,
      forgottenRecordsIncluded: false,
      records: canonical.records.filter((record) => !record.disabled && !record.forgottenAt)
    }, null, 2);
  }

  try {
    return await invoke<string>("export_memory_state", {
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function promoteRuntimeKnowledgeSourceToMemory(
  request: MemoryPromotionRequest,
  scopeOverride?: RuntimeMemoryScopeOverride
) {
  const scope = memoryScope(scopeOverride);
  if (!scope) return null;
  if (!hasTauriRuntime()) {
    if (!scopeOverride) return null;
    const key = previewKnowledgeKey(scopeOverride);
    const source = (previewProjectKnowledge.get(key) ?? []).find(
      (candidate) => candidate.id === request.source.id
    );
    if (!source) throw new Error("Knowledge source is unavailable in this project.");
    if (source.disabled) throw new Error("Disabled knowledge cannot be promoted to memory.");
    if (source.deletedAt) throw new Error("Deleted knowledge cannot be promoted to memory.");
    if (source.scope && (
      source.scope.level !== "project" || source.scope.projectId !== scopeOverride.projectId
    )) {
      throw new Error("Knowledge source does not belong to this project.");
    }
    if (!["once", "session", "rule"].includes(request.decision)) {
      throw new Error("Memory promotion requires once, session, or rule approval.");
    }
    const stateKey = previewMemoryKey(scopeOverride);
    const current = previewProjectMemory.get(stateKey) ?? { disabled: false, records: [] };
    if (current.disabled) throw new Error("Memory is disabled.");
    const recordId = `memory-from-${source.id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    if (current.records.some((record) => record.id === recordId && record.forgottenAt)) {
      throw new Error("Forgotten memory cannot be restored by promotion.");
    }
    const record = {
      id: recordId,
      kind: "imported" as const,
      title: source.title,
      value: source.contentPreview || `${source.title} from ${source.provenance}. Freshness: ${source.freshness}.`,
      source: `Approved from untrusted source: ${source.provenance}`,
      freshness: "Approved now",
      approved: true,
      pinned: true,
      workspaceId: scopeOverride.workspaceId,
      scope: { level: "project" as const, projectId: scopeOverride.projectId },
      confidence: 1,
      provenance: {
        origin: "source" as const,
        sourceId: source.id,
        note: source.provenance,
        title: source.title,
        connectorId: source.connectorId,
        contentFingerprint: source.contentFingerprint,
        importedAt: source.importedAt,
        trust: source.trust,
        workspaceId: scopeOverride.workspaceId,
        projectId: scopeOverride.projectId
      },
      approvalState: "approved" as const,
      createdAt: request.decidedAt,
      updatedAt: request.decidedAt,
      disabled: false
    };
    const state = canonicalProjectMemoryState({
      disabled: false,
      records: [record, ...current.records.filter((existing) => existing.id !== recordId)]
    }, scopeOverride);
    previewProjectMemory.set(stateKey, state);
    return {
      persisted: true,
      record: state.records[0],
      auditEntry: {
        id: `memory-promotion-${source.id}-${request.decidedAt}`,
        requestId: `memory-promotion-${source.id}`,
        decision: request.decision,
        decidedAt: request.decidedAt,
        note: `Fable Memory Approve ${source.provenance} into durable memory`
      },
      state
    } satisfies MemoryPromotionResponse;
  }

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

export async function switchRuntimeConnectorAccount(connectorId: string, connectionId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("switch_connector_account", {
      connectorId,
      connectionId,
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

export async function searchRuntimeConnector(
  request: ConnectorSearchRequest,
  scopeOverride?: RuntimeKnowledgeScopeOverride,
  connectionId?: string
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  try {
    return await invoke<ConnectorSearchResult>("search_connector", {
      request,
      ...scope,
      connectionId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeConnectorItem(
  request: ConnectorImportRequest,
  scopeOverride?: RuntimeKnowledgeScopeOverride,
  connectionId?: string
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  try {
    return await invoke<ConnectorImportResult>("import_connector_item", {
      request,
      ...scope,
      connectionId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

async function invokeConnectorKnowledge<T>(
  command: string,
  args: Record<string, unknown> = {},
  scopeOverride?: RuntimeKnowledgeScopeOverride
): Promise<T | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = knowledgeScope(scopeOverride);
  if (!scope) return null;
  try {
    return await invoke<T>(command, {
      ...args,
      ...scope
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export function listRuntimeConnectorKnowledgeSources(scopeOverride?: RuntimeKnowledgeScopeOverride) {
  return invokeConnectorKnowledge<KnowledgeSource[]>(
    "list_connector_knowledge_sources",
    {},
    scopeOverride
  );
}

export async function setRuntimeConnectorKnowledgeSourceDisabled(
  sourceId: string,
  disabled: boolean,
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  return invokeConnectorKnowledge<KnowledgeSource>(
    "set_connector_knowledge_source_disabled",
    { sourceId, disabled },
    scopeOverride
  );
}

export function deleteRuntimeConnectorKnowledgeSource(
  sourceId: string,
  scopeOverride?: RuntimeKnowledgeScopeOverride
) {
  return invokeConnectorKnowledge<KnowledgeSource>(
    "delete_connector_knowledge_source",
    { sourceId },
    scopeOverride
  );
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
  providerRoute?: import("@fable/protocol").ProviderRouteExecutionBinding;
  missionWorkerExecution?: import("@fable/protocol").MissionWorkerExecutionBinding;
}

export type RuntimeNativeProviderRoute = Spine.Connections.ProviderRoute & {
  observationSummary?: {
    reference: string;
    sampleCount: number;
    medianLatencyMs: number;
    usageSampleCount: number;
    latestObservedAt: string;
  };
  pricingSummary?: Spine.Missions.ProviderRoutePricingEvidence;
  qualitySummary?: Spine.Missions.ProviderRouteQualitySnapshot;
};

export async function listRuntimeNativeProviderRoutes() {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<RuntimeNativeProviderRoute[]>("list_native_provider_routes"); }
  catch (error) { throw toRuntimeError(error); }
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

export async function startRuntimeCodexBrowserLogin() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeCodexBrowserLoginResult>("start_codex_browser_login");
  } catch (error) {
    throw toRuntimeError(error);
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

// Authenticated mission composition. These wrappers carry only plan content and
// opaque event identities; Rust derives account, workspace, member, actor,
// authority, revisions, timestamps, evaluation, and terminal results.
export interface RuntimeMissionPlanCreateInput {
  missionId: string;
  planId: string;
  planRevisionId: string;
  executionDepth: "delegated" | "multi-worker";
  outcome: unknown;
  missionScope: unknown;
  constraints: unknown;
  timeConstraint?: unknown;
  dataBoundary?: unknown;
  acceptance: unknown;
  budget?: unknown;
  summary: string;
  bounds: unknown;
  steps: unknown;
}

export interface RuntimeMissionRunCreateInput {
  missionId: string;
  runId: string;
  eventId: string;
  idempotencyKey: string;
}

export interface RuntimeMissionRunCancelInput {
  runId: string;
  eventId: string;
  requestKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  mode: "cooperative" | "immediate-if-safe";
  reason?: string;
}

export interface RuntimeMissionRunFinalizeCancellationInput {
  runId: string;
  eventId: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionCheckpointCreateInput {
  runId: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  attemptNumber: number;
  durableThroughSequence: number;
  resumeAfterEventId: string;
}

export interface RuntimeMissionCheckpointRestoreInput {
  runId: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  newAttemptNumber: number;
}

export type RuntimeCitedMissionRestartRecovery =
  | {
      status: "resumable";
      runId: string;
      sourceThreadId: string;
      worker: Spine.Missions.Worker;
      providerId: string;
      modelReference: string;
      workerStartedEventId: string;
      routeSelectedEventId: string;
      checkpointEventId: string;
      checkpointRestoreEventId: string;
      toolEventId: string;
      outputReference: string;
      evidence: unknown;
      restoreIdempotencyKey: string;
      terminalIdempotencyKey: string;
      usageEventId: string;
      completionEventId: string;
      evaluationEventId: string;
      resultEventId: string;
      failureEventId: string;
      expectedRunRevision: number;
      expectedLastSequence: number;
      newAttemptNumber: number;
    }
  | { status: "terminalized"; journal: Record<string, unknown> };

export type RuntimeGeneralMissionRestartRecovery =
  | {
      status: "dormant";
      runId: string;
      planRevisionId: string;
      runStatus: "created" | "planning" | "queued" | "paused";
      action: "continue-from-durable-head" | "remain-paused";
      expectedRunRevision: number;
      expectedLastSequence: number;
    }
  | {
      status: "waiting";
      runId: string;
      planRevisionId: string;
      waitKind: "human-input" | "approval";
      waitKey: string;
      expectedRunRevision: number;
      expectedLastSequence: number;
    }
  | {
      status: "resumable";
      runId: string;
      planRevisionId: string;
      checkpointEventId: string;
      restoreEventId: string;
      restoreIdempotencyKey: string;
      activeWorkerIds: string[];
      activePlanStepKeys: string[];
      completedWorkerIds: string[];
      completedPlanStepKeys: string[];
      committedEffectKeys: string[];
      toolEvidence: Array<{
        workerId: string;
        toolEventId: string;
        outputReference: string;
        evidence: unknown;
      }>;
      expectedRunRevision: number;
      expectedLastSequence: number;
      newAttemptNumber: number;
      requiresFreshRouteSelection: true;
    }
  | { status: "terminalized"; journal: Record<string, unknown> };

export interface RuntimeMissionWorkerCreateInput {
  runId: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  workerId: string;
  stepKey: string;
  context: unknown[];
  grants: Array<{ capabilityId: string; capabilityGrantId: string }>;
}

export interface RuntimeMissionWorkerStartInput {
  runId: string;
  workerId: string;
  runStartEventId?: string;
  workerStartedEventId: string;
  routeSelectedEventId: string;
  providerId: string;
  modelReference: string;
  routeSelection: Spine.Missions.ProviderRouteSelection;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionJoinOpenInput {
  runId: string;
  targetStepKey: string;
  strategy: "all" | "any" | "quorum";
  quorum?: number;
  allowFailedWorkers: boolean;
  deadline?: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionJoinResolveInput {
  runId: string;
  joinKey: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionAggregationRecordInput {
  runId: string;
  targetStepKey: string;
  eventId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionHumanEvaluationInput {
  runId: string;
  criterionKey: string;
  passed: boolean;
  expectedRunRevision: number;
  expectedLastSequence: number;
}

export interface RuntimeMissionProgress {
  version: 1;
  plan?: {
    title: string;
    desiredOutcome: string;
    summary: string;
    maxParallelSteps: number;
  };
  state: "ready" | "running" | "waiting" | "blocked" | "complete" | "cancelled";
  summary: string;
  runStatus: Spine.Missions.RunStatus;
  completedSteps: number;
  totalSteps: number;
  runningWorkers: number;
  readyWorkers: number;
  waitingSteps: number;
  blockedSteps: number;
  steps: Array<{
    stepKey: string;
    title: string;
    objective?: string;
    kind: Spine.Missions.PlanStepKind;
    dependsOnStepKeys?: string[];
    state: "pending" | "ready" | "running" | "waiting" | "completed" | "partial" | "failed" | "blocked" | "cancelled";
    detail: string;
  }>;
  usage: {
    records: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    durationMs: number;
    costObservations: unknown[];
  };
  budget: Spine.Missions.ExecutionBudget;
  acceptance: Array<{
    criterionKey: string;
    description: string;
    required: boolean;
    evaluator: string;
    status: "met" | "partially-met" | "not-met" | "not-evaluated";
    evidenceCount: number;
    summary?: string;
  }>;
  humanReview?: {
    runId: string;
    expectedRunRevision: number;
    expectedLastSequence: number;
    criteria: Array<{
      criterionKey: string;
      description: string;
      required: boolean;
      evaluator: "human";
      status: "not-evaluated";
      evidenceCount: number;
      summary?: string;
    }>;
  } | null;
  nextAction: string;
}

export interface RuntimeThreadMissionProgress {
  runId: string;
  progress: RuntimeMissionProgress;
}

export interface RuntimeThreadMissionProgressList {
  progress: RuntimeThreadMissionProgress[];
  unavailableCount: number;
  truncated: boolean;
}

export async function createRuntimeMissionPlan(input: RuntimeMissionPlanCreateInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_plan_create", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function getRuntimeMissionPlan(missionId: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown> | null>("mission_plan_get", { missionId }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function createRuntimeMissionRun(input: RuntimeMissionRunCreateInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_run_create", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function getRuntimeMissionRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown> | null>("mission_run_get", { runId }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function requestRuntimeMissionRunCancellation(input: RuntimeMissionRunCancelInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_run_request_cancellation", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function getRuntimeCitedMissionPlanSummary(missionId: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_plan_cited_summary_get", { missionId }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function finalizeRuntimeMissionRunCancellation(input: RuntimeMissionRunFinalizeCancellationInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_run_finalize_cancellation", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function recoverRuntimeInterruptedCitedMissions(): Promise<RuntimeCitedMissionRestartRecovery[] | null> {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<RuntimeCitedMissionRestartRecovery[]>("mission_run_recover_interrupted_cited"); }
  catch (error) { throw toRuntimeError(error); }
}

export async function prepareRuntimeCitedMissionRetry(runId: string): Promise<RuntimeCitedMissionRestartRecovery | null> {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<RuntimeCitedMissionRestartRecovery>("mission_run_prepare_cited_retry", { input: { runId } }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function createRuntimeMissionCheckpoint(input: RuntimeMissionCheckpointCreateInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_run_create_checkpoint", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function restoreRuntimeMissionCheckpoint(input: RuntimeMissionCheckpointRestoreInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<{ journal: Record<string, unknown>; checkpoint: Record<string, unknown> }>("mission_run_restore_checkpoint", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function createRuntimeMissionWorker(input: RuntimeMissionWorkerCreateInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_worker_create", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function startRuntimeMissionWorker(input: RuntimeMissionWorkerStartInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_worker_start", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function recoverRuntimeInterruptedGeneralMissions(): Promise<RuntimeGeneralMissionRestartRecovery[] | null> {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<RuntimeGeneralMissionRestartRecovery[]>("mission_run_recover_interrupted_general"); }
  catch (error) { throw toRuntimeError(error); }
}

export async function openRuntimeMissionJoin(input: RuntimeMissionJoinOpenInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_coordination_join_open", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function resolveRuntimeMissionJoin(input: RuntimeMissionJoinResolveInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_coordination_join_resolve", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function recordRuntimeMissionAggregation(input: RuntimeMissionAggregationRecordInput) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown>>("mission_coordination_aggregation_record", { input }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function readRuntimeMissionProgress(runId: string): Promise<RuntimeMissionProgress | null> {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<RuntimeMissionProgress>("mission_coordination_progress_read", { runId }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function listRuntimeThreadMissionProgress(
  sourceThreadId: string,
  limit?: number
): Promise<RuntimeThreadMissionProgressList> {
  if (!hasTauriRuntime()) {
    return { progress: [], unavailableCount: 0, truncated: false };
  }
  try {
    return await invoke<RuntimeThreadMissionProgressList>(
      "mission_coordination_progress_list",
      { input: { sourceThreadId, ...(limit === undefined ? {} : { limit }) } }
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function recordRuntimeMissionHumanEvaluation(
  input: RuntimeMissionHumanEvaluationInput,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<Record<string, unknown>>(
      "mission_coordination_human_evaluation_record",
      { input },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeMissionWorkers(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<Record<string, unknown>>("mission_coordination_prepare_workers", { runId });
  } catch (error) { throw toRuntimeError(error); }
}

export async function getRuntimeMissionWorkerObjective(runId: string, workerId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<string>("mission_coordination_worker_objective", {
      input: { runId, workerId }
    });
  } catch (error) { throw toRuntimeError(error); }
}

export async function advanceRuntimeMissionCoordination(runId: string): Promise<{
  journal: Record<string, unknown>;
  progress: RuntimeMissionProgress;
  appendedEventIds: string[];
} | null> {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      journal: Record<string, unknown>;
      progress: RuntimeMissionProgress;
      appendedEventIds: string[];
    }>("mission_coordination_advance", { runId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function finalizeRuntimeMissionCoordination(runId: string): Promise<{
  journal: Record<string, unknown>;
  missionResult: Record<string, unknown>;
  progress: RuntimeMissionProgress;
  terminalEventId: string;
} | null> {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      journal: Record<string, unknown>;
      missionResult: Record<string, unknown>;
      progress: RuntimeMissionProgress;
      terminalEventId: string;
    }>("mission_coordination_finalize", { runId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export interface RuntimeParallelApproachesResult {
  missionId: string;
  runId: string;
  outcome: "completed" | "partial" | "failed" | "cancelled";
  text: string;
  artifactId?: string;
  artifactVersionId?: string;
  journal: Record<string, unknown>;
}

export interface RuntimeParallelReviewerPreparation {
  missionId: string;
  runId: string;
  workerId: string;
  providerId: string;
  modelReference: string;
  prompt: string;
  maxOutputTokens: number;
  alreadyCompleted: boolean;
  execution: import("@fable/protocol").MissionWorkerExecutionBinding;
  journal: Record<string, unknown>;
}

function parseRuntimeParallelJournal(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.run) || !Array.isArray(value.events)) {
    throw new Error("Malformed parallel mission journal response.");
  }
  return value;
}

function parseRuntimeParallelApproachesResult(value: unknown): RuntimeParallelApproachesResult {
  const allowed = new Set([
    "missionId", "runId", "outcome", "text", "artifactId", "artifactVersionId", "journal"
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.missionId !== "string" || !value.missionId || value.missionId.length > 200
    || typeof value.runId !== "string" || !value.runId || value.runId.length > 200
    || !["completed", "partial", "failed", "cancelled"].includes(String(value.outcome))
    || typeof value.text !== "string" || value.text.length > 131_072
    || (value.artifactId !== undefined && value.artifactId !== null
      && (typeof value.artifactId !== "string" || !value.artifactId || value.artifactId.length > 200))
    || (value.artifactVersionId !== undefined && value.artifactVersionId !== null
      && (typeof value.artifactVersionId !== "string" || !value.artifactVersionId || value.artifactVersionId.length > 200))) {
    throw new Error("Malformed parallel mission result response.");
  }
  const completed = value.outcome === "completed";
  const artifactId = typeof value.artifactId === "string" ? value.artifactId : undefined;
  const artifactVersionId = typeof value.artifactVersionId === "string" ? value.artifactVersionId : undefined;
  if (completed !== Boolean(artifactId && artifactVersionId)) {
    throw new Error("Malformed parallel mission result response.");
  }
  return {
    missionId: value.missionId,
    runId: value.runId,
    outcome: value.outcome as RuntimeParallelApproachesResult["outcome"],
    text: value.text,
    ...(artifactId ? { artifactId } : {}),
    ...(artifactVersionId ? { artifactVersionId } : {}),
    journal: parseRuntimeParallelJournal(value.journal)
  };
}

function parseRuntimeParallelReviewerPreparation(value: unknown): RuntimeParallelReviewerPreparation {
  const allowed = new Set([
    "missionId", "runId", "workerId", "providerId", "modelReference", "prompt",
    "maxOutputTokens", "alreadyCompleted", "execution", "journal"
  ]);
  const executionKeys = new Set([
    "runId", "workerId", "workerStartedEventId", "routeSelectedEventId", "usageEventId",
    "completionEventId", "evaluationEventId", "resultEventId", "failureEventId",
    "idempotencyKey", "expectedRunRevision", "expectedLastSequence"
  ]);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.missionId !== "string" || !value.missionId || value.missionId.length > 200
    || typeof value.runId !== "string" || !value.runId || value.runId.length > 200
    || typeof value.workerId !== "string" || !value.workerId || value.workerId.length > 200
    || typeof value.providerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.providerId)
    || typeof value.modelReference !== "string" || !value.modelReference || value.modelReference.length > 200
    || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 131_072
    || value.maxOutputTokens !== 2_048 || typeof value.alreadyCompleted !== "boolean") {
    throw new Error("Malformed parallel reviewer preparation response.");
  }
  const execution = value.execution;
  if (!isRecord(execution)
    || Object.keys(execution).some((key) => !executionKeys.has(key))
    || !["runId", "workerId", "workerStartedEventId", "routeSelectedEventId", "usageEventId",
      "completionEventId", "evaluationEventId", "resultEventId", "failureEventId", "idempotencyKey"]
      .every((key) => typeof execution[key] === "string" && Boolean((execution[key] as string).trim())
        && (execution[key] as string).length <= 200)
    || execution.runId !== value.runId || execution.workerId !== value.workerId
    || !Number.isInteger(execution.expectedRunRevision) || (execution.expectedRunRevision as number) < 1
    || !Number.isInteger(execution.expectedLastSequence) || (execution.expectedLastSequence as number) < 1) {
    throw new Error("Malformed parallel reviewer preparation response.");
  }
  return {
    missionId: value.missionId,
    runId: value.runId,
    workerId: value.workerId,
    providerId: value.providerId,
    modelReference: value.modelReference,
    prompt: value.prompt,
    maxOutputTokens: value.maxOutputTokens,
    alreadyCompleted: value.alreadyCompleted,
    execution: execution as unknown as import("@fable/protocol").MissionWorkerExecutionBinding,
    journal: parseRuntimeParallelJournal(value.journal)
  };
}

export async function openRuntimeParallelApproachesJoin(input: {
  runId: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return parseRuntimeParallelJournal(
      await invoke<unknown>("mission_parallel_approaches_join_open", { input })
    );
  } catch (error) { throw toRuntimeError(error); }
}

export async function prepareRuntimeParallelApproachesReviewer(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return parseRuntimeParallelReviewerPreparation(
      await invoke<unknown>("mission_parallel_approaches_reviewer_prepare", { input: { runId } })
    );
  } catch (error) { throw toRuntimeError(error); }
}

export async function recoverRuntimeParallelApproachesReviewers() {
  if (!hasTauriRuntime()) return null;
  try {
    const value = await invoke<unknown>("mission_parallel_approaches_reviewer_recover");
    if (!Array.isArray(value) || value.length > 50) {
      throw new Error("Malformed parallel reviewer recovery response.");
    }
    return value.map(parseRuntimeParallelReviewerPreparation);
  } catch (error) { throw toRuntimeError(error); }
}

export async function finalizeRuntimeParallelApproaches(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return parseRuntimeParallelApproachesResult(
      await invoke<unknown>("mission_parallel_approaches_finalize", { runId })
    );
  } catch (error) { throw toRuntimeError(error); }
}

export async function recoverRuntimeCompletedParallelApproaches() {
  if (!hasTauriRuntime()) return null;
  try {
    const value = await invoke<unknown>("mission_parallel_approaches_recover_completed");
    if (!Array.isArray(value) || value.length > 50) {
      throw new Error("Malformed parallel mission recovery response.");
    }
    return value.map(parseRuntimeParallelApproachesResult);
  } catch (error) { throw toRuntimeError(error); }
}

export async function readRuntimeMissionWorkerOutput(valueReference: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<Record<string, unknown> | null>("mission_worker_output_read", { valueReference }); }
  catch (error) { throw toRuntimeError(error); }
}

export type RuntimeCitedMissionReceiptProjection =
  | { messageId: string; status: "available"; receipt: Record<string, unknown> }
  | { messageId: string; status: "unavailable" };

export async function readRuntimeCitedMissionReceipts(threadId: string, messageIds: string[]) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeCitedMissionReceiptProjection[]>("mission_worker_cited_receipts_read", {
      input: { threadId, messageIds }
    });
  } catch (error) { throw toRuntimeError(error); }
}

export type RuntimeCitedMissionPlanSummaryProjection =
  | { messageId: string; status: "available"; plan: Record<string, unknown> }
  | { messageId: string; status: "unavailable" };

export async function readRuntimeCitedMissionPlanSummaries(threadId: string, messageIds: string[]) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeCitedMissionPlanSummaryProjection[]>("mission_plan_cited_summaries_read", {
      input: { threadId, messageIds }
    });
  } catch (error) { throw toRuntimeError(error); }
}

export interface RuntimeMissionApprovalEffect {
  effectKey: string;
  idempotencyKey: string;
  targetSummary: string;
}

export interface RuntimeMissionApprovalRequestInput {
  runId: string;
  workerId?: string;
  requestKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  actionSummary: string;
  proposalHash: string;
  effect: RuntimeMissionApprovalEffect;
}

export interface RuntimeMissionApproval {
  runId: string;
  missionId: string;
  sourceThreadId: string;
  planRevisionId: string;
  workerId?: string;
  waitKey: string;
  requestKey: string;
  actionSummary: string;
  proposalHash: string;
  effect: RuntimeMissionApprovalEffect;
  requestedAt: string;
  runRevision: number;
  lastSequence: number;
}

export interface RuntimeMissionApprovalList {
  approvals: RuntimeMissionApproval[];
  unavailableCount: number;
  truncated: boolean;
}

export function latestRuntimeMissionApproval(
  approvals: readonly RuntimeMissionApproval[]
): RuntimeMissionApproval | undefined {
  return approvals.reduce<RuntimeMissionApproval | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const byRequestedAt = candidate.requestedAt.localeCompare(latest.requestedAt);
    return byRequestedAt > 0
      || (byRequestedAt === 0 && candidate.runId.localeCompare(latest.runId) > 0)
      ? candidate
      : latest;
  }, undefined);
}

function isRuntimeMissionApprovalEffect(value: unknown): value is RuntimeMissionApprovalEffect {
  return isRecord(value)
    && Object.keys(value).length === 3
    && ["effectKey", "idempotencyKey", "targetSummary"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).trim().length > 0
    );
}

function isRuntimeMissionApproval(value: unknown): value is RuntimeMissionApproval {
  if (!isRecord(value)) return false;
  const required = [
    "runId", "missionId", "sourceThreadId", "planRevisionId", "waitKey", "requestKey",
    "actionSummary", "proposalHash", "effect", "requestedAt",
    "runRevision", "lastSequence"
  ];
  const allowed = [...required, "workerId"];
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.includes(key))
    && [
      "runId", "missionId", "sourceThreadId", "planRevisionId", "waitKey", "requestKey",
      "actionSummary", "requestedAt"
    ].every((key) => typeof value[key] === "string" && (value[key] as string).trim().length > 0)
    && /^mission-approval-wait:v1:[0-9a-f]{64}$/i.test(String(value.waitKey))
    && /^[0-9a-f]{64}$/i.test(String(value.proposalHash))
    && (value.workerId === undefined
      || (typeof value.workerId === "string" && value.workerId.trim().length > 0))
    && isRuntimeMissionApprovalEffect(value.effect)
    && Number.isInteger(value.runRevision) && (value.runRevision as number) > 0
    && Number.isInteger(value.lastSequence) && (value.lastSequence as number) > 0;
}

export async function requestRuntimeMissionApproval(
  input: RuntimeMissionApprovalRequestInput
): Promise<RuntimeMissionApproval | null> {
  if (!hasTauriRuntime()) return null;
  try {
    const result = await invoke<unknown>("mission_approval_request", { input });
    if (!isRuntimeMissionApproval(result)) {
      throw new Error("Malformed Mission approval response.");
    }
    return result;
  } catch (error) { throw toRuntimeError(error); }
}

export async function listRuntimePendingMissionApprovals(
  sourceThreadId: string,
  limit = 50
): Promise<RuntimeMissionApprovalList> {
  if (!hasTauriRuntime()) return { approvals: [], unavailableCount: 0, truncated: false };
  try {
    const result = await invoke<unknown>("mission_approval_pending_list", {
      input: { sourceThreadId, limit }
    });
    if (!isRecord(result)
      || Object.keys(result).length !== 3
      || !Array.isArray(result.approvals)
      || !result.approvals.every(isRuntimeMissionApproval)
      || !Number.isInteger(result.unavailableCount)
      || (result.unavailableCount as number) < 0
      || typeof result.truncated !== "boolean") {
      throw new Error("Malformed Mission approval list.");
    }
    return result as unknown as RuntimeMissionApprovalList;
  } catch (error) { throw toRuntimeError(error); }
}

export async function resolveRuntimeMissionApproval(
  approval: RuntimeMissionApproval,
  decision: "approved" | "denied"
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<{
      runId: string;
      waitKey: string;
      decision: "approved" | "denied";
      proposalHash: string;
      effect: RuntimeMissionApprovalEffect;
      decidedAt: string;
      runRevision: number;
      lastSequence: number;
    }>("mission_approval_resolve", {
      input: {
        runId: approval.runId,
        waitKey: approval.waitKey,
        decision,
        expectedRunRevision: approval.runRevision,
        expectedLastSequence: approval.lastSequence
      }
    });
  } catch (error) { throw toRuntimeError(error); }
}

export async function cancelRuntimeMissionApproval(approval: RuntimeMissionApproval) {
  const waitIdentity = /^mission-approval-wait:v1:([0-9a-f]{64})$/i.exec(approval.waitKey);
  if (!waitIdentity) throw new Error("The Mission approval identity is invalid.");
  const identity = waitIdentity[1].toLowerCase();
  const requested = await requestRuntimeMissionRunCancellation({
    runId: approval.runId,
    eventId: `mission-approval-cancel-requested-${identity}`,
    requestKey: `mission-approval-stop:v1:${identity}`,
    expectedRunRevision: approval.runRevision,
    expectedLastSequence: approval.lastSequence,
    mode: "cooperative",
    reason: "User requested stop while a Mission action approval was pending."
  });
  if (!requested || !isRecord(requested.run) || !isRecord(requested.run.eventHead)
    || !Number.isInteger(requested.run.revision)
    || !Number.isInteger(requested.run.eventHead.lastSequence)) {
    throw new Error("The Mission approval cancellation did not reach a durable request.");
  }
  if (requested.run.status === "cancelled") return requested;
  return finalizeRuntimeMissionRunCancellation({
    runId: approval.runId,
    eventId: `mission-approval-cancelled-${identity}`,
    expectedRunRevision: requested.run.revision as number,
    expectedLastSequence: requested.run.eventHead.lastSequence as number
  });
}

export interface RuntimeCitedApproval {
  runId: string;
  missionId: string;
  waitKey: string;
  requestedAt: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  valueReference: string;
  draft: string;
  plan: Record<string, unknown>;
}

export interface RuntimeCitedApprovalList {
  approvals: RuntimeCitedApproval[];
  unavailableCount: number;
  truncated: boolean;
}

export function latestRuntimeCitedApproval(
  approvals: readonly RuntimeCitedApproval[]
): RuntimeCitedApproval | undefined {
  return approvals.reduce<RuntimeCitedApproval | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const byRequestedAt = candidate.requestedAt.localeCompare(latest.requestedAt);
    return byRequestedAt > 0 || (byRequestedAt === 0 && candidate.runId.localeCompare(latest.runId) > 0)
      ? candidate
      : latest;
  }, undefined);
}

function isRuntimeCitedApproval(value: unknown): value is RuntimeCitedApproval {
  if (!isRecord(value)) return false;
  const keys = ["runId", "missionId", "waitKey", "requestedAt", "expectedRunRevision", "expectedLastSequence", "valueReference", "draft", "plan"];
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
    && ["runId", "missionId", "waitKey", "requestedAt", "valueReference", "draft"]
      .every((key) => typeof value[key] === "string" && (value[key] as string).trim().length > 0)
    && Number.isInteger(value.expectedRunRevision) && (value.expectedRunRevision as number) > 0
    && Number.isInteger(value.expectedLastSequence) && (value.expectedLastSequence as number) > 0
    && isRecord(value.plan);
}

export async function listRuntimePendingCitedApprovals(threadId: string): Promise<RuntimeCitedApprovalList> {
  if (!hasTauriRuntime()) return { approvals: [], unavailableCount: 0, truncated: false };
  try {
    const result = await invoke<unknown>("mission_cited_approval_pending_list", { threadId });
    if (!isRecord(result)
      || Object.keys(result).length !== 3
      || !Array.isArray(result.approvals)
      || !result.approvals.every(isRuntimeCitedApproval)
      || !Number.isInteger(result.unavailableCount)
      || (result.unavailableCount as number) < 0
      || typeof result.truncated !== "boolean") {
      throw new Error("Malformed cited approval projection.");
    }
    return result as unknown as RuntimeCitedApprovalList;
  } catch (error) { throw toRuntimeError(error); }
}

export async function resolveRuntimeCitedApproval(
  approval: RuntimeCitedApproval,
  decision: "approved" | "denied"
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<Record<string, unknown>>("mission_cited_approval_resolve", {
      input: {
        runId: approval.runId,
        decision,
        expectedRunRevision: approval.expectedRunRevision,
        expectedLastSequence: approval.expectedLastSequence
      }
    });
  } catch (error) { throw toRuntimeError(error); }
}

export async function cancelRuntimeCitedApproval(approval: RuntimeCitedApproval) {
  const id = (prefix: string) => `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const requested = await requestRuntimeMissionRunCancellation({
    runId: approval.runId,
    eventId: id("event"),
    requestKey: id("stop"),
    expectedRunRevision: approval.expectedRunRevision,
    expectedLastSequence: approval.expectedLastSequence,
    mode: "cooperative",
    reason: "User requested stop while cited artifact acceptance was pending."
  });
  if (!requested || !isRecord(requested.run) || !isRecord(requested.run.eventHead)
    || !Number.isInteger(requested.run.revision)
    || !Number.isInteger(requested.run.eventHead.lastSequence)) {
    throw new Error("The cited approval cancellation did not reach a durable request.");
  }
  return finalizeRuntimeMissionRunCancellation({
    runId: approval.runId,
    eventId: id("event"),
    expectedRunRevision: requested.run.revision as number,
    expectedLastSequence: requested.run.eventHead.lastSequence as number
  });
}

export type RuntimeMissionHumanInputFieldKind = "text" | "number" | "boolean" | "choice" | "date-time" | "artifact";

export interface RuntimeMissionHumanInputField {
  key: string;
  label: string;
  help?: string;
  kind: RuntimeMissionHumanInputFieldKind;
  required: boolean;
  sensitive: false;
  choices?: string[];
}

export interface RuntimeMissionHumanInputRequest {
  runId: string;
  missionId: string;
  sourceThreadId: string;
  projectId?: string;
  waitKey: string;
  requestKey: string;
  prompt: string;
  fields: RuntimeMissionHumanInputField[];
  requestedAt: string;
  runRevision: number;
  lastSequence: number;
}

export function latestRuntimeMissionHumanInput(
  requests: readonly RuntimeMissionHumanInputRequest[]
): RuntimeMissionHumanInputRequest | undefined {
  return requests.reduce<RuntimeMissionHumanInputRequest | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const byRequestedAt = candidate.requestedAt.localeCompare(latest.requestedAt);
    return byRequestedAt > 0 || (byRequestedAt === 0 && candidate.runId.localeCompare(latest.runId) > 0)
      ? candidate
      : latest;
  }, undefined);
}

export type RuntimePendingMissionWait =
  | { kind: "approval"; request: RuntimeCitedApproval }
  | { kind: "effect-approval"; request: RuntimeMissionApproval }
  | { kind: "human-input"; request: RuntimeMissionHumanInputRequest };

export function latestRuntimePendingMissionWait(
  approvals: RuntimeCitedApprovalList,
  inputs: RuntimeMissionHumanInputList,
  effectApprovals: RuntimeMissionApprovalList = {
    approvals: [],
    unavailableCount: 0,
    truncated: false
  }
): RuntimePendingMissionWait | undefined {
  if (approvals.unavailableCount > 0 || approvals.truncated
    || inputs.unavailableCount > 0 || inputs.truncated
    || effectApprovals.unavailableCount > 0 || effectApprovals.truncated) return undefined;
  const candidates: Array<{ key: string; wait: RuntimePendingMissionWait }> = [];
  const approval = latestRuntimeCitedApproval(approvals.approvals);
  if (approval) candidates.push({
    key: `${approval.requestedAt}\0${approval.runId}\0approval`,
    wait: { kind: "approval", request: approval }
  });
  const input = latestRuntimeMissionHumanInput(inputs.requests);
  if (input) candidates.push({
    key: `${input.requestedAt}\0${input.runId}\0human-input`,
    wait: { kind: "human-input", request: input }
  });
  const effectApproval = latestRuntimeMissionApproval(effectApprovals.approvals);
  if (effectApproval) candidates.push({
    key: `${effectApproval.requestedAt}\0${effectApproval.runId}\0effect-approval`,
    wait: { kind: "effect-approval", request: effectApproval }
  });
  return candidates.reduce<{ key: string; wait: RuntimePendingMissionWait } | undefined>(
    (latest, candidate) => !latest || candidate.key > latest.key ? candidate : latest,
    undefined
  )?.wait;
}

export function verifiedLatestRuntimePendingMissionWait(
  approvals: PromiseSettledResult<RuntimeCitedApprovalList>,
  inputs: PromiseSettledResult<RuntimeMissionHumanInputList>,
  effectApprovals: PromiseSettledResult<RuntimeMissionApprovalList> = {
    status: "fulfilled",
    value: { approvals: [], unavailableCount: 0, truncated: false }
  }
): RuntimePendingMissionWait | undefined {
  if (approvals.status === "rejected" || inputs.status === "rejected"
    || effectApprovals.status === "rejected"
    || approvals.value.unavailableCount > 0 || approvals.value.truncated
    || inputs.value.unavailableCount > 0 || inputs.value.truncated) {
    throw new Error("Fable could not verify every pending mission wait, so nothing was stopped.");
  }
  if (effectApprovals.value.unavailableCount > 0 || effectApprovals.value.truncated) {
    throw new Error("Fable could not verify every pending mission wait, so nothing was stopped.");
  }
  return latestRuntimePendingMissionWait(
    approvals.value,
    inputs.value,
    effectApprovals.value
  );
}

export interface RuntimeMissionHumanInputList {
  requests: RuntimeMissionHumanInputRequest[];
  unavailableCount: number;
  truncated: boolean;
}

export interface RuntimeMissionHumanInputValue {
  fieldKey: string;
  value: string | number | boolean | RuntimeMissionHumanInputArtifactReference | null;
}

export interface RuntimeMissionHumanInputArtifactReference {
  artifactId: string;
  artifactVersionId: string;
}

function isRuntimeMissionHumanInputField(value: unknown): value is RuntimeMissionHumanInputField {
  if (!isRecord(value)) return false;
  const requiredKeys = ["key", "label", "kind", "required", "sensitive"];
  const allowedKeys = [...requiredKeys, "help", "choices"];
  const kind = value.kind;
  const choices = value.choices;
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.includes(key))
    && typeof value.key === "string" && value.key.length > 0
    && typeof value.label === "string" && value.label.length > 0
    && (value.help === undefined || (typeof value.help === "string" && value.help.length > 0))
    && ["text", "number", "boolean", "choice", "date-time", "artifact"].includes(String(kind))
    && typeof value.required === "boolean"
    && value.sensitive === false
    && (kind === "choice"
      ? Array.isArray(choices) && choices.length >= 2 && choices.every((choice) => typeof choice === "string" && choice.length > 0)
      : choices === undefined);
}

function isRuntimeMissionHumanInputRequest(value: unknown): value is RuntimeMissionHumanInputRequest {
  if (!isRecord(value)) return false;
  const requiredKeys = ["runId", "missionId", "sourceThreadId", "waitKey", "requestKey", "prompt", "fields", "requestedAt", "runRevision", "lastSequence"];
  const allowedKeys = [...requiredKeys, "projectId"];
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowedKeys.includes(key))
    && ["runId", "missionId", "sourceThreadId", "waitKey", "requestKey", "prompt", "requestedAt"]
      .every((key) => typeof value[key] === "string" && (value[key] as string).trim().length > 0)
    && (value.projectId === undefined || (typeof value.projectId === "string" && value.projectId.trim().length > 0))
    && Array.isArray(value.fields) && value.fields.length >= 1 && value.fields.length <= 8
    && value.fields.every(isRuntimeMissionHumanInputField)
    && new Set(value.fields.map((field) => field.key)).size === value.fields.length
    && Number.isInteger(value.runRevision) && (value.runRevision as number) > 0
    && Number.isInteger(value.lastSequence) && (value.lastSequence as number) > 0;
}

export async function startRuntimeStructuredIntake(input: {
  sourceThreadId: string;
  projectId?: string;
  subject: string;
  startKey: string;
}): Promise<RuntimeMissionHumanInputRequest | null> {
  if (!hasTauriRuntime()) return null;
  try {
    const result = await invoke<unknown>("mission_structured_intake_start", { input });
    if (!isRuntimeMissionHumanInputRequest(result)) {
      throw new Error("Malformed structured-intake wait projection.");
    }
    return result;
  } catch (error) { throw toRuntimeError(error); }
}

export async function startRuntimeArtifactRevisionBrief(input: {
  sourceThreadId: string;
  projectId?: string;
  focus?: string;
  startKey: string;
}): Promise<RuntimeMissionHumanInputRequest | null> {
  if (!hasTauriRuntime()) return null;
  try {
    const result = await invoke<unknown>("mission_artifact_revision_brief_start", { input });
    if (!isRuntimeMissionHumanInputRequest(result)) {
      throw new Error("Malformed artifact revision-brief wait projection.");
    }
    return result;
  } catch (error) { throw toRuntimeError(error); }
}

export async function requestRuntimeMissionHumanInput(input: {
  runId: string;
  requestKey: string;
  expectedRunRevision: number;
  expectedLastSequence: number;
  prompt: string;
  fields: RuntimeMissionHumanInputField[];
}): Promise<RuntimeMissionHumanInputRequest | null> {
  if (!hasTauriRuntime()) return null;
  try {
    const result = await invoke<unknown>("mission_human_input_request", { input });
    if (!isRuntimeMissionHumanInputRequest(result)) throw new Error("Malformed human-input wait projection.");
    return result;
  } catch (error) { throw toRuntimeError(error); }
}

export async function listRuntimePendingMissionHumanInputs(
  sourceThreadId: string,
  limit?: number
): Promise<RuntimeMissionHumanInputList> {
  if (!hasTauriRuntime()) return { requests: [], unavailableCount: 0, truncated: false };
  try {
    const result = await invoke<unknown>("mission_human_input_pending_list", {
      input: { sourceThreadId, ...(limit === undefined ? {} : { limit }) }
    });
    if (!isRecord(result)
      || Object.keys(result).length !== 3
      || !Array.isArray(result.requests)
      || !result.requests.every(isRuntimeMissionHumanInputRequest)
      || !Number.isInteger(result.unavailableCount)
      || (result.unavailableCount as number) < 0
      || typeof result.truncated !== "boolean") {
      throw new Error("Malformed human-input wait list.");
    }
    return result as unknown as RuntimeMissionHumanInputList;
  } catch (error) { throw toRuntimeError(error); }
}

export async function receiveRuntimeMissionHumanInput(
  request: RuntimeMissionHumanInputRequest,
  values: RuntimeMissionHumanInputValue[]
) {
  if (!hasTauriRuntime()) return null;
  if (!validRuntimeMissionHumanInputSubmission(request, values)) {
    throw new Error("Mission human-input values do not match the requested fields.");
  }
  try {
    const result = await invoke<unknown>("mission_human_input_receive", {
      input: {
        runId: request.runId,
        waitKey: request.waitKey,
        expectedRunRevision: request.runRevision,
        expectedLastSequence: request.lastSequence,
        values
      }
    });
    if (!isRecord(result)
      || Object.keys(result).length !== 6
      || result.runId !== request.runId
      || result.waitKey !== request.waitKey
      || result.status !== "received"
      || typeof result.receivedAt !== "string"
      || !Number.isInteger(result.runRevision)
      || !Number.isInteger(result.lastSequence)) {
      throw new Error("Malformed human-input receipt.");
    }
    return result;
  } catch (error) { throw toRuntimeError(error); }
}

function validRuntimeMissionHumanInputSubmission(
  request: RuntimeMissionHumanInputRequest,
  values: RuntimeMissionHumanInputValue[]
): boolean {
  if (values.length > request.fields.length) return false;
  const fields = new Map(request.fields.map((field) => [field.key, field] as const));
  const supplied = new Set<string>();
  for (const input of values) {
    if (!isRecord(input) || Object.keys(input).length !== 2
      || typeof input.fieldKey !== "string" || supplied.has(input.fieldKey)) return false;
    const field = fields.get(input.fieldKey);
    if (!field) return false;
    supplied.add(input.fieldKey);
    const value = input.value;
    if (value === null) {
      if (field.required) return false;
      continue;
    }
    if (field.kind === "text" && !(typeof value === "string" && value.length <= 4_000 && (!field.required || value.trim()))) return false;
    if (field.kind === "number" && !(typeof value === "number" && Number.isFinite(value))) return false;
    if (field.kind === "boolean" && typeof value !== "boolean") return false;
    if (field.kind === "choice" && !(typeof value === "string" && field.choices?.includes(value))) return false;
    if (field.kind === "date-time" && !(typeof value === "string" && Number.isFinite(Date.parse(value)))) return false;
    if (field.kind === "artifact" && !(isRecord(value)
      && Object.keys(value).length === 2
      && typeof value.artifactId === "string" && value.artifactId.trim().length > 0 && value.artifactId.length <= 200
      && typeof value.artifactVersionId === "string" && value.artifactVersionId.trim().length > 0 && value.artifactVersionId.length <= 200)) return false;
  }
  return request.fields.every((field) => !field.required || supplied.has(field.key));
}

export async function cancelRuntimeMissionHumanInput(request: RuntimeMissionHumanInputRequest) {
  const identity = request.waitKey.replace(/^human-input-wait:v1:/, "");
  const requested = await requestRuntimeMissionRunCancellation({
    runId: request.runId,
    eventId: `mission-human-input-cancel-requested-${identity}`,
    requestKey: `human-input-stop:v1:${identity}`,
    expectedRunRevision: request.runRevision,
    expectedLastSequence: request.lastSequence,
    mode: "cooperative",
    reason: "User requested stop while mission input was pending."
  });
  if (!requested || !isRecord(requested.run) || !isRecord(requested.run.eventHead)
    || !Number.isInteger(requested.run.revision)
    || !Number.isInteger(requested.run.eventHead.lastSequence)) {
    throw new Error("The human-input cancellation did not reach a durable request.");
  }
  if (requested.run.status === "cancelled") return requested;
  return finalizeRuntimeMissionRunCancellation({
    runId: request.runId,
    eventId: `mission-human-input-cancelled-${identity}`,
    expectedRunRevision: requested.run.revision as number,
    expectedLastSequence: requested.run.eventHead.lastSequence as number
  });
}

// ---------------------------------------------------------------------------
// MCP local STDIO process bridge. Rust resolves an opaque encrypted launch
// reference, owns the child and validates every frame; TypeScript sees only
// protocol messages and secret-free session metadata.
// ---------------------------------------------------------------------------

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
  capabilityId: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeResolvedMcpCapabilityRoute | null>("resolve_mcp_capability_route", {
    request: { workspaceId, capabilityId }
  }).catch((error) => { throw toRuntimeError(error); });
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
  projectId?: string;
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
  scopeKind: "workspace" | "project";
  workspaceId: string;
  projectId?: string;
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

export async function prepareRuntimeCapabilityGrant(proposal: RuntimeCapabilityGrantProposal) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedCapabilityGrant>("prepare_capability_grant", { proposal })
    .catch((error) => { throw toRuntimeError(error); });
}

export async function commitRuntimeCapabilityGrant(
  proposal: RuntimeCapabilityGrantProposal,
  resolution: ApprovalResolutionRequest
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeCapabilityGrant>("commit_capability_grant", {
    request: { proposal, resolution }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function listRuntimeCapabilityGrants(workspaceId: string, projectId?: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeCapabilityGrant[]>("list_capability_grants", {
    request: { workspaceId, projectId }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function revokeRuntimeCapabilityGrant(
  workspaceId: string,
  grantId: string,
  expectedRevision: number,
  projectId?: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeCapabilityGrant>("revoke_capability_grant", {
    request: { workspaceId, projectId, grantId, expectedRevision }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function prepareRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedMcpServerConfiguration>("prepare_mcp_server_configuration", {
    configuration
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function commitRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration,
  resolution: ApprovalResolutionRequest
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary>("commit_mcp_server_configuration", {
    request: { configuration, resolution }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function listRuntimeMcpServerConfigurations(workspaceId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary[]>("list_mcp_server_configurations", { workspaceId })
    .catch((error) => { throw toRuntimeError(error); });
}

export async function spawnRuntimeMcpProcess(workspaceId: string, launchReference: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeSpawnedMcpProcess>("spawn_mcp_process", {
      request: { workspaceId, launchReference }
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
  configurationReference: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationSummary>("inspect_remote_mcp_authorization", {
    request: { workspaceId, configurationReference }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function beginRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationResult>("begin_remote_mcp_authorization", {
    request: { workspaceId, configurationReference }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function disconnectRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<{ status: "disconnected"; message: string }>(
    "disconnect_remote_mcp_authorization",
    { request: { workspaceId, configurationReference } }
  ).catch((error) => { throw toRuntimeError(error); });
}

export async function openRuntimeRemoteMcpSession(
  workspaceId: string,
  configurationReference: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeOpenedRemoteMcpSession>("open_remote_mcp_session", {
    request: { workspaceId, configurationReference }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function sendRuntimeRemoteMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string
) {
  if (!hasTauriRuntime()) return null;
  return invoke<string[]>("send_remote_mcp_frame", {
    request: { workspaceId, sessionId, frame }
  }).catch((error) => { throw toRuntimeError(error); });
}

export interface RuntimeRemoteMcpPollResult {
  supported: boolean;
  frames: string[];
  retryAfterMs: number;
}

export async function pollRuntimeRemoteMcpMessages(workspaceId: string, sessionId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpPollResult>("poll_remote_mcp_messages", {
    request: { workspaceId, sessionId }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function closeRuntimeRemoteMcpSession(workspaceId: string, sessionId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<null>("close_remote_mcp_session", {
    request: { workspaceId, sessionId }
  }).catch((error) => { throw toRuntimeError(error); });
}

export async function writeRuntimeMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("write_mcp_frame", {
      request: { workspaceId, sessionId, frame }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function closeRuntimeMcpProcess(workspaceId: string, sessionId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("close_mcp_process", {
      request: { workspaceId, sessionId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function recordRuntimeMcpDiscovery(
  workspaceId: string,
  sessionId: string,
  tools: string[],
  resources: string[]
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeMcpConnectionDetails>("record_mcp_server_discovery", {
      request: { workspaceId, sessionId, tools, resources }
    });
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
  capabilityBindings: Array<{ capabilityId: "knowledge.content.search"; toolName: string }>
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeMcpConnectionDetails>("set_mcp_server_enablement", {
      request: {
        workspaceId,
        connectionId,
        expectedRevision,
        enabledTools,
        enabledResources,
        capabilityBindings
      }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeMcpToolCall(proposal: RuntimeMcpToolProposal) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimePreparedMcpToolCall>("prepare_mcp_tool_call", { proposal });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function authorizeRuntimeMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  resolution: ApprovalResolutionRequest
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeAuthorizedMcpToolCall>("authorize_mcp_tool_call", {
      request: { proposal, resolution }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function executeRuntimeApprovedMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  permitId: string,
  requestId: string
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<string[]>("execute_approved_mcp_tool_call", {
      request: { proposal, permitId, requestId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Normalize and persist one mission-owned MCP cited-search result in Rust. */
export async function attestRuntimeMissionMcpConnectedSearch(
  permitId: string
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<Record<string, unknown>>("attest_mission_mcp_connected_search", {
      request: { permitId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listenRuntimeMcpFrames(
  channel: string,
  onFrame: (line: string) => void
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
  /** Optional active private project scope. */
  projectId?: string;
  /** Active teammate scope used by native code to resolve isolated local files. */
  agentId?: string;
  /** Native-owned live MCP session selected from an explicit semantic binding. */
  mcpSessionId?: string;
  /** Exact mission journal binding for one connected-source tool result. */
  missionWorkerToolExecution?: import("@fable/protocol").MissionWorkerToolExecutionBinding;
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
// Canonical Routines. The native boundary derives workspace/member ownership,
// encrypts every payload, and retains immutable versions. Browser mode returns
// null rather than pretending its synthetic schedules are durable Routines.
// ---------------------------------------------------------------------------

export type RuntimeRoutine = Spine.ArtifactsAndRoutines.Routine;
export type RuntimeRoutineVersion = Spine.ArtifactsAndRoutines.RoutineVersion;
export type RuntimeRoutineTrigger = Spine.ArtifactsAndRoutines.RoutineTrigger;
export type RuntimeRoutineTriggerSpec = Spine.ArtifactsAndRoutines.RoutineTriggerSpec;
export type RuntimeRoutineOccurrence = Spine.ArtifactsAndRoutines.RoutineOccurrenceReference;

export interface RuntimeRoutineBundle {
  routine: RuntimeRoutine;
  currentVersion: RuntimeRoutineVersion;
  triggers: RuntimeRoutineTrigger[];
}

export interface RuntimeRoutineMigrationSummary {
  id: string;
  inputHash: string;
  planHash: string;
  status: "applying" | "applied" | "rolled-back";
  plannedAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
  candidateCount: number;
  occurrenceCount: number;
  quarantineCount: number;
}

export interface RuntimeRoutineSchedulerStatus {
  authority: {
    workspaceId: string;
    writer: "legacy" | "routine";
    phase: "legacy" | "shadow" | "routine" | "rollback";
    epoch: number;
    fenceToken: string;
    proofHash?: string;
    updatedAt: string;
  };
  readyForCutover: boolean;
  blockers: string[];
  activeLegacyJobs: number;
  mappedLegacyJobs: number;
  futureLegacyOccurrences: number;
  terminalLegacyOccurrences: number;
  routineDriverOccurrences: number;
  reconciliationHash?: string;
}

export interface RuntimeRoutineConnectionOption {
  connectionId: string;
  displayName: string;
  healthState: string;
}

export async function listRuntimeRoutines(projectId?: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineBundle[]>("routine_list", {
      input: { projectId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeRoutineConnectionOptions() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineConnectionOption[]>("routine_connection_options");
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function createRuntimeRoutine(input: {
  projectId?: string;
  agentId?: string;
  title: string;
  instruction: string;
  trigger: RuntimeRoutineTriggerSpec;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineBundle>("routine_create", { input });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function editRuntimeRoutine(input: {
  projectId?: string;
  agentId?: string;
  routineId: string;
  expectedRevision: number;
  title: string;
  instruction: string;
  trigger?: RuntimeRoutineTriggerSpec;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineBundle>("routine_edit", { input });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

async function transitionRuntimeRoutine(
  action: "pause" | "resume" | "delete",
  input: {
    projectId?: string;
    routineId: string;
    expectedRevision: number;
    reason?: string;
  }
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineBundle>(`routine_${action}`, { input });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const pauseRuntimeRoutine = (
  input: Parameters<typeof transitionRuntimeRoutine>[1]
) => transitionRuntimeRoutine("pause", input);
export const resumeRuntimeRoutine = (
  input: Parameters<typeof transitionRuntimeRoutine>[1]
) => transitionRuntimeRoutine("resume", input);
export const deleteRuntimeRoutine = (
  input: Parameters<typeof transitionRuntimeRoutine>[1]
) => transitionRuntimeRoutine("delete", input);

export async function listRuntimeRoutineHistory(routineId: string, projectId?: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineOccurrence[]>("routine_occurrence_history", {
      input: { routineId, projectId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export interface RuntimeRoutineRunRequest {
  workspaceId: string;
  projectId?: string;
  agentId?: string;
  routineId: string;
  routineVersion: number;
  triggerId: string;
  occurrenceId: string;
  runId: string;
  scheduledAt: string;
  action: {
    kind: "direct-request" | "workflow-compatibility";
    title: string;
    instruction: string;
  };
  routePolicy:
    | { kind: "resolve-at-run" }
    | {
        kind: "deliberate-pin";
        providerRouteId: string;
        pinnedByInternalUserId: string;
        pinnedAt: string;
        reason: string;
      };
  writerEpoch: number;
  leaseToken: string;
  attemptNumber: number;
}

export async function listenRuntimeRoutineRunRequest(
  onRun: (event: RuntimeRoutineRunRequest) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<RuntimeRoutineRunRequest>("fable://routine/run-request", (event) => {
      const scope = activeDataScope();
      if (
        scope &&
        event.payload.workspaceId === scope.workspaceId &&
        (event.payload.projectId ?? null) === scope.projectId
      ) {
        onRun(event.payload);
      }
    });
  } catch {
    return null;
  }
}

export async function renewRuntimeRoutineLease(input: {
  projectId?: string;
  occurrenceId: string;
  writerEpoch: number;
  leaseToken: string;
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("routine_driver_renew", { input });
  } catch {
    return null;
  }
}

export async function reportRuntimeRoutineAttempt(input: {
  projectId?: string;
  occurrenceId: string;
  writerEpoch: number;
  leaseToken: string;
  runId: string;
  attemptNumber: number;
  status: "running" | "completed" | "failed" | "cancelled" | "blocked";
}) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<string>("routine_driver_report", { input });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

async function invokeRuntimeRoutineScheduler(
  command:
    | "routine_scheduler_status"
    | "routine_scheduler_begin_shadow"
    | "routine_scheduler_cutover"
    | "routine_scheduler_rollback",
  projectId?: string
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineSchedulerStatus>(command, {
      input: { projectId }
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const getRuntimeRoutineSchedulerStatus = (projectId?: string) =>
  invokeRuntimeRoutineScheduler("routine_scheduler_status", projectId);
export const beginRuntimeRoutineSchedulerShadow = (projectId?: string) =>
  invokeRuntimeRoutineScheduler("routine_scheduler_begin_shadow", projectId);
export const cutoverRuntimeRoutineScheduler = (projectId?: string) =>
  invokeRuntimeRoutineScheduler("routine_scheduler_cutover", projectId);
export const rollbackRuntimeRoutineScheduler = (projectId?: string) =>
  invokeRuntimeRoutineScheduler("routine_scheduler_rollback", projectId);

/**
 * Captures the authenticated encrypted legacy snapshot in Rust, runs the pure
 * deterministic planner, then atomically binds both exact values in Rust.
 */
export async function migrateLegacyRoutines(projectId?: string) {
  if (!hasTauriRuntime()) return null;
  const plannedAt = new Date().toISOString();
  try {
    const evidence = await invoke<LegacyRoutineMigrationInput>("routine_migration_capture", {
      input: { projectId, plannedAt }
    });
    const { planLegacyRoutineMigration } = await import("@fable/connectors/routines");
    const plan: LegacyRoutineMigrationPlan = planLegacyRoutineMigration(evidence);
    const summary = await invoke<RuntimeRoutineMigrationSummary>("routine_migration_apply", {
      input: { projectId, evidence, plan }
    });
    return { evidence, plan, summary };
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function rollbackLegacyRoutineMigration(batchId: string, projectId?: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeRoutineMigrationSummary>("routine_migration_rollback", {
      input: { projectId, batchId }
    });
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
