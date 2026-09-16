declare const mivletIdBrand: unique symbol;

/**
 * Version of the portable product-spine vocabulary. This advances only when a
 * canonical wire contract changes; storage migrations have their own versions.
 */
export const PRODUCT_SPINE_CONTRACT_VERSION = "3.0.0" as const;

/** Initial schema shape for records governed by the product spine. */
export const PRODUCT_SPINE_SCHEMA_VERSION = 1 as const;

export type MivletId<Kind extends string> = string & {
  readonly [mivletIdBrand]: Kind;
};

export type InternalUserId = MivletId<"internal-user">;
export type ExternalIdentityId = MivletId<"external-identity">;
export type WorkspaceId = MivletId<"workspace">;
export type MemberId = MivletId<"member">;
export type InvitationId = MivletId<"invitation">;
export type RoleId = MivletId<"role">;
export type DeviceId = MivletId<"device">;
export type ExecutionNodeId = MivletId<"execution-node">;
export type ThreadId = MivletId<"thread">;
export type MessageId = MivletId<"message">;
export type MessageRevisionId = MivletId<"message-revision">;
export type ConversationTombstoneId = MivletId<"conversation-tombstone">;
export type ConnectionId = MivletId<"connection">;
export type ProviderRouteId = MivletId<"provider-route">;
export type CapabilityId = MivletId<"capability">;
export type CapabilityGrantId = MivletId<"capability-grant">;
export type RunId = MivletId<"run">;

export type IsoDateTime = string;
export type SchemaVersion = number;
export type Revision = number;

export type RecordVisibility = "member-private" | "workspace-shared";
export type RecordAuthority = "local" | "convex";

export interface WorkspaceScoped {
  workspaceId: WorkspaceId;
}

export interface MemberPrivateScope {
  visibility: "member-private";
  ownerMemberId: MemberId;
}

export interface WorkspaceSharedScope {
  visibility: "workspace-shared";
  ownerMemberId?: never;
}

export type RecordScope = MemberPrivateScope | WorkspaceSharedScope;

export interface RecordMetadata extends WorkspaceScoped {
  authority: RecordAuthority;
  schemaVersion: SchemaVersion;
  revision: Revision;
  createdByInternalUserId: InternalUserId;
  createdByDeviceId?: DeviceId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt?: IsoDateTime;
}

export type ScopedRecordMetadata = RecordMetadata & RecordScope;
