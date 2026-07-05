import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const DEFAULT_DATA_SCOPE = { workspaceId: "default", projectId: null } as const;
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
  CloudWorkspaceLinkState
} from "@fable/protocol";

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

export async function loadRuntimeApprovalAudit() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<ApprovalAuditEntry[]>("list_approval_audit");
  } catch {
    return null;
  }
}

export async function loadRuntimeApprovalRules() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<ApprovalGrant[]>("list_approval_rules");
  } catch {
    return null;
  }
}

export async function resolveRuntimeApprovalRequest(request: ApprovalResolutionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<ApprovalResolutionResponse>("resolve_approval_request", {
      request
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function loadRuntimeImportedKnowledgeSources() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<LocalFileImport[]>("list_imported_knowledge_sources", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function saveRuntimeImportedKnowledgeSources(sources: LocalFileImport[]) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<LocalFileImport[]>("save_imported_knowledge_sources", {
      sources,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeLocalKnowledgeSource(candidate: LocalTextFileCandidate) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<LocalFileImport>("import_local_knowledge_source", {
      candidate,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function searchRuntimeKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limit?: number
) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<KnowledgeSearchResponse>("search_knowledge_sources", {
      query,
      sources,
      limit
    });
  } catch {
    return null;
  }
}

export async function loadRuntimeMemoryState() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<MemoryControlState>("list_memory_state", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function loadRuntimeSnapshot() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<RuntimeSnapshot | null>("load_runtime_snapshot", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function saveRuntimeSnapshot(snapshot: RuntimeSnapshot) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<RuntimeSnapshot>("save_runtime_snapshot", {
      snapshot,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeAgentRun(run: PersistedAgentRun) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<PersistedAgentRun>("save_agent_run", { run });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeAgentRuns() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<PersistedAgentRun[]>("list_agent_runs");
  } catch {
    return null;
  }
}

export async function recoverRuntimeAgentRuns(recoveredAt: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<PersistedAgentRun[]>("recover_interrupted_agent_runs", { recoveredAt });
  } catch {
    return null;
  }
}

export async function saveRuntimeMemoryState(state: MemoryControlState) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<MemoryControlState>("save_memory_state", {
      state,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(_state: MemoryControlState) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<string>("export_memory_state", {
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function promoteRuntimeKnowledgeSourceToMemory(request: MemoryPromotionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<MemoryPromotionResponse>("promote_knowledge_source_to_memory", {
      request,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function recordRuntimeApprovalDecision(entry: ApprovalAuditEntry) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    const response = await invoke<ApprovalAuditRecordResponse>("record_approval_decision", {
      entry
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

  try {
    return await invoke<ActionHistoryEvent[]>("list_action_history", {
      category: category ?? null,
      limit: limit ?? null
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

  try {
    return await invoke<boolean>("record_action_history", { request });
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

export async function loadRuntimeCloudSyncStatus(workspaceId = "default") {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<CloudSyncStatus>("cloud_sync_status", { workspaceId });
  } catch {
    return null;
  }
}

export async function loadRuntimeCloudSyncLinkState(workspaceId = "default") {
  if (!hasTauriRuntime()) {
    return null;
  }
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
  try {
    return await invoke<CloudMutationOutboxRow>("cloud_sync_enqueue_shared_mutation", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function flushRuntimeCloudSyncOutbox(workspaceId = "default") {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<CloudSyncFlushResult>("cloud_sync_flush_outbox", { workspaceId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function pullRuntimeCloudSyncAfterCursor(workspaceId = "default") {
  if (!hasTauriRuntime()) {
    return null;
  }
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
  try {
    return await invoke<ConnectorManifest[]>("list_connector_statuses", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function startRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAuthResult>("start_connector_auth", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function completeRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAuthResult>("complete_connector_auth", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
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
  try {
    return await invoke<ConnectorAuthResult>("begin_connector_oauth", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
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
  try {
    return await invoke<ConnectorManifest>("clear_connector_auth", {
      connectorId,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorAccounts(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAccountOption[]>("list_connector_accounts", {
      connectorId,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function switchRuntimeConnectorAccount(connectorId: string, accountId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorManifest>("switch_connector_account", {
      connectorId,
      accountId,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function refreshRuntimeConnectorHealth(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorManifest>("refresh_connector_health", {
      connectorId,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorSyncStates(workspaceId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
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
  try {
    return await invoke<ConnectorSearchResult>("search_connector", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeConnectorItem(request: ConnectorImportRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorImportResult>("import_connector_item", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeConnectorAction(request: ConnectorActionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorActionRequest>("prepare_connector_action", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
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
  try {
    return await invoke<ConnectorActionResult>("execute_approved_connector_action", {
      request,
      workspaceId: DEFAULT_DATA_SCOPE.workspaceId
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
    return { installed: false, message: "Fable could not inspect the Codex CLI." };
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
// Rust owns the CLI child process for ACP providers (Cursor, Grok): it spawns
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
  try {
    return await invoke<ScheduledJob[]>("list_scheduler_jobs", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function listRuntimeSchedulerQueue() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<SchedulerQueueEntry[]>("list_scheduler_queue", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function saveRuntimeScheduledJob(job: ScheduledJob) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<ScheduledJob>("save_scheduled_job", { job, ...DEFAULT_DATA_SCOPE });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function deleteRuntimeScheduledJob(jobId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("delete_scheduled_job", { jobId, ...DEFAULT_DATA_SCOPE });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function setRuntimeJobStatus(jobId: string, status: ScheduledJobStatus) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("set_job_status", { jobId, status, ...DEFAULT_DATA_SCOPE });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function enqueueRuntimeJobRun(jobId: string, runId: string, scheduledAt: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<SchedulerQueueEntry>("enqueue_job_run", {
      jobId,
      runId,
      scheduledAt,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function reportRuntimeJobAttempt(runId: string, attempt: JobAttempt) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("report_job_attempt", { runId, attempt, ...DEFAULT_DATA_SCOPE });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Renew a running entry's lease (heartbeat). Rejects stale tokens in Rust. */
export async function renewRuntimeJobLease(runId: string, leaseToken: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("renew_job_lease", {
      runId,
      leaseToken,
      ...DEFAULT_DATA_SCOPE
    });
  } catch {
    return null;
  }
}

/** Re-queue a blocked-auth entry once its backend reconnected. */
export async function requeueRuntimeBlockedJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("requeue_blocked_job_run", { runId, ...DEFAULT_DATA_SCOPE });
  } catch {
    return null;
  }
}

/** Cancel a queued/leased/running entry from the Schedules UI. */
export async function cancelRuntimeJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("cancel_job_run", { runId, ...DEFAULT_DATA_SCOPE });
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
      const workspaceId = event.payload.workspaceId ?? "default";
      if (
        workspaceId === DEFAULT_DATA_SCOPE.workspaceId &&
        (event.payload.projectId ?? null) === DEFAULT_DATA_SCOPE.projectId
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
        if ((event.payload.workspaceId ?? "default") === DEFAULT_DATA_SCOPE.workspaceId) {
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
  const record = toWorkflowRunWire(run);
  try {
    return await invoke<WorkflowRunRecordWire>("save_workflow_run", {
      run: record,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeWorkflowDefinition(definition: WorkflowDefinition) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowDefinition>("save_workflow_definition", {
      definition,
      ...DEFAULT_DATA_SCOPE
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeWorkflowDefinitions() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowDefinition[]>("list_workflow_definitions", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRuns() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs", DEFAULT_DATA_SCOPE);
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRunsForDefinition(definitionId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs_for_definition", {
      definitionId,
      ...DEFAULT_DATA_SCOPE
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
