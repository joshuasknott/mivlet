import { invoke } from "@tauri-apps/api/core";
import type { ApprovalAuditEntry } from "@praxis/protocol";

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
