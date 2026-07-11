import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("editor"), v.literal("viewer"));
const membershipStatus = v.union(v.literal("active"), v.literal("suspended"), v.literal("removed"));
const deviceStatus = v.union(v.literal("pending"), v.literal("active"), v.literal("revoked"));
const workspaceStatus = v.union(v.literal("active"), v.literal("locked"), v.literal("pending-deletion"), v.literal("deleted"));
const identityStatus = v.union(v.literal("active"), v.literal("disabled"), v.literal("revoked"));
const invitationStatus = v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked"), v.literal("expired"));
const mutationStatus = v.union(v.literal("accepted"), v.literal("rejected"));
const operation = v.union(v.literal("create"), v.literal("update"), v.literal("delete"));
const sharedProjectSnapshot = v.object({
  id: v.string(), workspaceId: v.string(), authority: v.literal("convex"), visibility: v.literal("workspace-shared"),
  schemaVersion: v.literal(1), revision: v.number(), workspaceRevision: v.number(), createdByInternalUserId: v.string(),
  createdByDeviceId: v.string(), createdAt: v.string(), updatedAt: v.string(), title: v.string(),
  description: v.optional(v.string()), instructions: v.optional(v.string()), lifecycle: v.literal("active")
});
const sharedProjectTombstoneSnapshot = v.object({
  workspaceId: v.string(), recordType: v.literal("project"), recordId: v.string(), revision: v.number(), deletedAt: v.string(),
  actorInternalUserId: v.string(), actorMemberId: v.string(), actorDeviceId: v.string(),
  reasonClass: v.union(v.literal("user-delete"), v.literal("member-removed"), v.literal("workspace-deleted"))
});

