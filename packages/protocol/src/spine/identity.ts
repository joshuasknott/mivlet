import type {
  DeviceId,
  ExecutionNodeId,
  ExternalIdentityId,
  InternalUserId,
  InvitationId,
  IsoDateTime,
  MemberId,
  RecordMetadata,
  Revision,
  RoleId,
  WorkspaceId,
} from "./primitives.js";

export type AccountControlPlaneMetadata = Omit<
  RecordMetadata,
  "workspaceId" | "authority" | "createdByInternalUserId" | "createdByDeviceId"
> & {
  authority: "convex";
  /** Bootstrap can create the first internal user before an actor exists. */
  createdByInternalUserId?: InternalUserId;
  createdByDeviceId?: DeviceId;
};

export type WorkspaceControlPlaneMetadata = Omit<RecordMetadata, "authority"> & {
  authority: "convex";
};

export const INTERNAL_USER_STATUSES = [
  "active",
  "disabled",
  "pending-deletion",
  "deleted",
] as const;
export type InternalUserStatus = (typeof INTERNAL_USER_STATUSES)[number];

export const EXTERNAL_IDENTITY_LINK_STATUSES = ["active", "disabled", "revoked"] as const;
export type ExternalIdentityLinkStatus = (typeof EXTERNAL_IDENTITY_LINK_STATUSES)[number];

