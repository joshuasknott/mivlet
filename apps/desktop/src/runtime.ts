import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LocalTextFileCandidate } from "@fable/connectors";
import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
  BackendConsequentialEvent,
  BackendCredentialRequest,
  BackendProvider,
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
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  PersistedAgentRun,
  RuntimeSnapshot
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
    return await invoke<LocalFileImport[]>("list_imported_knowledge_sources");
  } catch {
    return null;
  }
}

export async function importRuntimeLocalKnowledgeSource(candidate: LocalTextFileCandidate) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<LocalFileImport>("import_local_knowledge_source", {
      candidate
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
    return await invoke<MemoryControlState>("list_memory_state");
  } catch {
    return null;
  }
}

export async function loadRuntimeSnapshot() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<RuntimeSnapshot | null>("load_runtime_snapshot");
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
      snapshot
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
      state
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function exportRuntimeMemoryState(state: MemoryControlState) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<string>("export_memory_state", {
      state
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
      request
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
    return await invoke<ConnectorManifest[]>("list_connector_statuses");
  } catch {
    return null;
  }
}

export async function startRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAuthResult>("start_connector_auth", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function completeRuntimeConnectorAuth(request: ConnectorAuthRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAuthResult>("complete_connector_auth", { request });
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
    return await invoke<ConnectorAuthResult>("begin_connector_oauth", { request });
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
    return await invoke<ConnectorManifest>("clear_connector_auth", { connectorId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorAccounts(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorAccountOption[]>("list_connector_accounts", { connectorId });
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
      accountId
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
    return await invoke<ConnectorManifest>("refresh_connector_health", { connectorId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function searchRuntimeConnector(request: ConnectorSearchRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorSearchResult>("search_connector", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function importRuntimeConnectorItem(request: ConnectorImportRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorImportResult>("import_connector_item", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function prepareRuntimeConnectorAction(request: ConnectorActionRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<ConnectorActionRequest>("prepare_connector_action", { request });
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
    return await invoke<ConnectorActionResult>("execute_approved_connector_action", { request });
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
