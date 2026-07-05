import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";

export const createOrJoin = mutationGeneric({
  args: {
    workspaceId: v.string(),
    clerkOrgId: v.string(),
    name: v.string(),
    deviceId: v.string(),
    publicKey: v.string()
  },
  handler: async (ctx, args) => {
    const identity = await requireConvexIdentity(ctx);
    if (identity.orgId !== args.clerkOrgId) {
      throw new Error("The Clerk organization does not match the requested workspace.");
    }
    const now = Date.now();
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .first();
    if (!workspace) {
      await ctx.db.insert("workspaces", {
        workspaceId: args.workspaceId,
        clerkOrgId: args.clerkOrgId,
        name: args.name.trim() || "Shared workspace",
        status: "active",
        revision: 0,
        createdAt: now,
        updatedAt: now
      });
      await ctx.db.insert("workspace_memberships", {
        workspaceId: args.workspaceId,
        clerkUserId: identity.subject,
        clerkOrgId: args.clerkOrgId,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now
      });
    } else {
      if (workspace.status !== "active" || workspace.clerkOrgId !== args.clerkOrgId) {
        throw new Error("The shared workspace is unavailable.");
      }
      const membership = await ctx.db
        .query("workspace_memberships")
        .withIndex("by_workspace_user", (q: any) =>
          q.eq("workspaceId", args.workspaceId).eq("clerkUserId", identity.subject)
        )
        .first();
      if (!membership || membership.status !== "active") {
        throw new Error("An active Fable workspace membership is required to join.");
      }
    }

    const device = await ctx.db
      .query("devices")
      .withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId))
      .first();
    if (device && device.clerkUserId !== identity.subject) {
      throw new Error("This device id is already linked to another user.");
    }
    if (device) {
      await ctx.db.patch(device._id, { status: "active", publicKey: args.publicKey, lastSeenAt: now });
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
    return { workspaceId: args.workspaceId, deviceId: args.deviceId, linked: true };
  }
});
