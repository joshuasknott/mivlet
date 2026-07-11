import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireActiveMembership, requireFableUser, requireRole } from "./authorization";
import {
  configuredInvitationRecipientKeyring,
  hashInvitationEmail,
  hashInvitationEmailForRetainedVersions,
  InvitationRecipientUnavailableError,
} from "./invitationRecipient";
import {
  CloudPolicyError,
  canonicalInvitation,
  canonicalMembership,
  ensureInvitationTarget,
  ensureMemberManagement,
  ensureMemberMutation,
  ensureNotLastOwner,
  ensureRoleAssignment,
  projectMemberManagement,
  resolveMemberTransition,
  type LifecycleOutcome,
} from "./cloudPolicy";

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("editor"), v.literal("viewer"));
const action = v.union(v.literal("change-role"), v.literal("suspend"), v.literal("reactivate"), v.literal("remove"));
const SCHEMA_VERSION = 1;
const MAX_ROSTER_MEMBERS = 500;
const MAX_PENDING_INVITATIONS = 500;
const PROFILE_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFIED_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function fingerprint(value: unknown) { return JSON.stringify(value); }
function error(code: string, message = "The requested membership operation is unavailable.", details: Record<string, unknown> = {}) {
  const status = (["conflict", "stale-revision", "idempotency-conflict", "invitation-expired", "invitation-already-consumed"].includes(code) ? "conflict" : "rejected") as Exclude<LifecycleOutcome, "accepted">;
  return { status, ...details, error: { type: "authorization-error" as const, code, message, retryable: code === "stale-revision" || code === "conflict", disclosure: "opaque" as const } };
}
function invitationRecord(invitation: any) {
  if (invitation.recipientKind === "verified-identity-attribute") {
    return {
      authority: "convex" as const, schemaVersion: SCHEMA_VERSION, revision: invitation.status === "pending" ? 1 : 2,
      workspaceId: invitation.workspaceId, invitationId: invitation.invitationId, status: invitation.status, role: invitation.role,
      inviterMemberId: invitation.inviterMemberId,
      recipientConstraint: {
        kind: "verified-identity-attribute" as const, attributeKind: invitation.recipientAttributeKind,
        hashVersion: invitation.recipientAttributeHashVersion, normalizedValueHash: invitation.recipientAttributeHash,
        ...(invitation.recipientDisplayHint ? { displayHint: invitation.recipientDisplayHint } : {}),
      },
      expiresAt: new Date(invitation.expiresAt).toISOString(),
      ...(invitation.acceptedByInternalUserId ? { acceptedByInternalUserId: invitation.acceptedByInternalUserId } : {}),
      ...(invitation.acceptedMembershipId ? { acceptedMembershipId: invitation.acceptedMembershipId } : {}),
      ...(invitation.acceptedAt === undefined ? {} : { acceptedAt: new Date(invitation.acceptedAt).toISOString() }),
      ...(invitation.revokedByMemberId ? { revokedByMemberId: invitation.revokedByMemberId } : {}),
      ...(invitation.revokedAt === undefined ? {} : { revokedAt: new Date(invitation.revokedAt).toISOString() }),
      createdByInternalUserId: invitation.createdByInternalUserId, createdAt: new Date(invitation.createdAt).toISOString(), updatedAt: new Date(invitation.updatedAt).toISOString(),
    };
  }
  return canonicalInvitation({
    ...invitation,
    recipientInternalUserId: invitation.recipientInternalUserId ?? "",
    createdByInternalUserId: invitation.createdByInternalUserId ?? invitation.inviterMemberId,
  });
}
function pendingInvitationProjection(invitation: any, workspaceName: string) {
  return {
    invitation: {
      invitationId: invitation.invitationId,
      workspaceId: invitation.workspaceId,
      status: "pending" as const,
      role: invitation.role,
      expiresAt: new Date(invitation.expiresAt).toISOString(),
      ...(invitation.recipientDisplayHint ? { displayHint: invitation.recipientDisplayHint } : {}),
    },
    selection: { kind: "direct-inbox" as const, invitationId: invitation.invitationId },
    workspaceName,
  };
}
function invitationRolesFor(role: string) {
  return role === "owner" ? ["owner", "admin", "editor", "viewer"] : role === "admin" ? ["admin", "editor", "viewer"] : [];
}
function invitationManagementFor(role: string) {
  const allowedRoles = invitationRolesFor(role);
  try {
    configuredInvitationRecipientKeyring();
    return { available: allowedRoles.length > 0, allowedRoles, message: allowedRoles.length ? "Invite someone by their verified email." : "Only workspace owners and admins can invite people." };
  } catch {
    return { available: false, allowedRoles: [], message: "Invites aren't available in this build yet." };
  }
}
function membershipRecord(membership: any) { return canonicalMembership(membership); }
async function uniqueByIndex(ctx: any, table: string, index: string, build: (q: any) => any) {
  const records = await ctx.db.query(table).withIndex(index, build).collect();
  if (records.length > 1) throw new CloudPolicyError("conflict", "The requested record is ambiguous.", true);
  return records[0];
}
async function replay(ctx: any, actorInternalUserId: string, idempotencyKey: string, operation: string, intentFingerprint: string) {
  const receipts = await ctx.db.query("membership_lifecycle_idempotency").withIndex("by_actor_key", (q: any) => q.eq("actorInternalUserId", actorInternalUserId).eq("idempotencyKey", idempotencyKey)).collect();
  if (receipts.length > 1) return error("idempotency-conflict");
  const receipt = receipts[0];
  if (!receipt) return undefined;
  if (receipt.operation !== operation || receipt.intentFingerprint !== intentFingerprint) return error("idempotency-conflict");
  return receipt.result.status === "accepted" ? { ...receipt.result, idempotency: { ...receipt.result.idempotency, replayed: true } } : receipt.result;
}
async function opaqueSessionRef(value: string | undefined) {
  if (!value) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `session:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function derivedAttribution(ctx: any, workspaceId: string, actorMemberId?: string) {
  const identity = await ctx.auth.getUserIdentity();
  const sessionRef = await opaqueSessionRef(typeof identity?.tokenIdentifier === "string" ? identity.tokenIdentifier : undefined);
  if (!actorMemberId) return { sessionRef };
  const links = (await ctx.db.query("workspace_device_links").withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId)).collect()).filter((link: any) => link.memberId === actorMemberId && link.status === "active");
  return { sessionRef, deviceId: links.length === 1 ? links[0].deviceId : undefined };
}
async function store(ctx: any, input: {
  actorInternalUserId: string; actorMemberId?: string; workspaceId?: string; targetMemberId?: string; invitationId?: string;
  idempotencyKey: string; operation: string; intentFingerprint: string; result: any; now: number;
}) {
  const result = input.result.status === "accepted"
    ? { ...input.result, idempotency: { key: input.idempotencyKey, replayed: false, recordedAt: new Date(input.now).toISOString() } }
    : input.result;
  await ctx.db.insert("membership_lifecycle_idempotency", { actorInternalUserId: input.actorInternalUserId, idempotencyKey: input.idempotencyKey, operation: input.operation, intentFingerprint: input.intentFingerprint, result, createdAt: input.now });
  if (input.workspaceId) {
    const attribution = await derivedAttribution(ctx, input.workspaceId, input.actorMemberId);
    await ctx.db.insert("membership_lifecycle_audit", {
      workspaceId: input.workspaceId, actorInternalUserId: input.actorInternalUserId, actorMemberId: input.actorMemberId,
      targetMemberId: input.targetMemberId, invitationId: input.invitationId, operation: input.operation, outcome: result.status,
      code: result.status === "accepted" ? undefined : result.error.code, deviceId: attribution.deviceId, sessionRef: attribution.sessionRef, createdAt: input.now,
    });
  }
  return result;
}
async function normalizePendingInvitation(ctx: any, invitation: any, now: number, persist: boolean) {
  if (invitation.status !== "pending" || invitation.expiresAt > now) return invitation;
  if (persist) await ctx.db.patch(invitation._id, { status: "expired", updatedAt: now });
  return { ...invitation, status: "expired", updatedAt: now };
}
async function allocateInvitationId(ctx: any) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const invitationId = `invitation_${crypto.randomUUID()}`;
    const matches = await ctx.db.query("workspace_invitations").withIndex("by_invitation", (q: any) => q.eq("invitationId", invitationId)).collect();
    if (matches.length === 0) return invitationId;
  }
  throw new CloudPolicyError("conflict", "An unambiguous invitation reference could not be allocated.", true);
}

export const list = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    await requireActiveMembership(ctx, args.workspaceId);
    const memberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect();
    return memberships.map(membershipRecord).sort((left: any, right: any) => left.memberId.localeCompare(right.memberId));
  },
});

export const listWorkspaceInvitations = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now();
    const invitations = await ctx.db.query("workspace_invitations").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect();
    return invitations.map((entry: any) => invitationRecord(entry.status === "pending" && entry.expiresAt <= now ? { ...entry, status: "expired", updatedAt: now } : entry)).sort((a: any, b: any) => a.invitationId.localeCompare(b.invitationId));
  },
});

export const listRecipientPending = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const { user, verifiedEmail } = await requireFableUser(ctx); const now = Date.now();
    const invitations = await ctx.db.query("workspace_invitations").withIndex("by_recipient", (q: any) => q.eq("recipientInternalUserId", user.internalUserId)).collect();
    if (verifiedEmail) {
      try {
        const hashes = await hashInvitationEmailForRetainedVersions(verifiedEmail, configuredInvitationRecipientKeyring());
        for (const hash of hashes) {
          invitations.push(...await ctx.db.query("workspace_invitations").withIndex("by_recipient_attribute", (q: any) => q.eq("recipientAttributeKind", hash.attributeKind).eq("recipientAttributeHashVersion", hash.hashVersion).eq("recipientAttributeHash", hash.normalizedValueHash)).collect());
        }
      } catch { /* Direct internal-user invitations remain available without verified-email configuration. */ }
    }
    const pending = Array.from(new Map(invitations.map((entry: any) => [entry.invitationId, entry])).values())
      .filter((entry: any) => entry.status === "pending" && entry.expiresAt > now);
    if (pending.length > MAX_PENDING_INVITATIONS) throw new CloudPolicyError("conflict", "The invitation inbox is unavailable.", true);
    const result = [];
    for (const entry of pending) {
      const workspace = await uniqueByIndex(ctx, "workspaces", "by_workspace", (q: any) => q.eq("workspaceId", entry.workspaceId));
      if (!workspace || workspace.status !== "active" || typeof workspace.name !== "string" || !workspace.name.trim() || workspace.name.length > 160) continue;
      result.push(pendingInvitationProjection(entry, workspace.name));
    }
    return result.sort((a: any, b: any) => a.invitation.invitationId.localeCompare(b.invitation.invitationId));
  },
});

/** Bounded, display-only member roster. Cached profile data never grants access. */
export const listRoster = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId);
    const memberships = (await ctx.db.query("workspace_memberships").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect())
      .filter((membership: any) => membership.status === "active" || membership.status === "suspended");
    if (memberships.length > MAX_ROSTER_MEMBERS) throw new CloudPolicyError("conflict", "The workspace member list is unavailable.", true);
    const now = Date.now();
    const members = [];
    for (const membership of memberships.sort((left: any, right: any) => left.memberId.localeCompare(right.memberId))) {
      const users = await ctx.db.query("internal_users").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", membership.internalUserId)).collect();
      if (users.length !== 1) throw new CloudPolicyError("conflict", "The workspace member list is unavailable.", true);
      if (users[0].status !== "active") continue;
      const profileFresh = typeof users[0].profileObservedAt === "number" && now - users[0].profileObservedAt <= PROFILE_FRESHNESS_MS;
      members.push({
        memberId: membership.memberId,
        role: membership.role,
        status: membership.status,
        revision: membership.revision,
        ...(profileFresh && users[0].profile ? users[0].profile : {}),
        isCurrentUser: membership.internalUserId === authz.user.internalUserId,
        management: projectMemberManagement({ memberships }, authz.membership, membership),
      });
    }
    return { workspaceId: args.workspaceId, actorRole: authz.membership.role, invitationManagement: invitationManagementFor(authz.membership.role), members };
  },
});

export const normalizeExpiredInvitations = mutationGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now(); let normalized = 0;
    const invitations = await ctx.db.query("workspace_invitations").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect();
    for (const invitation of invitations) if (invitation.status === "pending" && invitation.expiresAt <= now) { await normalizePendingInvitation(ctx, invitation, now, true); normalized += 1; }
    return { workspaceId: args.workspaceId, normalized };
  },
});

export const createInvitation = mutationGeneric({
  args: { workspaceId: v.string(), role, recipientInternalUserId: v.string(), expiresAt: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now();
    const intentFingerprint = fingerprint(["invitation.create", args.workspaceId, args.role, args.recipientInternalUserId, args.expiresAt]);
    const prior = await replay(ctx, authz.user.internalUserId, args.idempotencyKey, "invitation.create", intentFingerprint); if (prior) return prior;
    let result: any; let invitationId: string | undefined;
    try {
      ensureRoleAssignment(authz.membership.role, args.role); if (args.expiresAt <= now) throw new CloudPolicyError("invitation-expired", "Invitation expiry must be in the future.");
      const recipient = await uniqueByIndex(ctx, "internal_users", "by_internal_user", (q) => q.eq("internalUserId", args.recipientInternalUserId));
      const memberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", args.workspaceId).eq("internalUserId", args.recipientInternalUserId)).collect(); if (memberships.length > 1) throw new CloudPolicyError("conflict", "The invitation target is unavailable.", true);
      const invitations = await ctx.db.query("workspace_invitations").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect();
      for (const entry of invitations) await normalizePendingInvitation(ctx, entry, now, true);
      const duplicate = invitations.some((entry: any) => entry.recipientInternalUserId === args.recipientInternalUserId && entry.status === "pending" && entry.expiresAt > now); ensureInvitationTarget(recipient?.status, duplicate, memberships[0]?.status); if (memberships[0]) ensureMemberManagement(authz.membership.role, memberships[0].role, args.role);
      invitationId = await allocateInvitationId(ctx);
      const invitation = { invitationId, workspaceId: args.workspaceId, role: args.role, inviterMemberId: authz.membership.memberId, recipientKind: "internal-user" as const, recipientInternalUserId: args.recipientInternalUserId, status: "pending" as const, expiresAt: args.expiresAt, createdAt: now, updatedAt: now, schemaVersion: SCHEMA_VERSION, createdByInternalUserId: authz.user.internalUserId };
      await ctx.db.insert("workspace_invitations", invitation); result = { status: "accepted", invitation: invitationRecord(invitation) };
    } catch (caught) { result = caught instanceof CloudPolicyError ? error(caught.code, caught.message) : error("conflict"); }
    return store(ctx, { actorInternalUserId: authz.user.internalUserId, actorMemberId: authz.membership.memberId, workspaceId: args.workspaceId, invitationId, idempotencyKey: args.idempotencyKey, operation: "invitation.create", intentFingerprint, result, now });
  },
});

/** Public desktop creation path. Raw email is normalized and discarded before any write. */
export const createVerifiedEmailInvitation = mutationGeneric({
  args: { workspaceId: v.string(), role, email: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now();
    let hashes;
    try {
      ensureRoleAssignment(authz.membership.role, args.role);
      hashes = await hashInvitationEmailForRetainedVersions(args.email, configuredInvitationRecipientKeyring());
    } catch (caught) {
      if (caught instanceof CloudPolicyError) return error(caught.code, caught.message);
      return error("invitation-targeting-unavailable", new InvitationRecipientUnavailableError().message);
    }
    const active = hashes[0];
    const expiresAt = now + VERIFIED_INVITATION_LIFETIME_MS;
    const intentFingerprint = fingerprint(["invitation.create-verified-email", args.workspaceId, args.role, active.hashVersion, active.normalizedValueHash]);
    const prior = await replay(ctx, authz.user.internalUserId, args.idempotencyKey, "invitation.create-verified-email", intentFingerprint); if (prior) return prior;
    let result: any; let invitationId: string | undefined;
    try {
      for (const hash of hashes) {
        const matches = await ctx.db.query("workspace_invitations").withIndex("by_workspace_attribute", (q: any) => q.eq("workspaceId", args.workspaceId).eq("recipientAttributeKind", hash.attributeKind).eq("recipientAttributeHashVersion", hash.hashVersion).eq("recipientAttributeHash", hash.normalizedValueHash)).collect();
        if (matches.some((entry: any) => entry.status === "pending" && entry.expiresAt > now)) throw new CloudPolicyError("invitation-unavailable", "The invitation could not be created.", true);
      }
      invitationId = await allocateInvitationId(ctx);
      const invitation = {
        invitationId, workspaceId: args.workspaceId, role: args.role, inviterMemberId: authz.membership.memberId,
        recipientKind: "verified-identity-attribute" as const, recipientAttributeKind: active.attributeKind,
        recipientAttributeHashVersion: active.hashVersion, recipientAttributeHash: active.normalizedValueHash,
        recipientDisplayHint: active.displayHint, status: "pending" as const, expiresAt, createdAt: now, updatedAt: now,
        schemaVersion: SCHEMA_VERSION, createdByInternalUserId: authz.user.internalUserId,
      };
      await ctx.db.insert("workspace_invitations", invitation);
      result = { status: "accepted", invitation: { invitationId, workspaceId: args.workspaceId, status: "pending", role: args.role, expiresAt: new Date(expiresAt).toISOString(), displayHint: active.displayHint } };
    } catch (caught) { result = caught instanceof CloudPolicyError ? error(caught.code, "The invitation could not be created.") : error("conflict"); }
    return store(ctx, { actorInternalUserId: authz.user.internalUserId, actorMemberId: authz.membership.memberId, workspaceId: args.workspaceId, invitationId, idempotencyKey: args.idempotencyKey, operation: "invitation.create-verified-email", intentFingerprint, result, now });
  },
});

export const acceptInvitation = mutationGeneric({
  args: { invitationId: v.string(), presentation: v.object({ kind: v.literal("direct-inbox"), invitationId: v.string() }), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const { user, verifiedEmail } = await requireFableUser(ctx); const now = Date.now(); const intentFingerprint = fingerprint(["invitation.accept", args.invitationId, args.presentation]);
    const prior = await replay(ctx, user.internalUserId, args.idempotencyKey, "invitation.accept", intentFingerprint); if (prior) return prior;
    let result: any; let workspaceId: string | undefined; let targetMemberId: string | undefined;
    try {
      let invitation = await uniqueByIndex(ctx, "workspace_invitations", "by_invitation", (q) => q.eq("invitationId", args.invitationId)); if (!invitation) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true); workspaceId = invitation.workspaceId;
      invitation = await normalizePendingInvitation(ctx, invitation, now, true); if (invitation.status === "expired") throw new CloudPolicyError("invitation-expired", "The invitation is unavailable.", true); if (invitation.status !== "pending") throw new CloudPolicyError("invitation-already-consumed", "The invitation is unavailable.", true);
      if (invitation.recipientKind === "internal-user") {
        if (invitation.recipientInternalUserId !== user.internalUserId) throw new CloudPolicyError("invitation-recipient-mismatch", "The invitation is unavailable.", true);
      } else if (invitation.recipientKind === "verified-identity-attribute") {
        if (!verifiedEmail || invitation.recipientAttributeKind !== "email" || typeof invitation.recipientAttributeHashVersion !== "string" || typeof invitation.recipientAttributeHash !== "string") throw new CloudPolicyError("invitation-recipient-mismatch", "The invitation is unavailable.", true);
        let matched;
        try { matched = await hashInvitationEmail(verifiedEmail, configuredInvitationRecipientKeyring(), invitation.recipientAttributeHashVersion); }
        catch { throw new CloudPolicyError("invitation-targeting-unavailable", "The invitation is unavailable.", true); }
        if (matched.normalizedValueHash !== invitation.recipientAttributeHash) throw new CloudPolicyError("invitation-recipient-mismatch", "The invitation is unavailable.", true);
      } else throw new CloudPolicyError("invitation-recipient-mismatch", "The invitation is unavailable.", true);
      if (args.presentation.kind !== "direct-inbox" || args.presentation.invitationId !== args.invitationId) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true);
      const workspace = await uniqueByIndex(ctx, "workspaces", "by_workspace", (q) => q.eq("workspaceId", invitation.workspaceId)); if (!workspace || workspace.status !== "active") throw new CloudPolicyError("workspace-unavailable", "The invitation is unavailable.", true);
      const memberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", invitation.workspaceId).eq("internalUserId", user.internalUserId)).collect(); if (memberships.length > 1) throw new CloudPolicyError("conflict", "The invitation is unavailable.", true); let membership = memberships[0];
      if (membership && membership.status !== "suspended") throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true);
      if (membership) { await ctx.db.patch(membership._id, { role: invitation.role, status: "active", revision: membership.revision + 1, updatedAt: now, activatedAt: now, suspendedAt: undefined }); membership = { ...membership, role: invitation.role, status: "active", revision: membership.revision + 1, updatedAt: now, activatedAt: now, suspendedAt: undefined }; }
      else { const memberId = `member_${crypto.randomUUID()}`; membership = { memberId, workspaceId: invitation.workspaceId, internalUserId: user.internalUserId, role: invitation.role, status: "active", revision: 1, joinedFromInvitationId: invitation.invitationId, createdAt: now, updatedAt: now, activatedAt: now, schemaVersion: SCHEMA_VERSION, createdByInternalUserId: invitation.createdByInternalUserId ?? user.internalUserId }; await ctx.db.insert("workspace_memberships", membership); }
      targetMemberId = membership.memberId; await ctx.db.patch(invitation._id, { status: "accepted", acceptedByInternalUserId: user.internalUserId, acceptedMembershipId: membership.memberId, acceptedAt: now, updatedAt: now }); invitation = { ...invitation, status: "accepted", acceptedByInternalUserId: user.internalUserId, acceptedMembershipId: membership.memberId, acceptedAt: now, updatedAt: now };
      result = { status: "accepted", invitation: invitationRecord(invitation), membership: membershipRecord(membership) };
    } catch (caught) { result = caught instanceof CloudPolicyError ? error(caught.code, caught.message) : error("conflict"); }
    return store(ctx, { actorInternalUserId: user.internalUserId, actorMemberId: targetMemberId, workspaceId, targetMemberId, invitationId: args.invitationId, idempotencyKey: args.idempotencyKey, operation: "invitation.accept", intentFingerprint, result, now });
  },
});

export const revokeInvitation = mutationGeneric({
  args: { workspaceId: v.string(), invitationId: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now(); const intentFingerprint = fingerprint(["invitation.revoke", args.workspaceId, args.invitationId]);
    const prior = await replay(ctx, authz.user.internalUserId, args.idempotencyKey, "invitation.revoke", intentFingerprint); if (prior) return prior; let result: any;
    try { let invitation = await uniqueByIndex(ctx, "workspace_invitations", "by_invitation", (q) => q.eq("invitationId", args.invitationId)); if (!invitation || invitation.workspaceId !== args.workspaceId) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true); invitation = await normalizePendingInvitation(ctx, invitation, now, true); if (invitation.status !== "pending") throw new CloudPolicyError("invitation-already-consumed", "The invitation is unavailable.", true); await ctx.db.patch(invitation._id, { status: "revoked", revokedByMemberId: authz.membership.memberId, revokedAt: now, updatedAt: now }); result = { status: "accepted", invitation: invitationRecord({ ...invitation, status: "revoked", revokedByMemberId: authz.membership.memberId, revokedAt: now, updatedAt: now }) }; }
    catch (caught) { result = caught instanceof CloudPolicyError ? error(caught.code, caught.message) : error("conflict"); }
    return store(ctx, { actorInternalUserId: authz.user.internalUserId, actorMemberId: authz.membership.memberId, workspaceId: args.workspaceId, invitationId: args.invitationId, idempotencyKey: args.idempotencyKey, operation: "invitation.revoke", intentFingerprint, result, now });
  },
});

export const change = mutationGeneric({
  args: { workspaceId: v.string(), memberId: v.string(), action, role: v.optional(role), baseRevision: v.number(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveMembership(ctx, args.workspaceId); requireRole(authz.membership.role, ["owner", "admin"]); const now = Date.now(); const intentFingerprint = fingerprint(["membership.change", args.workspaceId, args.memberId, args.action, args.role ?? null, args.baseRevision]);
    const prior = await replay(ctx, authz.user.internalUserId, args.idempotencyKey, "membership.change", intentFingerprint); if (prior) return prior; let result: any; let currentTarget: any;
    try {
      const target = await uniqueByIndex(ctx, "workspace_memberships", "by_member", (q) => q.eq("memberId", args.memberId)); currentTarget = target; if (!target || target.workspaceId !== args.workspaceId) throw new CloudPolicyError("membership-required", "The membership is unavailable.", true); if (target.revision !== args.baseRevision) throw new CloudPolicyError("stale-revision", "The membership revision is stale.", true);
      const nextRole = args.action === "change-role" ? args.role : target.role; if (!nextRole) throw new CloudPolicyError("role-assignment-denied", "The requested role cannot be assigned.", true); ensureMemberMutation(authz.membership, target, args.action, nextRole); const nextStatus = resolveMemberTransition(target.status, args.action);
      const memberships = await ctx.db.query("workspace_memberships").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect(); ensureNotLastOwner({ memberships }, target, nextRole, nextStatus);
      const patch: any = { role: nextRole, status: nextStatus, revision: target.revision + 1, updatedAt: now }; if (args.action === "suspend") patch.suspendedAt = now; if (args.action === "reactivate") { patch.activatedAt = now; patch.suspendedAt = undefined; } if (args.action === "remove") { patch.removedAt = now; patch.suspendedAt = undefined; }
      await ctx.db.patch(target._id, patch); if (args.action === "suspend" || args.action === "remove") { const links = (await ctx.db.query("workspace_device_links").withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId)).collect()).filter((link: any) => link.memberId === target.memberId && link.status !== "revoked"); for (const link of links) await ctx.db.patch(link._id, { status: "revoked", revision: link.revision + 1, revokedAt: now }); }
      const membership = { ...target, ...patch }; const remainingActiveOwnerCount = memberships.filter((entry: any) => entry.memberId !== target.memberId && entry.status === "active" && entry.role === "owner").length + (membership.status === "active" && membership.role === "owner" ? 1 : 0); result = { status: "accepted", membership: membershipRecord(membership), lastOwnerSafety: { status: "safe", remainingActiveOwnerCount } };
    } catch (caught) {
      if (caught instanceof CloudPolicyError) result = error(caught.code, caught.message, {
        ...(currentTarget?.workspaceId === args.workspaceId ? { currentMembership: membershipRecord(currentTarget) } : {}),
        ...(caught.code === "last-active-owner" ? { lastOwnerSafety: { status: "blocked", remainingActiveOwnerCount: 0, error: { type: "authorization-error", code: "last-active-owner", message: caught.message, retryable: false, disclosure: "opaque" } } } : {}),
      });
      else result = error("conflict");
    }
    return store(ctx, { actorInternalUserId: authz.user.internalUserId, actorMemberId: authz.membership.memberId, workspaceId: args.workspaceId, targetMemberId: args.memberId, idempotencyKey: args.idempotencyKey, operation: "membership.change", intentFingerprint, result, now });
  },
});