export const WORKSPACE_STATUSES = ["active", "locked", "pending-deletion", "deleted"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ["active", "suspended", "removed"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const ACCOUNT_DEVICE_STATUSES = ["pending", "active", "revoked"] as const;
export type AccountDeviceStatus = (typeof ACCOUNT_DEVICE_STATUSES)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_PERMISSIONS = [
  "workspace.read",
  "workspace.switch",
  "workspace.update",
  "workspace.manage-policy",
  "workspace.export",
  "workspace.transfer-ownership",
  "workspace.delete",
  "member.list",
  "member.invite",
  "member.change-role",
  "member.suspend",
  "member.reactivate",
  "member.remove",
  "invitation.list",
  "invitation.revoke",
  "device.list",
  "device.revoke",
  "record.read",
  "record.create",
  "record.update",
  "record.delete",
] as const;
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

export const WORKSPACE_ROLE_PERMISSIONS = {
  owner: WORKSPACE_PERMISSIONS,
  admin: [
    "workspace.read",
    "workspace.switch",
    "workspace.update",
    "workspace.manage-policy",
    "workspace.export",
    "member.list",
    "member.invite",
    "member.change-role",
    "member.suspend",
    "member.reactivate",
    "member.remove",
    "invitation.list",
    "invitation.revoke",
    "device.list",
    "device.revoke",
    "record.read",
    "record.create",
    "record.update",
    "record.delete",
  ],
  editor: [
    "workspace.read",
    "workspace.switch",
    "member.list",
    "device.list",
    "record.read",
    "record.create",
    "record.update",
    "record.delete",
  ],
  viewer: [
    "workspace.read",
    "workspace.switch",
    "member.list",
    "device.list",
    "record.read",
  ],
} as const satisfies Record<WorkspaceRole, readonly WorkspacePermission[]>;

export const WORKSPACE_ROLE_MANAGEMENT = {
  owner: ["owner", "admin", "editor", "viewer"],
  admin: ["admin", "editor", "viewer"],
  editor: [],
  viewer: [],
} as const satisfies Record<WorkspaceRole, readonly WorkspaceRole[]>;

export interface WorkspaceRoleDefinition {
  roleId: RoleId;
  role: WorkspaceRole;
  permissions: readonly WorkspacePermission[];
}

export interface CachedInternalUserProfile {
  displayName?: string;
  avatarUrl?: string;
  emailHint?: string;
}

export interface InternalUserRecord extends AccountControlPlaneMetadata {
  internalUserId: InternalUserId;
  status: InternalUserStatus;
  /** Cached profile fields are display-only and never identity or authorization keys. */
  profile?: CachedInternalUserProfile;
  disabledAt?: IsoDateTime;
  deletionRequestedAt?: IsoDateTime;
}

export interface ExternalIdentityKey {
  provider: string;
  normalizedIssuer: string;
  subject: string;
}

export interface ExternalIdentityLinkRecord
  extends AccountControlPlaneMetadata,
    ExternalIdentityKey {
  /** One provider/issuer/subject tuple must never map to multiple internal users. */
  externalIdentityId: ExternalIdentityId;
  internalUserId: InternalUserId;
  status: ExternalIdentityLinkStatus;
  lastValidatedAt: IsoDateTime;
  disabledAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export const VERIFIED_IDENTITY_ATTRIBUTE_KINDS = ["email", "phone"] as const;
export type VerifiedIdentityAttributeKind = (typeof VERIFIED_IDENTITY_ATTRIBUTE_KINDS)[number];

export interface VerifiedIdentityAttribute {
  kind: VerifiedIdentityAttributeKind;
  normalizedValueHash: string;
  verifiedAt: IsoDateTime;
}

/** Validated provider facts identify a principal; they grant no Fable workspace access. */
export interface ExternalAuthenticationFacts extends ExternalIdentityKey {
  authenticationEventRef: string;
  sessionRef: string;
  authenticatedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  verifiedAttributes: readonly VerifiedIdentityAttribute[];
}

export interface WorkspaceRecord extends WorkspaceControlPlaneMetadata {
  name: string;
  status: WorkspaceStatus;
  policyRevision: Revision;
  lockedAt?: IsoDateTime;
  deletionRequestedAt?: IsoDateTime;
}

export interface WorkspaceMembershipRecord extends WorkspaceControlPlaneMetadata {
  memberId: MemberId;
  internalUserId: InternalUserId;
  role: WorkspaceRole;
  status: MembershipStatus;
  joinedFromInvitationId?: InvitationId;
  activatedAt: IsoDateTime;
  suspendedAt?: IsoDateTime;
  removedAt?: IsoDateTime;
}

export type InvitationRecipientConstraint =
  | {
      kind: "internal-user";
      internalUserId: InternalUserId;
    }
  | {
      kind: "verified-identity-attribute";
      attributeKind: VerifiedIdentityAttributeKind;
      normalizedValueHash: string;
      displayHint?: string;
    };

export interface WorkspaceInvitationRecord extends WorkspaceControlPlaneMetadata {
  invitationId: InvitationId;
  status: InvitationStatus;
  role: WorkspaceRole;
  inviterMemberId: MemberId;
  recipientConstraint: InvitationRecipientConstraint;
  expiresAt: IsoDateTime;
  acceptedByInternalUserId?: InternalUserId;
  acceptedMembershipId?: MemberId;
  acceptedAt?: IsoDateTime;
  revokedByMemberId?: MemberId;
  revokedAt?: IsoDateTime;
}

export const ACCOUNT_DEVICE_KINDS = ["desktop", "mobile", "web"] as const;
export type AccountDeviceKind = (typeof ACCOUNT_DEVICE_KINDS)[number];

export interface DevicePublicKey {
  algorithm: string;
  encodedPublicKey: string;
  fingerprint: string;
}

export interface AccountDeviceRecord extends AccountControlPlaneMetadata {
  deviceId: DeviceId;
  internalUserId: InternalUserId;
  kind: AccountDeviceKind;
  label: string;
  status: AccountDeviceStatus;
  publicKey: DevicePublicKey;
  registeredAt: IsoDateTime;
  lastSeenAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface WorkspaceDeviceLinkRecord extends WorkspaceControlPlaneMetadata {
  deviceId: DeviceId;
  internalUserId: InternalUserId;
  memberId: MemberId;
  status: AccountDeviceStatus;
  linkedAt: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export const ONLINE_ONLY_AUTHORIZATION_OPERATIONS = [
  "identity.link",
  "workspace.create",
  "workspace.update-policy",
  "workspace.delete",
  "membership.change-role",
  "membership.change-status",
  "invitation.create",
  "invitation.accept",
  "invitation.revoke",
  "device.register",
  "device.revoke",
  "cloud.access",
  "shared-write.flush",
  "high-risk-action",
] as const;
export type OnlineOnlyAuthorizationOperation =
  (typeof ONLINE_ONLY_AUTHORIZATION_OPERATIONS)[number];

export type OfflineGracePolicy =
  | {
      mode: "disabled";
    }
  | {
      mode: "bounded";
      maxOfflineAgeSeconds: number;
      localUserVerification: "required" | "not-required";
      allowedPermissions: readonly WorkspacePermission[];
      onlineOnlyOperations: readonly OnlineOnlyAuthorizationOperation[];
    };

export interface WorkspaceAuthorizationPolicy {
  revision: Revision;
  offlineGrace: OfflineGracePolicy;
}

export type AuthorizationFreshness =
  | {
      mode: "online-revalidated";
      revalidatedAt: IsoDateTime;
    }
  | {
      mode: "offline-grace";
      lastOnlineValidationAt: IsoDateTime;
      validUntil: IsoDateTime;
      policyRevision: Revision;
    };

export interface AuthorizedDeviceFacts {
  deviceId: DeviceId;
  deviceRevision: Revision;
  workspaceLinkRevision?: Revision;
}

export interface AccountSessionAttribution {
  sessionRef: string;
  authenticationEventRef: string;
  authenticatedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

/** Membership permissions never imply capability grants or exact-action approval. */
export interface MembershipAuthorizationContext {
  requestId: string;
  internalUserId: InternalUserId;
  workspaceId: WorkspaceId;
  memberId: MemberId;
  role: WorkspaceRole;
  permissions: readonly WorkspacePermission[];
  workspaceRevision: Revision;
  membershipRevision: Revision;
  policyRevision: Revision;
  device?: AuthorizedDeviceFacts;
  session: AccountSessionAttribution;
  freshness: AuthorizationFreshness;
  resolvedAt: IsoDateTime;
}

export interface PerRequestAuthorizationContext {
  authentication: ExternalAuthenticationFacts;
  authorization: MembershipAuthorizationContext;
}

export interface RequestActorAttribution {
  internalUserId: InternalUserId;
  workspaceId: WorkspaceId;
  memberId: MemberId;
  role: WorkspaceRole;
  membershipRevision: Revision;
  policyRevision: Revision;
  deviceId?: DeviceId;
  sessionRef?: string;
  authenticationEventRef?: string;
  executionNodeId?: ExecutionNodeId;
  occurredAt: IsoDateTime;
}

export const AUTHORIZATION_ERROR_CODES = [
  "unauthenticated",
  "invalid-authentication",
  "authentication-expired",
  "authentication-revoked",
  "identity-link-not-found",
  "identity-link-inactive",
  "identity-link-conflict",
  "internal-user-inactive",
  "workspace-unavailable",
  "membership-required",
  "membership-inactive",
  "permission-denied",
  "role-assignment-denied",
  "last-active-owner",
  "invitation-unavailable",
  "invitation-expired",
  "invitation-recipient-mismatch",
  "invitation-already-consumed",
  "device-required",
  "device-unavailable",
  "device-inactive",
  "session-ineligible",
  "online-reauthentication-required",
  "stale-policy",
  "stale-revision",
  "idempotency-conflict",
  "conflict",
] as const;
export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number];

export interface FailClosedAuthorizationError {
  type: "authorization-error";
  code: AuthorizationErrorCode;
  message: string;
  retryable: boolean;
  /** Opaque errors do not reveal whether a cross-workspace target exists. */
  disclosure: "opaque" | "safe";
}

export interface IdempotencyRequest {
  key: string;
  requestedAt: IsoDateTime;
  requestedByDeviceId?: DeviceId;
}

export interface IdempotencyReceipt {
  key: string;
  replayed: boolean;
  recordedAt: IsoDateTime;
}

export interface DeviceRegistrationRequest {
  deviceId: DeviceId;
  kind: AccountDeviceKind;
  label: string;
  publicKey: DevicePublicKey;
}

export interface AccountBootstrapRequest {
  authentication: ExternalAuthenticationFacts;
  idempotency: IdempotencyRequest;
  initialWorkspaceName?: string;
  device?: DeviceRegistrationRequest;
}

export type AccountBootstrapResult =
  | {
      status: "created" | "existing";
      internalUser: InternalUserRecord;
      identityLink: ExternalIdentityLinkRecord;
      initialWorkspace: WorkspaceRecord;
      ownerMembership: WorkspaceMembershipRecord;
      device?: AccountDeviceRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      code: "identity-link-conflict" | "idempotency-conflict";
      idempotencyKey: string;
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      error: FailClosedAuthorizationError;
    };

export interface CreateWorkspaceInvitationRequest {
  workspaceId: WorkspaceId;
  role: WorkspaceRole;
  recipientConstraint: InvitationRecipientConstraint;
  expiresAt: IsoDateTime;
  idempotency: IdempotencyRequest;
  authorization: MembershipAuthorizationContext;
}

export type CreateWorkspaceInvitationResult =
  | {
      status: "accepted";
      invitation: WorkspaceInvitationRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      currentInvitation?: WorkspaceInvitationRecord;
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      error: FailClosedAuthorizationError;
    };

export interface InvitationRecipientEvidence {
  internalUserId: InternalUserId;
  matchedConstraint: InvitationRecipientConstraint;
  verifiedAt: IsoDateTime;
}

export interface InvitationPresentationProof {
  invitationId: InvitationId;
  proofRef: string;
  verifiedAt: IsoDateTime;
}

export interface AcceptWorkspaceInvitationRequest {
  invitationId: InvitationId;
  /** The bearer credential is consumed before this secret-free proof is created. */
  presentationProof: InvitationPresentationProof;
  authentication: ExternalAuthenticationFacts;
  recipientEvidence: InvitationRecipientEvidence;
  idempotency: IdempotencyRequest;
}

export type AcceptWorkspaceInvitationResult =
  | {
      status: "accepted";
      invitation: WorkspaceInvitationRecord;
      membership: WorkspaceMembershipRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      invitationStatus?: InvitationStatus;
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      error: FailClosedAuthorizationError;
    };

export interface RevokeWorkspaceInvitationRequest {
  workspaceId: WorkspaceId;
  invitationId: InvitationId;
  idempotency: IdempotencyRequest;
  authorization: MembershipAuthorizationContext;
}

export type RevokeWorkspaceInvitationResult =
  | {
      status: "accepted";
      invitation: WorkspaceInvitationRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      invitationStatus?: InvitationStatus;
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      error: FailClosedAuthorizationError;
    };

export type LastOwnerSafetyResult =
  | {
      status: "safe";
      remainingActiveOwnerCount: number;
    }
  | {
      status: "blocked";
      remainingActiveOwnerCount: 0;
      error: FailClosedAuthorizationError & { code: "last-active-owner" };
    };

export interface ChangeMemberRoleRequest {
  action: "change-role";
  workspaceId: WorkspaceId;
  memberId: MemberId;
  role: WorkspaceRole;
  baseRevision: Revision;
  idempotency: IdempotencyRequest;
  authorization: MembershipAuthorizationContext;
}

export interface ChangeMemberStatusRequest {
  action: "suspend" | "reactivate" | "remove";
  workspaceId: WorkspaceId;
  memberId: MemberId;
  baseRevision: Revision;
  idempotency: IdempotencyRequest;
  authorization: MembershipAuthorizationContext;
}

export type MemberLifecycleRequest = ChangeMemberRoleRequest | ChangeMemberStatusRequest;

export type MemberLifecycleResult =
  | {
      status: "accepted";
      membership: WorkspaceMembershipRecord;
      lastOwnerSafety: Extract<LastOwnerSafetyResult, { status: "safe" }>;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      currentMembership?: WorkspaceMembershipRecord;
      lastOwnerSafety?: LastOwnerSafetyResult;
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      lastOwnerSafety?: LastOwnerSafetyResult;
      error: FailClosedAuthorizationError;
    };

export interface WorkspaceSwitchRequest {
  targetWorkspaceId: WorkspaceId;
  deviceId?: DeviceId;
  authentication: ExternalAuthenticationFacts;
}

export type WorkspaceSwitchResult =
  | {
      status: "selected";
      workspace: WorkspaceRecord;
      membership: WorkspaceMembershipRecord;
      authorization: MembershipAuthorizationContext;
    }
  | {
      status: "rejected";
      clearRememberedSelection: boolean;
      error: FailClosedAuthorizationError;
    };

export interface RegisterAccountDeviceRequest {
  registration: DeviceRegistrationRequest;
  authentication: ExternalAuthenticationFacts;
  idempotency: IdempotencyRequest;
}

export type RegisterAccountDeviceResult =
  | {
      status: "accepted";
      device: AccountDeviceRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict";
      error: FailClosedAuthorizationError;
    }
  | {
      status: "rejected";
      error: FailClosedAuthorizationError;
    };

export interface RevokeAccountDeviceRequest {
  deviceId: DeviceId;
  authentication: ExternalAuthenticationFacts;
  idempotency: IdempotencyRequest;
}

export type RevokeAccountDeviceResult =
  | {
      status: "accepted";
      device: AccountDeviceRecord;
      idempotency: IdempotencyReceipt;
    }
  | {
      status: "conflict" | "rejected";
      error: FailClosedAuthorizationError;
    };
