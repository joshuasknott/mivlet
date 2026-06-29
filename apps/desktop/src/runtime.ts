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
  AgentRunRequest,
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
  JobAttempt,
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  NotificationRecord,
  PersistedAgentRun,
  RuntimeSnapshot,
  ScheduledExecutionRoute,
  ScheduledJob,
  ScheduledJobStatus,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus
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

export async function saveRuntimeImportedKnowledgeSources(sources: LocalFileImport[]) {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<LocalFileImport[]>("save_imported_knowledge_sources", { sources });
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
 * Discover the available model ids for a connected native provider. Rust looks
 * up the key (fail closed — no egress without a credential), issues a bounded
 * GET to the provider's list-models endpoint, and returns the parsed ids. Returns
 * null outside Tauri so the shell falls back to the curated catalogue and stays
 * fixture-testable. A null/empty result is treated as "discovery did not run".
 */
export interface RuntimeDiscoveredModel {
  id: string;
  available: boolean;
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
    return await invoke<RuntimeModelDiscoveryResult>("list_backend_models", { providerId });
  } catch (error) {
    return {
      outcome: "failed" as const,
      models: [],
      message: toRuntimeError(error).message
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
    return await invoke<ScheduledJob[]>("list_scheduler_jobs");
  } catch {
    return null;
  }
}

export async function listRuntimeSchedulerQueue() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<SchedulerQueueEntry[]>("list_scheduler_queue");
  } catch {
    return null;
  }
}

export async function saveRuntimeScheduledJob(job: ScheduledJob) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<ScheduledJob>("save_scheduled_job", { job });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function deleteRuntimeScheduledJob(jobId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("delete_scheduled_job", { jobId });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function setRuntimeJobStatus(jobId: string, status: ScheduledJobStatus) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("set_job_status", { jobId, status });
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
      scheduledAt
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function reportRuntimeJobAttempt(runId: string, attempt: JobAttempt) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("report_job_attempt", { runId, attempt });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/** Renew a running entry's lease (heartbeat). Rejects stale tokens in Rust. */
export async function renewRuntimeJobLease(runId: string, leaseToken: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("renew_job_lease", { runId, leaseToken });
  } catch {
    return null;
  }
}

/** Re-queue a blocked-auth entry once its backend reconnected. */
export async function requeueRuntimeBlockedJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("requeue_blocked_job_run", { runId });
  } catch {
    return null;
  }
}

/** Cancel a queued/leased/running entry from the Schedules UI. */
export async function cancelRuntimeJobRun(runId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<boolean>("cancel_job_run", { runId });
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
    jobId: string;
    runId: string;
    scheduledAt: string;
    leaseToken?: string;
    execution?: ScheduledExecutionRoute;
  }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<{
      jobId: string;
      runId: string;
      scheduledAt: string;
      leaseToken?: string;
      execution?: ScheduledExecutionRoute;
    }>("fable://scheduler/run-request", (event) => onRun(event.payload));
    return unlisten;
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
  input: unknown;
  steps: unknown;
  failureReason?: string;
  idempotencyKey?: string;
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
    input: run.input,
    steps: run.steps,
    failureReason: run.failureReason,
    idempotencyKey: run.idempotencyKey,
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
    input: (record.input as Record<string, unknown>) ?? {},
    steps: (record.steps as WorkflowRun["steps"]) ?? [],
    failureReason: record.failureReason,
    idempotencyKey: record.idempotencyKey,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt
  };
}

export async function saveRuntimeWorkflowRun(run: WorkflowRun) {
  if (!hasTauriRuntime()) return null;
  const record = toWorkflowRunWire(run);
  try {
    return await invoke<WorkflowRunRecordWire>("save_workflow_run", { run: record });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function saveRuntimeWorkflowDefinition(definition: WorkflowDefinition) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowDefinition>("save_workflow_definition", { definition });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeWorkflowDefinitions() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowDefinition[]>("list_workflow_definitions");
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRuns() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs");
  } catch {
    return null;
  }
}

export async function listRuntimeWorkflowRunsForDefinition(definitionId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs_for_definition", {
      definitionId
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
