import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexAccountIdentity, type ValidatedDisplayProfile } from "./convexAuth";
import { requireMivletUser } from "./authorization";

const device = v.object({ deviceId: v.string(), kind: v.union(v.literal("desktop"), v.literal("mobile"), v.literal("web")), label: v.string(), publicKey: v.string() });
const opaqueId = (kind: string) => `${kind}_${crypto.randomUUID()}`;
const PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshDisplayProfile(ctx: any, user: any, profile: ValidatedDisplayProfile | undefined, now: number) {
  const changed = JSON.stringify(user.profile ?? null) !== JSON.stringify(profile ?? null);
  const refreshDue = typeof user.profileObservedAt !== "number" || now - user.profileObservedAt >= PROFILE_REFRESH_INTERVAL_MS;
  if (!changed && !refreshDue) return user;
  const patch = { profile, profileObservedAt: now, updatedAt: now, revision: user.revision + 1 };
  await ctx.db.patch(user._id, patch);
  return { ...user, ...patch };
}

function normalizedWorkspaceName(name: string | undefined) {
  const value = name?.trim() || "Mivlet workspace";
  if (value.length > 160) throw new Error("A workspace name must be 160 characters or fewer.");
  return value;
}

/** Idempotently establishes the Mivlet account and exactly one initial owner workspace. */
export const bootstrapAccount = mutationGeneric({
  args: { idempotencyKey: v.string(), initialWorkspaceName: v.optional(v.string()), device: v.optional(device) },
  handler: async (ctx, args) => {
    const accountIdentity = await requireConvexAccountIdentity(ctx);
    const identity = accountIdentity.external;
    const now = Date.now();
    const initialWorkspaceName = normalizedWorkspaceName(args.initialWorkspaceName);
    const fingerprint = JSON.stringify({ initialWorkspaceName, device: args.device });
    const replays = await ctx.db.query("bootstrap_idempotency").withIndex("by_identity_key", (q: any) => q.eq("provider", identity.provider).eq("normalizedIssuer", identity.normalizedIssuer).eq("subject", identity.subject).eq("idempotencyKey", args.idempotencyKey)).collect();
    if (replays.length > 1) return { status: "conflict", code: "idempotency-conflict" };
    const replay = replays[0];
    if (replay) {
      if (replay.fingerprint !== fingerprint) return { status: "conflict", code: "idempotency-conflict" };
      const replayLinks = await ctx.db.query("external_identity_links").withIndex("by_external_identity", (q: any) => q.eq("provider", identity.provider).eq("normalizedIssuer", identity.normalizedIssuer).eq("subject", identity.subject)).collect();
      if (replayLinks.length !== 1 || replayLinks[0].status !== "active") return { status: "rejected", code: "identity-link-inactive" };
      const replayUsers = await ctx.db.query("internal_users").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", replayLinks[0].internalUserId)).collect();
      if (replayUsers.length !== 1 || replayUsers[0].status !== "active") return { status: "rejected", code: "internal-user-inactive" };
      const replayResult = replay.result as any;
      if (!replayResult || replayResult.internalUserId !== replayUsers[0].internalUserId || typeof replayResult.workspaceId !== "string" || typeof replayResult.memberId !== "string") return { status: "rejected", code: "workspace-unavailable" };
      const replayWorkspaces = await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", replayResult.workspaceId)).collect();
      const replayMemberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", replayResult.workspaceId).eq("internalUserId", replayUsers[0].internalUserId)).collect();
      if (replayWorkspaces.length !== 1 || replayWorkspaces[0].status !== "active" || replayMemberships.length !== 1 || replayMemberships[0].memberId !== replayResult.memberId || replayMemberships[0].status !== "active") return { status: "rejected", code: "workspace-unavailable" };
      if (replayResult.device) {
        const deviceId = replayResult.device.deviceId;
        if (typeof deviceId !== "string") return { status: "rejected", code: "device-unavailable" };
        const replayDevices = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", deviceId)).collect();
        const replayDeviceLinks = await ctx.db.query("workspace_device_links").withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", replayResult.workspaceId).eq("deviceId", deviceId)).collect();
        if (replayDevices.length !== 1 || replayDevices[0].internalUserId !== replayUsers[0].internalUserId || replayDevices[0].status !== "active" || replayDeviceLinks.length !== 1 || replayDeviceLinks[0].internalUserId !== replayUsers[0].internalUserId || replayDeviceLinks[0].memberId !== replayResult.memberId || replayDeviceLinks[0].status !== "active") return { status: "rejected", code: "device-unavailable" };
      }
      await refreshDisplayProfile(ctx, replayUsers[0], accountIdentity.profile, now);
      return { ...(replay.result as object), idempotency: { key: args.idempotencyKey, replayed: true } };
    }

    const links = await ctx.db.query("external_identity_links").withIndex("by_external_identity", (q: any) => q.eq("provider", identity.provider).eq("normalizedIssuer", identity.normalizedIssuer).eq("subject", identity.subject)).collect();
    if (links.length > 1) return { status: "conflict", code: "identity-link-conflict" };

    let link = links[0];
    let internalUserId: string;
    let user: any;
    let created = false;
    if (!link) {
      internalUserId = opaqueId("usr");
      const profileFields = { ...(accountIdentity.profile ? { profile: accountIdentity.profile } : {}), profileObservedAt: now };
      const userId = await ctx.db.insert("internal_users", { internalUserId, status: "active", ...profileFields, createdAt: now, updatedAt: now, revision: 1 });
      user = { _id: userId, internalUserId, status: "active", revision: 1, ...profileFields };
      await ctx.db.insert("external_identity_links", { externalIdentityId: opaqueId("identity"), provider: identity.provider, normalizedIssuer: identity.normalizedIssuer, subject: identity.subject, internalUserId, status: "active", lastValidatedAt: now, createdAt: now, updatedAt: now, revision: 1 });
      created = true;
    } else {
      if (link.status !== "active") return { status: "rejected", code: "identity-link-inactive" };
      const users = await ctx.db.query("internal_users").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", link!.internalUserId)).collect();
      if (users.length !== 1 || users[0].status !== "active") return { status: "rejected", code: "internal-user-inactive" };
      internalUserId = link.internalUserId;
      user = await refreshDisplayProfile(ctx, users[0], accountIdentity.profile, now);
    }

    let membership: any;
    if (user.initialWorkspaceId) {
      const workspaces = await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", user.initialWorkspaceId)).collect();
      const memberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", user.initialWorkspaceId).eq("internalUserId", internalUserId)).collect();
      if (workspaces.length !== 1 || workspaces[0].status !== "active" || memberships.length !== 1 || memberships[0].status !== "active") return { status: "rejected", code: "workspace-unavailable" };
      membership = memberships[0];
    } else {
      const workspaceId = opaqueId("ws");
      const memberId = opaqueId("member");
      await ctx.db.insert("workspaces", { workspaceId, name: initialWorkspaceName, status: "active", revision: 0, policyRevision: 1, createdByInternalUserId: internalUserId, createdAt: now, updatedAt: now });
      await ctx.db.insert("workspace_memberships", { memberId, workspaceId, internalUserId, role: "owner", status: "active", revision: 1, createdAt: now, updatedAt: now, activatedAt: now });
      await ctx.db.patch(user._id, { initialWorkspaceId: workspaceId, updatedAt: now, revision: user.revision + 1 });
      membership = { memberId, workspaceId, role: "owner", revision: 1 };
    }

    let deviceResult: { deviceId: string } | undefined;
    if (args.device) {
      const devices = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", args.device!.deviceId)).collect();
      if (devices.length > 1 || (devices[0] && devices[0].internalUserId !== internalUserId)) throw new Error("This device is unavailable.");
      const existing = devices[0];
      if (existing?.status === "revoked") throw new Error("This device is unavailable.");
      if (existing) await ctx.db.patch(existing._id, { status: "active", label: args.device.label, publicKey: args.device.publicKey, lastSeenAt: now, revision: existing.revision + 1 });
      else await ctx.db.insert("account_devices", { ...args.device, internalUserId, status: "active", revision: 1, registeredAt: now, lastSeenAt: now });
      const linksForWorkspace = await ctx.db.query("workspace_device_links").withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", membership.workspaceId).eq("deviceId", args.device!.deviceId)).collect();
      if (linksForWorkspace.length > 1 || (linksForWorkspace[0] && (linksForWorkspace[0].internalUserId !== internalUserId || linksForWorkspace[0].memberId !== membership.memberId || linksForWorkspace[0].status !== "active"))) throw new Error("This device is unavailable.");
      if (linksForWorkspace[0]) await ctx.db.patch(linksForWorkspace[0]._id, { revision: linksForWorkspace[0].revision + 1 });
      else await ctx.db.insert("workspace_device_links", { workspaceId: membership.workspaceId, deviceId: args.device.deviceId, internalUserId, memberId: membership.memberId, status: "active", revision: 1, linkedAt: now });
      deviceResult = { deviceId: args.device.deviceId };
    }

    if (!created) await ctx.db.patch(link!._id, { lastValidatedAt: now, updatedAt: now, revision: link!.revision + 1 });
    const result = { status: created ? "created" : "existing", internalUserId, workspaceId: membership.workspaceId, memberId: membership.memberId, device: deviceResult, idempotency: { key: args.idempotencyKey, replayed: false } };
    await ctx.db.insert("bootstrap_idempotency", { provider: identity.provider, normalizedIssuer: identity.normalizedIssuer, subject: identity.subject, idempotencyKey: args.idempotencyKey, fingerprint, result, createdAt: now });
    return result;
  }
});

/** Returns only active, unambiguous Mivlet workspaces available to this account. */
export const listMine = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireMivletUser(ctx);
    const memberships = await ctx.db.query("workspace_memberships").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", user.internalUserId)).collect();
    const activeMemberships = memberships.filter((membership: any) => membership.status === "active");
    const entries = await Promise.all(activeMemberships.map(async (membership: any) => {
      if (memberships.filter((candidate: any) => candidate.workspaceId === membership.workspaceId).length !== 1) return undefined;
      const workspaces = await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", membership.workspaceId)).collect();
      if (workspaces.length !== 1 || workspaces[0].status !== "active") return undefined;
      const workspace = workspaces[0];
      return { workspaceId: workspace.workspaceId, name: workspace.name, revision: workspace.revision, policyRevision: workspace.policyRevision, memberId: membership.memberId, role: membership.role, membershipRevision: membership.revision };
    }));
    return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }
});
