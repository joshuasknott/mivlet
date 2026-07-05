import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";
import type { MutationResult } from "./cloudPolicy";

const outboxArgs = {
  workspaceId: v.string(),
  deviceId: v.string(),
  clientMutationId: v.string(),
  idempotencyKey: v.string(),
  baseRevision: v.number(),
  recordType: v.literal("project"),
  recordId: v.string(),
  operation: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
  payload: v.optional(v.object({ name: v.optional(v.string()) }))
};

function rejection(code: string, message: string): MutationResult {
  return { status: "rejected", code, message };
}

export const applyOutboxMutation = mutationGeneric({
  args: outboxArgs,
  handler: async (ctx, args): Promise<MutationResult> => {
    const identity = await requireConvexIdentity(ctx);
    const expectedIdempotencyKey = `${args.workspaceId}:${args.deviceId}:${args.clientMutationId}`;
    if (args.idempotencyKey !== expectedIdempotencyKey) {
      throw new Error("The idempotency key does not match the mutation namespace.");
    }
    const replay = await ctx.db
      .query("idempotency_keys")
      .withIndex("by_mutation", (q: any) =>
        q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId).eq("clientMutationId", args.clientMutationId)
      )
      .first();
    if (replay) {
      return replay.result as MutationResult;
    }

    const now = Date.now();
    const storeResult = async (result: MutationResult) => {
      await ctx.db.insert("idempotency_keys", {
        workspaceId: args.workspaceId,
        deviceId: args.deviceId,
        clientMutationId: args.clientMutationId,
        idempotencyKey: args.idempotencyKey,
        status: result.status,
        result,
        createdAt: now
      });
      await ctx.db.insert("mutation_audit", {
        workspaceId: args.workspaceId,
        deviceId: args.deviceId,
        clientMutationId: args.clientMutationId,
        recordType: args.recordType,
        recordId: args.recordId,
        operation: args.operation,
        status: result.status,
        revision: result.status === "accepted" ? result.revision : undefined,
        createdAt: now
      });
      return result;
    };

    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .first();
    if (!workspace || workspace.status !== "active" || workspace.clerkOrgId !== identity.orgId) {
      return storeResult(rejection("workspace-not-found", "The shared workspace is unavailable."));
    }
    const membership = await ctx.db
      .query("workspace_memberships")
      .withIndex("by_workspace_user", (q: any) =>
        q.eq("workspaceId", args.workspaceId).eq("clerkUserId", identity.subject)
      )
      .first();
    if (!membership || membership.status !== "active") {
      return storeResult(rejection("membership-required", "Active Fable workspace membership is required."));
    }
    if (membership.role === "viewer") {
      return storeResult(rejection("role-denied", "Viewer members cannot write shared workspace records."));
    }
    const device = await ctx.db
      .query("devices")
      .withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId))
      .first();
    if (!device || device.clerkUserId !== identity.subject || device.status !== "active") {
      return storeResult(rejection("device-revoked", "This device is not linked for shared workspace writes."));
    }
    const tombstone = await ctx.db
      .query("tombstones")
      .withIndex("by_record", (q: any) =>
        q.eq("workspaceId", args.workspaceId).eq("recordType", args.recordType).eq("recordId", args.recordId)
      )
      .first();
    if (tombstone && args.operation !== "delete") {
      return storeResult(rejection("tombstoned", "Deleted shared records cannot be resurrected by stale updates."));
    }
    const existing = await ctx.db
      .query("shared_projects")
      .withIndex("by_workspace_record", (q: any) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.recordId))
      .first();
    const revision = workspace.revision + 1;
    let result: MutationResult;
    if (args.operation === "create") {
      if (existing && !existing.deletedAt) {
        return storeResult(rejection("duplicate-record", "The shared project already exists."));
      }
      await ctx.db.insert("shared_projects", {
        workspaceId: args.workspaceId,
        projectId: args.recordId,
        name: args.payload?.name?.trim() || "Untitled project",
        revision,
        createdAt: now,
        updatedAt: now
      });
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    } else if (args.operation === "update") {
      if (!existing || existing.deletedAt) {
        return storeResult(rejection("missing-record", "The shared project is unavailable."));
      }
      if (existing.revision !== args.baseRevision) {
        return storeResult(rejection("stale-revision", "The shared project changed before this mutation was applied."));
      }
      await ctx.db.patch(existing._id, {
        name: args.payload?.name?.trim() || existing.name,
        revision,
        updatedAt: now
      });
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    } else {
      if (!existing || existing.deletedAt) {
        return storeResult(rejection("missing-record", "The shared project is unavailable."));
      }
      await ctx.db.patch(existing._id, { revision, updatedAt: now, deletedAt: now });
      await ctx.db.insert("tombstones", {
        workspaceId: args.workspaceId,
        recordType: args.recordType,
        recordId: args.recordId,
        revision,
        deletedAt: now,
        actorDeviceId: args.deviceId,
        reasonClass: "user-delete"
      });
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    }
    await ctx.db.patch(workspace._id, { revision, updatedAt: now });
    return storeResult(result);
  }
});
