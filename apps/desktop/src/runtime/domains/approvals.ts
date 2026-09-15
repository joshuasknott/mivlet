import { toRuntimeError } from "../errors";
import type {
  ActionHistoryCategory,
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
} from "@fable/protocol";
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
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;

  try {
    return await invoke<ActionHistoryEvent[]>("list_action_history", {
      category: category ?? null,
      limit: limit ?? null,
      ...scope,
    });
  } catch {
    return null;
  }
}
