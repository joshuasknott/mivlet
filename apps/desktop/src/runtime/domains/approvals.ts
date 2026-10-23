import type {
  ActionHistoryCategory,
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
} from "@mivlet/protocol";
import { invokeNative, activeDataScope } from "../bridge";

interface ApprovalAuditRecordResponse {
  persisted: boolean;
  entry: ApprovalAuditEntry;
  auditLen: number;
}

export async function loadRuntimeApprovalAudit() {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<ApprovalAuditEntry[]>("list_approval_audit", scope).catch(
    () => null,
  );
}

export async function loadRuntimeApprovalRules() {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<ApprovalGrant[]>("list_approval_rules", scope).catch(
    () => null,
  );
}

export async function resolveRuntimeApprovalRequest(
  request: ApprovalResolutionRequest,
) {
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<ApprovalResolutionResponse>("resolve_approval_request", {
    request,
    ...scope,
  });
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
  const scope = activeDataScope();
  if (!scope) return null;
  return invokeNative<ActionHistoryEvent[]>("list_action_history", {
    category: category ?? null,
    limit: limit ?? null,
    ...scope,
  }).catch(() => null);
}
