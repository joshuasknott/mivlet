import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";
import { requireFableUser } from "./authorization";

const device = v.object({ deviceId: v.string(), kind: v.union(v.literal("desktop"), v.literal("mobile"), v.literal("web")), label: v.string(), publicKey: v.string() });
const opaqueId = (kind: string) => `${kind}_${crypto.randomUUID()}`;

/** Idempotently establishes the Fable control plane for a validated external identity. */
export const bootstrapAccount = mutationGeneric({
  args: { idempotencyKey: v.string(), initialWorkspaceName: v.optional(v.string()), device: v.optional(device) },
  handler: async (ctx, args) => {
    const identity = await requireConvexIdentity(ctx);
    const now = Date.now();
    const fingerprint = JSON.stringify({ initialWorkspaceName: args.initialWorkspaceName?.trim() || "Fable workspace", device: args.device });
    const replay = await ctx.db.query("bootstrap_idempotency").withIndex("by_identity_key", (q: any) => q.eq("provider", identity.provider).eq("normalizedIssuer", identity.normalizedIssuer).eq("subject", identity.subject).eq("idempotencyKey", args.idempotencyKey)).first();
    if (replay) { if (replay.fingerprint !== fingerprint) return { status: "conflict", code: "idempotency-conflict" }; return { ...(replay.result as object), idempotency: { key: args.idempotencyKey, replayed: true } }; }
    let link = await ctx.db.query("external_identity_links").withIndex("by_external_identity", (q: any) => q.eq("provider", identity.provider).eq("normalizedIssuer", identity.normalizedIssuer).eq("subject", identity.subject)).first();
    let internalUserId: string; let created = false;
    if (!link) {
      internalUserId = opaqueId("usr"); const externalIdentityId = opaqueId("identity");
      await ctx.db.insert("internal_users", { internalUserId, status: "active", createdAt: now, updatedAt: now, revision: 1 });
      await ctx.db.insert("external_identity_links", { externalIdentityId, provider: identity.provider, normalizedIssuer: identity.normalizedIssuer, subject: identity.subject, internalUserId, status: "active", lastValidatedAt: now, createdAt: now, updatedAt: now, revision: 1 });
      created = true;
    } else { if (link.status !== "active") return { status: "rejected", code: "identity-link-inactive" }; internalUserId = link.internalUserId; await ctx.db.patch(link._id, { lastValidatedAt: now, updatedAt: now, revision: link.revision + 1 }); }
    let membership = await ctx.db.query("workspace_memberships").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", internalUserId)).first();
    let workspace: any;
    if (!membership) {
      const workspaceId = opaqueId("ws"); const memberId = opaqueId("member");
      await ctx.db.insert("workspaces", { workspaceId, name: args.initialWorkspaceName?.trim() || "Fable workspace", status: "active", revision: 0, policyRevision: 1, createdByInternalUserId: internalUserId, createdAt: now, updatedAt: now });
      await ctx.db.insert("workspace_memberships", { memberId, workspaceId, internalUserId, role: "owner", status: "active", revision: 1, createdAt: now, updatedAt: now, activatedAt: now });
      workspace = { workspaceId }; membership = { memberId, workspaceId, role: "owner" };
    } else { workspace = await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", membership.workspaceId)).first(); if (!workspace || workspace.status !== "active") return { status: "rejected", code: "workspace-unavailable" }; }
    let deviceResult: { deviceId: string } | undefined;
    if (args.device) {
      const existing = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", args.device!.deviceId)).first();
      if (existing && existing.internalUserId !== internalUserId) return { status: "conflict", code: "identity-link-conflict" };
      if (existing) await ctx.db.patch(existing._id, { status: "active", label: args.device.label, publicKey: args.device.publicKey, lastSeenAt: now, revision: existing.revision + 1 });
      else await ctx.db.insert("account_devices", { ...args.device, internalUserId, status: "active", revision: 1, registeredAt: now, lastSeenAt: now });
      const deviceLink = await ctx.db.query("workspace_device_links").withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", membership.workspaceId).eq("deviceId", args.device!.deviceId)).first();
      if (deviceLink && (deviceLink.internalUserId !== internalUserId || deviceLink.memberId !== membership.memberId)) return { status: "conflict", code: "identity-link-conflict" };
      if (deviceLink) await ctx.db.patch(deviceLink._id, { status: "active", revision: deviceLink.revision + 1 });
      else await ctx.db.insert("workspace_device_links", { workspaceId: membership.workspaceId, deviceId: args.device.deviceId, internalUserId, memberId: membership.memberId, status: "active", revision: 1, linkedAt: now });
      deviceResult = { deviceId: args.device.deviceId };
    }
    const result = { status: created ? "created" : "existing", internalUserId, workspaceId: membership.workspaceId, memberId: membership.memberId, device: deviceResult, idempotency: { key: args.idempotencyKey, replayed: false } };
    await ctx.db.insert("bootstrap_idempotency", { provider: identity.provider, normalizedIssuer: identity.normalizedIssuer, subject: identity.subject, idempotencyKey: args.idempotencyKey, fingerprint, result, createdAt: now });
    return result;
  }
});

export const listMine = queryGeneric({ args: {}, handler: async (ctx) => { const { user } = await requireFableUser(ctx); const memberships = await ctx.db.query("workspace_memberships").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", user.internalUserId)).collect(); return Promise.all(memberships.filter((x: any) => x.status === "active").map(async (membership: any) => ({ membership, workspace: await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", membership.workspaceId)).first() }))); } });
