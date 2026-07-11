declare const fableIdBrand: unique symbol;

/**
 * Version of the portable product-spine vocabulary. This advances only when a
 * canonical wire contract changes; storage migrations have their own versions.
 */
export const PRODUCT_SPINE_CONTRACT_VERSION = "1.4.0" as const;

/** Initial schema shape for records governed by the product spine. */
export const PRODUCT_SPINE_SCHEMA_VERSION = 1 as const;

export type FableId<Kind extends string> = string & {
  readonly [fableIdBrand]: Kind;
};

export type InternalUserId = FableId<"internal-user">;
export type ExternalIdentityId = FableId<"external-identity">;
export type WorkspaceId = FableId<"workspace">;
export type MemberId = FableId<"member">;
export type InvitationId = FableId<"invitation">;
export type RoleId = FableId<"role">;
export type DeviceId = FableId<"device">;
export type ExecutionNodeId = FableId<"execution-node">;
export type ProjectId = FableId<"project">;
export type ThreadId = FableId<"thread">;
export type MessageId = FableId<"message">;
export type MessageRevisionId = FableId<"message-revision">;
export type ConversationTombstoneId = FableId<"conversation-tombstone">;
export type GoalId = FableId<"goal">;
export type DepartmentId = FableId<"department">;
export type PipelineId = FableId<"pipeline">;
export type ConnectionId = FableId<"connection">;
export type ProviderRouteId = FableId<"provider-route">;
export type CapabilityId = FableId<"capability">;
export type CapabilityGrantId = FableId<"capability-grant">;
export type MissionId = FableId<"mission">;
export type PlanId = FableId<"plan">;
export type PlanRevisionId = FableId<"plan-revision">;
export type WorkerId = FableId<"worker">;
export type RunId = FableId<"run">;
export type RunEventId = FableId<"run-event">;
export type ArtifactId = FableId<"artifact">;
export type ArtifactVersionId = FableId<"artifact-version">;
export type HandoffId = FableId<"handoff">;
export type RoutineId = FableId<"routine">;
export type TriggerId = FableId<"trigger">;

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
