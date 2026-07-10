export type PermissionMode = "read-only" | "trusted-scope" | "full-access";
export type PermissionProfileId = "read-only" | "trusted" | "full-with-approvals";
export type ApprovalPresetLabel = "Read Only" | "Ask Me" | "Work Freely" | "Custom";

/**
 * Plain-language custom approval preferences. These are a view onto the same
 * PermissionMode levels, not a second approval engine. The shell resolves the
 * toggles down to one mode before a run, and the native execution boundary
 * remains the only side-effect authority.
 */
export interface CustomApprovalSettings {
  allowSmallLocalEdits: boolean;
  allowPowerfulCommands: boolean;
}

export type ApprovalDecision = "once" | "session" | "rule" | "modify" | "deny";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalGrantScope = "session" | "rule";

export interface ApprovalRequest {
  id: string;
  service: string;
  action: string;
  mode: PermissionMode;
  permissionProfile?: PermissionProfileId;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  requestedAt: string;
  decisions: ApprovalDecision[];
  confirmationPhrase?: string;
}

export interface ApprovalModification {
  mode: PermissionMode;
  permissionProfile?: PermissionProfileId;
  dataUsed: string[];
  consequence: string;
}

export interface ApprovalGrant {
  id: string;
  requestId: string;
  scope: ApprovalGrantScope;
  service: string;
  action: string;
  mode: PermissionMode;
  permissionProfile?: PermissionProfileId;
  dataUsed: string[];
  createdAt: string;
}

export interface ApprovalResolutionRequest {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: string;
  confirmationText?: string;
  modification?: ApprovalModification;
}

export interface ApprovalResolutionResponse {
  persisted: boolean;
  auditEntry: ApprovalAuditEntry;
  effectiveRequest: ApprovalRequest;
  dismissed: boolean;
  grant?: ApprovalGrant;
}

export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  decision: ApprovalDecision;
  decidedAt: string;
  note: string;
}

/**
 * Inspectable action-history categories. Audit observes actions; it never grants
 * execution authority. These mirror the Rust `action_history::category`
 * constants and stay forward-compatible (new categories may appear).
 */
export type ActionHistoryCategory =
  | "model-call"
  | "connector-action"
  | "tool-action"
  | "web-action"
  | "approval"
  | "schedule"
  | "policy-block";

/**
 * A normalized, inspectable action-history event. Query fields are non-secret
 * (category/service/action/status, risk/mode, correlation id, normalized failure
 * code, safe summary, actor, time); `detail` holds redacted richer detail that is
 * only surfaced by an authorized inspectable surface. Never carries tokens, API
 * keys, raw provider secrets, auth handoff codes, full private file content,
 * full email bodies, or environment-variable values.
 */
export interface ActionHistoryEvent {
  id: string;
  category: ActionHistoryCategory | string;
  service: string;
  action: string;
  status: string;
  actor: string;
  /** ISO timestamp. */
  createdAt: string;
  riskLevel: string;
  mode: string;
  correlationId: string;
  errorCode: string;
  summary: string;
  /** Safe, redacted richer detail (preview, normalized failure message). */
  detail?: unknown;
}

/** Payload for the `record_action_history` Tauri command. */
export interface RecordActionHistoryRequest {
  category: ActionHistoryCategory | string;
  service: string;
  action: string;
  status: string;
  actor?: string;
  riskLevel?: string;
  mode?: string;
  correlationId?: string;
  errorCode?: string;
  summary?: string;
  detail?: unknown;
}
