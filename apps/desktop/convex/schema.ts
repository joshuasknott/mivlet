import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("editor"), v.literal("viewer"));
const activeOrRevoked = v.union(v.literal("active"), v.literal("revoked"));
const workspaceStatus = v.union(v.literal("active"), v.literal("disabled"), v.literal("deleted"));
const mutationStatus = v.union(v.literal("accepted"), v.literal("rejected"));
const operation = v.union(v.literal("create"), v.literal("update"), v.literal("delete"));

export default defineSchema({
  workspaces: defineTable({
    workspaceId: v.string(),
    clerkOrgId: v.string(),
    name: v.string(),
    status: workspaceStatus,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number()
  }).index("by_workspace", ["workspaceId"]),

  workspace_memberships: defineTable({
    workspaceId: v.string(),
    clerkUserId: v.string(),
    clerkOrgId: v.string(),
    role,
    status: activeOrRevoked,
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_user", ["workspaceId", "clerkUserId"]),

  devices: defineTable({
    workspaceId: v.string(),
    deviceId: v.string(),
    clerkUserId: v.string(),
    publicKey: v.string(),
    status: activeOrRevoked,
    createdAt: v.number(),
    lastSeenAt: v.number()
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_device", ["workspaceId", "deviceId"])
    .index("by_user", ["clerkUserId"]),

  shared_projects: defineTable({
    workspaceId: v.string(),
    projectId: v.string(),
    name: v.string(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number())
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_record", ["workspaceId", "projectId"])
    .index("by_workspace_revision", ["workspaceId", "revision"]),

  tombstones: defineTable({
    workspaceId: v.string(),
    recordType: v.string(),
    recordId: v.string(),
    revision: v.number(),
    deletedAt: v.number(),
    actorDeviceId: v.string(),
    reasonClass: v.string()
  })
    .index("by_workspace_revision", ["workspaceId", "revision"])
    .index("by_record", ["workspaceId", "recordType", "recordId"]),

  idempotency_keys: defineTable({
    workspaceId: v.string(),
    deviceId: v.string(),
    clientMutationId: v.string(),
    idempotencyKey: v.string(),
    status: mutationStatus,
    result: v.any(),
    createdAt: v.number()
  })
    .index("by_mutation", ["workspaceId", "deviceId", "clientMutationId"])
    .index("by_key", ["idempotencyKey"]),

  mutation_audit: defineTable({
    workspaceId: v.string(),
    deviceId: v.string(),
    clientMutationId: v.string(),
    recordType: v.string(),
    recordId: v.string(),
    operation,
    status: mutationStatus,
    revision: v.optional(v.number()),
    createdAt: v.number()
  }).index("by_workspace", ["workspaceId"])
});
