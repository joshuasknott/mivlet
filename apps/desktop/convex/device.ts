import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";

async function requireActiveMember(ctx: any, workspaceId: string) {
  const identity = await requireConvexIdentity(ctx);
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .first();
  if (!workspace || workspace.status !== "active" || identity.orgId !== workspace.clerkOrgId) {
    throw new Error("The shared workspace is unavailable.");
  }
  const membership = await ctx.db
    .query("workspace_memberships")
    .withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", workspaceId).eq("clerkUserId", identity.subject))
    .first();
  if (!membership || membership.status !== "active") {
    throw new Error("Active Fable workspace membership is required.");
  }
  return { identity, membership };
}

export const link = mutationGeneric({
  args: { workspaceId: v.string(), deviceId: v.string(), publicKey: v.string() },
  handler: async (ctx, args) => {
    const { identity } = await requireActiveMember(ctx, args.workspaceId);
    const now = Date.now();
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId))
      .first();
    if (existing && existing.clerkUserId !== identity.subject) {
      throw new Error("This device id is already linked to another user.");
    }
    if (existing) {
      await ctx.db.patch(existing._id, { status: "active", publicKey: args.publicKey, lastSeenAt: now });
    } else {
      await ctx.db.insert("devices", {
        workspaceId: args.workspaceId,
        deviceId: args.deviceId,
        clerkUserId: identity.subject,
        publicKey: args.publicKey,
        status: "active",
        createdAt: now,
        lastSeenAt: now
      });
    }
    return { deviceId: args.deviceId, status: "active" };
  }
});

export const revoke = mutationGeneric({
  args: { workspaceId: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireActiveMember(ctx, args.workspaceId);
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new Error("This role cannot revoke shared workspace devices.");
    }
    const device = await ctx.db
      .query("devices")
      .withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId))
      .first();
    if (!device) {
      throw new Error("The linked device was not found.");
    }
    await ctx.db.patch(device._id, { status: "revoked", lastSeenAt: Date.now() });
    return { deviceId: args.deviceId, status: "revoked" };
  }
});
