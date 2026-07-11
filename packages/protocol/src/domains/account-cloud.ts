import type { ExternalAuthenticationFacts, WorkspaceRole } from "../spine/identity.js";

// ---------------------------------------------------------------------------
// Fable account identity and session status.
//
// This is not connector OAuth and not the confidential auth broker. It is a
// secret-free view of the native account identity boundary. Clerk authenticates
// an external principal; Fable-owned membership and authorization are resolved
// separately. Refresh/session credentials remain in the Rust OS-keyring boundary.
// ---------------------------------------------------------------------------

export type AccountSessionState =
  | "disabled"
  | "signed-out"
  | "signed-in"
  | "offline"
  | "refreshing"
  | "expired"
  | "revoked"
  | "error";

export interface VerifiedAccountDisplayAttributes {
  displayName?: string;
  /** Present only when the identity provider marks the address as verified. */
  email?: string;
}

/**
 * Secret-free facts from a validated external account session. These facts
 * identify a principal but grant no Fable workspace access or role.
 */
export interface AccountAuthenticationFacts extends ExternalAuthenticationFacts {
  verifiedDisplayAttributes?: VerifiedAccountDisplayAttributes;
}

export interface IdentityStatus {
  enabled: boolean;
  state: AccountSessionState;
  message: string;
  issuer?: string;
  audience?: string;
  scopes: string[];
  authentication?: AccountAuthenticationFacts;
}

export type AccountWorkspaceLifecycleState =
  | "disabled"
  | "signed-out"
  | "bootstrapping"
  | "ready"
  | "offline"
  | "expired"
  | "revoked"
  | "error";

export interface AccountWorkspaceSummary {
  fableWorkspaceId: string;
  localWorkspaceId: string;
  name: string;
  workspaceStatus: "active" | "locked" | "pending-deletion" | "deleted";
  workspaceRevision: number;
  policyRevision: number;
  memberId: string;
  role: WorkspaceRole;
  membershipStatus: "active" | "suspended" | "removed";
  membershipRevision: number;
  updatedAt: string;
}

export interface ActiveWorkspaceSelection {
  localWorkspaceId: string;
  fableWorkspaceId?: string;
  name: string;
  source: "hosted" | "legacy-default";
}

export interface AccountDeviceSummary {
  deviceId: string;
  kind: "desktop" | "mobile" | "web";
  label: string;
  status: "pending" | "active" | "revoked";
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** Secret-free account/workspace state exposed by the focused native adapter. */
export interface AccountWorkspaceStatus {
  configured: boolean;
  state: AccountWorkspaceLifecycleState;
  message: string;
  accountBound: boolean;
  workspaces: AccountWorkspaceSummary[];
  activeWorkspace: ActiveWorkspaceSelection;
  /** Secret-free native owner used for private local data; member is hosted-only. */
  activeContextOwner?: {
    internalUserId: string;
    memberId?: string;
  };
  devices: AccountDeviceSummary[];
}

export type CloudWorkspaceRole = WorkspaceRole;
export type CloudSyncState = "disabled" | "unlinked" | "active" | "stale" | "revoked" | "blocked" | "error";
export type CloudSyncRecordType = "project";
export type CloudSyncOperation = "create" | "update" | "delete";

export interface CloudWorkspaceLinkState {
  localWorkspaceId: string;
  cloudWorkspaceId: string;
  internalUserId: string;
  memberId: string;
  role: CloudWorkspaceRole;
  syncState: CloudSyncState;
  linkedDeviceId: string;
  lastAcceptedRevision: number;
  linkedAt: string;
  updatedAt: string;
}

export interface CloudSyncStatus {
  configured: boolean;
  linked: boolean;
  state: CloudSyncState | string;
  message: string;
  link?: CloudWorkspaceLinkState | null;
  queuedCount: number;
}

export interface CloudSyncEnqueueRequest {
  localWorkspaceId: string;
  localMutationId: string;
  clientMutationId: string;
  baseRevision: number;
  recordType: CloudSyncRecordType;
  recordId: string;
  operation: CloudSyncOperation;
  payload: unknown;
}

export interface CloudMutationOutboxRow {
  localMutationId: string;
  idempotencyKey: string;
  localWorkspaceId: string;
  cloudWorkspaceId: string;
  deviceId: string;
  clientMutationId: string;
  baseRevision: number;
  recordType: CloudSyncRecordType;
  recordId: string;
  operation: CloudSyncOperation;
  status: "queued" | "flushing" | "accepted" | "rejected" | "conflict";
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  payload: unknown;
}

export interface CloudSyncFlushResult {
  phase: "disabled" | "unlinked" | "blocked" | "adapter-unavailable" | string;
  queuedCount: number;
  message: string;
}

export interface CloudSyncPullResult {
  phase: "disabled" | "unlinked" | "blocked" | "adapter-unavailable" | string;
  lastPulledRevision: number;
  message: string;
}
