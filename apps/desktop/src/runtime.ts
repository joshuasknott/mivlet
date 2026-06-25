import { invoke } from "@tauri-apps/api/core";
import type { LocalTextFileCandidate } from "@praxis/connectors";
import type {
  ApprovalAuditEntry,
  KnowledgeSearchResponse,
  KnowledgeSource,
  LocalFileImport
} from "@praxis/protocol";

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

  return new Error(typeof error === "string" ? error : "Praxis runtime request failed.");
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
