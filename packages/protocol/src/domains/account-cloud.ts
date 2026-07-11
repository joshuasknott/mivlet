import type {
  ExternalAuthenticationFacts,
  InvitationAcceptancePresentation,
  WorkspaceInvitationRecord,
  WorkspaceRole,
} from "../spine/identity.js";
import type {
  DeviceId,
  InternalUserId,
  IsoDateTime,
  MemberId,
  ProjectId,
  Revision,
  WorkspaceId,
} from "../spine/primitives.js";
import type {
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from "../spine/projects.js";

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

/** A server-selected invitation addressed to the current authenticated user. */
export interface AccountPendingInvitation {
  invitation: WorkspaceInvitationRecord;
  selection: Extract<InvitationAcceptancePresentation, { kind: "direct-inbox" }>;
  /** Server-owned display name for the exact invitation workspace. */
  workspaceName: string;
}

/** Secret-free inbox state; the renderer cannot choose another recipient. */
export interface AccountPendingInvitationList {
  invitations: readonly AccountPendingInvitation[];
}

export type AccountInvitationAcceptanceDecision =
  | {
      status: "accepted";
      invitationId: string;
      workspaceId: string;
      role: WorkspaceRole;
    }
  | {
      status: "conflict" | "rejected";
      code: string;
      message: string;
    };

/**
 * Native composes the hosted decision with the refreshed local workspace
 * directory. React supplies only the invitation id and never supplies
 * presentation evidence, identity facts, authorization, or idempotency.
 */
export interface AccountInvitationAcceptanceOutcome {
  result: AccountInvitationAcceptanceDecision;
  accountWorkspace: AccountWorkspaceStatus;
  reconciliation: {
    status: "refreshed" | "refresh-needed" | "not-needed";
    message: string;
  };
}

export type CloudWorkspaceRole = WorkspaceRole;
export type CloudSyncState = "disabled" | "unlinked" | "active" | "stale" | "revoked" | "blocked" | "error";
export type CloudSyncRecordType = "project";
export type CloudSyncOperation = "create" | "update" | "delete";

/** The first useful Convex-owned shared record. Local project commands never write this shape. */
export type SharedProjectRecord = Readonly<Project> & {
  readonly authority: "convex";
  readonly visibility: "workspace-shared";
  readonly workspaceRevision: Revision;
};

export interface SharedProjectTombstone {
  workspaceId: WorkspaceId;
  recordType: "project";
  recordId: ProjectId;
  revision: Revision;
  deletedAt: IsoDateTime;
  actorInternalUserId: InternalUserId;
  actorMemberId: MemberId;
  actorDeviceId: DeviceId;
  reasonClass: "user-delete" | "member-removed" | "workspace-deleted";
}

export type SharedProjectMutation =
  | {
      recordType: "project";
      recordId: ProjectId;
      operation: "create";
      baseRevision: 0;
      payload: ProjectCreateInput;
    }
  | {
      recordType: "project";
      recordId: ProjectId;
      operation: "update";
      baseRevision: Revision;
      payload: Omit<ProjectUpdateInput, "projectId" | "baseRevision">;
    }
  | {
      recordType: "project";
      recordId: ProjectId;
      operation: "delete";
      baseRevision: Revision;
      payload?: never;
    };

/** Closed, fingerprint-bound intent sent from the encrypted outbox to Convex. */
export type CloudMutationEnvelope = SharedProjectMutation & {
  workspaceId: WorkspaceId;
  deviceId: DeviceId;
  clientMutationId: string;
  idempotencyKey: string;
  /** SHA-256 over the canonical operation, scope, revision, and allowed payload. */
  intentFingerprint: string;
};

export type CloudMutationResult =
  | {
      status: "accepted";
      workspaceRevision: Revision;
      record: SharedProjectRecord;
    }
  | {
      status: "accepted";
      workspaceRevision: Revision;
      tombstone: SharedProjectTombstone;
    }
  | {
      status: "rejected" | "conflict";
      code:
        | "permission-denied"
        | "membership-inactive"
        | "device-inactive"
        | "stale-revision"
        | "idempotency-conflict"
        | "backfill-required"
        | "conflict";
      message: string;
      currentRecord?: SharedProjectRecord;
    };

export type CloudWorkspaceDeltaChange =
  | { kind: "record"; record: SharedProjectRecord }
  | { kind: "tombstone"; tombstone: SharedProjectTombstone };

/** Ordered, replay-safe delta. Cursor advancement is atomic with every change. */
export interface CloudWorkspaceDelta {
  workspaceId: WorkspaceId;
  afterRevision: Revision;
  workspaceRevision: Revision;
  changes: readonly CloudWorkspaceDeltaChange[];
}

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
