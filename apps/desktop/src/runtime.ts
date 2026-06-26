import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LocalTextFileCandidate } from "@arden/connectors";
import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
  BackendConsequentialEvent,
  BackendCredentialRequest,
  BackendProvider,
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  RuntimeSnapshot
} from "@arden/protocol";

interface ApprovalAuditRecordResponse {
  persisted: boolean;
  entry: ApprovalAuditEntry;
  auditLen: number;
}

function hasTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}

function toRuntimeError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Arden runtime request failed.");
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
 * audit; they never bypass Arden's approval layer for future actions.
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
// normalized SSE lines on the `arden://backend/<requestId>` channel. Outside
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
