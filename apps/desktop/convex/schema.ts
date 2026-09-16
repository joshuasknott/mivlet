import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("editor"),
  v.literal("viewer"),
);
const membershipStatus = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("removed"),
);
const deviceStatus = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("revoked"),
);
const workspaceStatus = v.union(
  v.literal("active"),
  v.literal("locked"),
  v.literal("pending-deletion"),
  v.literal("deleted"),
);

/**
 * Optional hosted-account and hosted-computer records only.
 *
 * Local conversations, providers, knowledge, approvals, and execution attempts
 * never pass through Convex.
 */
export default defineSchema({
  internal_users: defineTable({
    internalUserId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("disabled"),
      v.literal("pending-deletion"),
      v.literal("deleted"),
    ),
    initialWorkspaceId: v.optional(v.string()),
    profile: v.optional(
      v.object({
        displayName: v.optional(v.string()),
        emailHint: v.optional(v.string()),
      }),
    ),
    profileObservedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    revision: v.number(),
  }).index("by_internal_user", ["internalUserId"]),

  external_identity_links: defineTable({
    externalIdentityId: v.string(),
    provider: v.string(),
    normalizedIssuer: v.string(),
    subject: v.string(),
    internalUserId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("disabled"),
      v.literal("revoked"),
    ),
    lastValidatedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    revision: v.number(),
  })
    .index("by_external_identity", ["provider", "normalizedIssuer", "subject"])
    .index("by_internal_user", ["internalUserId"]),

  workspaces: defineTable({
    workspaceId: v.string(),
    name: v.string(),
    status: workspaceStatus,
    revision: v.number(),
    policyRevision: v.number(),
    createdByInternalUserId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  workspace_memberships: defineTable({
    memberId: v.string(),
    workspaceId: v.string(),
    internalUserId: v.string(),
    role,
    status: membershipStatus,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    activatedAt: v.number(),
    suspendedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_user", ["workspaceId", "internalUserId"])
    .index("by_member", ["memberId"])
    .index("by_internal_user", ["internalUserId"]),

  account_devices: defineTable({
    deviceId: v.string(),
    internalUserId: v.string(),
    kind: v.union(
      v.literal("desktop"),
      v.literal("mobile"),
      v.literal("web"),
    ),
    label: v.string(),
    publicKey: v.string(),
    status: deviceStatus,
    revision: v.number(),
    registeredAt: v.number(),
    lastSeenAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_device", ["deviceId"])
    .index("by_internal_user", ["internalUserId"]),

  workspace_device_links: defineTable({
    workspaceId: v.string(),
    deviceId: v.string(),
    internalUserId: v.string(),
    memberId: v.string(),
    status: deviceStatus,
    revision: v.number(),
    linkedAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace_device", ["workspaceId", "deviceId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_device", ["deviceId"]),

  bootstrap_idempotency: defineTable({
    provider: v.string(),
    normalizedIssuer: v.string(),
    subject: v.string(),
    idempotencyKey: v.string(),
    fingerprint: v.string(),
    result: v.any(),
    createdAt: v.number(),
  }).index("by_identity_key", [
    "provider",
    "normalizedIssuer",
    "subject",
    "idempotencyKey",
  ]),

  hosted_execution_nodes: defineTable({
    executionNodeId: v.string(),
    workspaceId: v.string(),
    agentId: v.string(),
    computerId: v.string(),
    locality: v.literal("hosted"),
    status: v.union(
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("degraded"),
      v.literal("destroyed"),
    ),
    runtimeActive: v.boolean(),
    keepAlive: v.boolean(),
    runnerGeneration: v.number(),
    revision: v.number(),
    createdByInternalUserId: v.string(),
    createdByMemberId: v.string(),
    createdByDeviceId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_agent", ["workspaceId", "agentId"])
    .index("by_computer", ["computerId"]),

  execution_capability_mint_windows: defineTable({
    mintKey: v.string(),
    hits: v.array(v.number()),
    updatedAt: v.number(),
  }).index("by_mint_key", ["mintKey"]),

  hosted_execution_requests: defineTable({
    requestKey: v.string(),
    workspaceId: v.string(),
    agentId: v.string(),
    executionNodeId: v.string(),
    computerId: v.string(),
    operation: v.literal("provision"),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    actorInternalUserId: v.string(),
    actorMemberId: v.string(),
    actorDeviceId: v.string(),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request", ["requestKey"])
    .index("by_workspace", ["workspaceId"])
    .index("by_computer_operation_status", ["computerId", "operation", "status"]),
});
