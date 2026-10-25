import { toRuntimeError } from "../errors";
import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
} from "@mivlet/protocol";
import { hasTauriRuntime, invoke, activeDataScope } from "../bridge";

interface ApprovalAuditRecordResponse {
  persisted: boolean;
  entry: ApprovalAuditEntry;
  auditLen: number;
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