/** Fable owns these records. External providers authenticate only. */
export default defineSchema({
  internal_users: defineTable({
    internalUserId: v.string(), status: v.union(v.literal("active"), v.literal("disabled"), v.literal("pending-deletion"), v.literal("deleted")),
    initialWorkspaceId: v.optional(v.string()),
    profile: v.optional(v.object({ displayName: v.optional(v.string()), emailHint: v.optional(v.string()) })),
    profileObservedAt: v.optional(v.number()),
    createdAt: v.number(), updatedAt: v.number(), revision: v.number()
  }).index("by_internal_user", ["internalUserId"]),
  external_identity_links: defineTable({
    externalIdentityId: v.string(), provider: v.string(), normalizedIssuer: v.string(), subject: v.string(), internalUserId: v.string(),
    status: identityStatus, lastValidatedAt: v.number(), createdAt: v.number(), updatedAt: v.number(), revision: v.number()
  }).index("by_external_identity", ["provider", "normalizedIssuer", "subject"]).index("by_internal_user", ["internalUserId"]),
  workspaces: defineTable({
    workspaceId: v.string(), name: v.string(), status: workspaceStatus, revision: v.number(), policyRevision: v.number(),
    sharedHistoryRevision: v.optional(v.number()), createdByInternalUserId: v.string(), createdAt: v.number(), updatedAt: v.number()
  }).index("by_workspace", ["workspaceId"]),
  workspace_memberships: defineTable({
    memberId: v.string(), workspaceId: v.string(), internalUserId: v.string(), role, status: membershipStatus, revision: v.number(),
    joinedFromInvitationId: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(), activatedAt: v.number(),
    suspendedAt: v.optional(v.number()), removedAt: v.optional(v.number()), schemaVersion: v.optional(v.number()), createdByInternalUserId: v.optional(v.string())
  }).index("by_workspace", ["workspaceId"]).index("by_workspace_user", ["workspaceId", "internalUserId"]).index("by_member", ["memberId"]).index("by_internal_user", ["internalUserId"]),
  workspace_invitations: defineTable({
    invitationId: v.string(), workspaceId: v.string(), role, inviterMemberId: v.string(), recipientKind: v.union(v.literal("internal-user"), v.literal("verified-identity-attribute")),
    recipientInternalUserId: v.optional(v.string()), recipientAttributeKind: v.optional(v.union(v.literal("email"), v.literal("phone"))), recipientAttributeHashVersion: v.optional(v.string()), recipientAttributeHash: v.optional(v.string()), recipientDisplayHint: v.optional(v.string()),
    status: invitationStatus, expiresAt: v.number(), presentationRef: v.optional(v.string()), acceptedByInternalUserId: v.optional(v.string()), acceptedMembershipId: v.optional(v.string()),
    acceptedAt: v.optional(v.number()), revokedByMemberId: v.optional(v.string()), revokedAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number(),
    schemaVersion: v.optional(v.number()), createdByInternalUserId: v.optional(v.string())
  }).index("by_invitation", ["invitationId"]).index("by_workspace", ["workspaceId"]).index("by_recipient", ["recipientInternalUserId"])
    .index("by_recipient_attribute", ["recipientAttributeKind", "recipientAttributeHashVersion", "recipientAttributeHash"])
    .index("by_workspace_attribute", ["workspaceId", "recipientAttributeKind", "recipientAttributeHashVersion", "recipientAttributeHash"]),
  membership_lifecycle_idempotency: defineTable({
    actorInternalUserId: v.string(), idempotencyKey: v.string(), operation: v.string(), intentFingerprint: v.string(), result: v.any(), createdAt: v.number()
  }).index("by_actor_key", ["actorInternalUserId", "idempotencyKey"]),
  membership_lifecycle_audit: defineTable({
    workspaceId: v.string(), actorInternalUserId: v.string(), actorMemberId: v.optional(v.string()), targetMemberId: v.optional(v.string()), invitationId: v.optional(v.string()),
    operation: v.string(), outcome: v.union(v.literal("accepted"), v.literal("rejected"), v.literal("conflict")), code: v.optional(v.string()),
    deviceId: v.optional(v.string()), sessionRef: v.optional(v.string()), createdAt: v.number()
  }).index("by_workspace", ["workspaceId"]),
  account_devices: defineTable({
    deviceId: v.string(), internalUserId: v.string(), kind: v.union(v.literal("desktop"), v.literal("mobile"), v.literal("web")), label: v.string(), publicKey: v.string(),
    status: deviceStatus, revision: v.number(), registeredAt: v.number(), lastSeenAt: v.number(), revokedAt: v.optional(v.number())
  }).index("by_device", ["deviceId"]).index("by_internal_user", ["internalUserId"]),
  workspace_device_links: defineTable({
    workspaceId: v.string(), deviceId: v.string(), internalUserId: v.string(), memberId: v.string(), status: deviceStatus, revision: v.number(), linkedAt: v.number(), revokedAt: v.optional(v.number())
  }).index("by_workspace_device", ["workspaceId", "deviceId"]).index("by_workspace", ["workspaceId"]).index("by_device", ["deviceId"]),
  bootstrap_idempotency: defineTable({
    provider: v.string(), normalizedIssuer: v.string(), subject: v.string(), idempotencyKey: v.string(), fingerprint: v.string(), result: v.any(), createdAt: v.number()
  }).index("by_identity_key", ["provider", "normalizedIssuer", "subject", "idempotencyKey"]),
  workspace_creation_idempotency: defineTable({
    internalUserId: v.string(), idempotencyKey: v.string(), fingerprint: v.string(), result: v.any(), createdAt: v.number()
  }).index("by_user_key", ["internalUserId", "idempotencyKey"]),
  shared_projects: defineTable({
    workspaceId: v.string(), projectId: v.string(), name: v.string(), description: v.optional(v.string()), instructions: v.optional(v.string()), revision: v.number(), createdByInternalUserId: v.string(), createdByDeviceId: v.string(), createdAt: v.number(), updatedAt: v.number(), deletedAt: v.optional(v.number())
  }).index("by_workspace", ["workspaceId"]).index("by_workspace_record", ["workspaceId", "projectId"]).index("by_workspace_revision", ["workspaceId", "revision"]),
  tombstones: defineTable({
    workspaceId: v.string(), recordType: v.literal("project"), recordId: v.string(), revision: v.number(), deletedAt: v.number(), actorInternalUserId: v.string(), actorMemberId: v.optional(v.string()), actorDeviceId: v.string(), reasonClass: v.string()
  }).index("by_workspace_revision", ["workspaceId", "revision"]).index("by_record", ["workspaceId", "recordType", "recordId"]),
  shared_record_changes: defineTable({
    workspaceId: v.string(), revision: v.number(), recordType: v.literal("project"), recordId: v.string(),
    change: v.union(
      v.object({ kind: v.literal("record"), record: sharedProjectSnapshot }),
      v.object({ kind: v.literal("tombstone"), tombstone: sharedProjectTombstoneSnapshot })
    ),
    createdAt: v.number()
  }).index("by_workspace_revision", ["workspaceId", "revision"]),
  idempotency_keys: defineTable({
    workspaceId: v.string(), deviceId: v.string(), clientMutationId: v.string(), idempotencyKey: v.string(), intentFingerprint: v.optional(v.string()), status: mutationStatus, result: v.any(), createdAt: v.number()
  }).index("by_mutation", ["workspaceId", "deviceId", "clientMutationId"]),
  mutation_audit: defineTable({
    workspaceId: v.string(), internalUserId: v.string(), memberId: v.string(), deviceId: v.string(), clientMutationId: v.string(), recordType: v.literal("project"), recordId: v.string(), operation, status: mutationStatus, revision: v.optional(v.number()), createdAt: v.number()
  }).index("by_workspace", ["workspaceId"])
});
