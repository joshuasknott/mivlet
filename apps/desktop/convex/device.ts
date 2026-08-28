import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireActiveMembership, requireFableUser } from "./authorization";

const kind = v.union(v.literal("desktop"), v.literal("mobile"), v.literal("web"));

export const link = mutationGeneric({
  args: { workspaceId: v.string(), deviceId: v.string(), kind, label: v.string(), publicKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId);
    const devices = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", args.deviceId)).collect();
    const links = await ctx.db.query("workspace_device_links").withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId)).collect();
    if (devices.length > 1 || links.length > 1) throw new Error("This device is unavailable.");
    const existing = devices[0];
    const linked = links[0];
    if (existing && (existing.internalUserId !== authz.user.internalUserId || existing.status !== "active")) {
      throw new Error("This device is unavailable.");
    }
    if (linked && (linked.internalUserId !== authz.user.internalUserId || linked.memberId !== authz.membership.memberId || linked.status !== "active")) {
      throw new Error("This device is unavailable.");
    }
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { label: args.label, publicKey: args.publicKey, lastSeenAt: now, revision: existing.revision + 1 });
    else await ctx.db.insert("account_devices", { deviceId: args.deviceId, internalUserId: authz.user.internalUserId, kind: args.kind, label: args.label, publicKey: args.publicKey, status: "active", revision: 1, registeredAt: now, lastSeenAt: now });
    if (linked) await ctx.db.patch(linked._id, { revision: linked.revision + 1 });
    else await ctx.db.insert("workspace_device_links", { workspaceId: args.workspaceId, deviceId: args.deviceId, internalUserId: authz.user.internalUserId, memberId: authz.membership.memberId, status: "active", revision: 1, linkedAt: now });
    return { deviceId: args.deviceId, status: "active" };
  }
});

/** Account-scoped device inventory. Public keys and datastore metadata never leave Convex. */
export const listMine = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireFableUser(ctx);
    const devices = await ctx.db.query("account_devices").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", user.internalUserId)).collect();
    return devices.map((device: any) => ({ deviceId: device.deviceId, kind: device.kind, label: device.label, status: device.status, registeredAt: device.registeredAt, lastSeenAt: device.lastSeenAt, ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }) })).sort((left: any, right: any) => left.deviceId.localeCompare(right.deviceId));
  }
});

/** An account holder may revoke only their own device; every matching workspace link is revoked atomically. */
export const revoke = mutationGeneric({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireFableUser(ctx);
    const devices = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", args.deviceId)).collect();
    if (devices.length !== 1 || devices[0].internalUserId !== user.internalUserId) throw new Error("This device is unavailable.");
    const device = devices[0];
    const links = (await ctx.db.query("workspace_device_links").withIndex("by_device", (q: any) => q.eq("deviceId", args.deviceId)).collect()).filter((link: any) => link.internalUserId === user.internalUserId);
    const now = Date.now();
    if (device.status !== "revoked") await ctx.db.patch(device._id, { status: "revoked", revokedAt: now, revision: device.revision + 1 });
    for (const link of links) if (link.status !== "revoked") await ctx.db.patch(link._id, { status: "revoked", revokedAt: now, revision: link.revision + 1 });
    return { deviceId: args.deviceId, status: "revoked", revokedWorkspaceLinks: links.length };
  }
});
