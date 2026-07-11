export type CloudRole = "owner" | "admin" | "editor" | "viewer";
export type CloudRecordType = "project";
export type CloudOperation = "create" | "update" | "delete";
export type MutationResult =
  | { status: "accepted"; revision: number; recordType: CloudRecordType; recordId: string }
  | { status: "rejected"; code: string; message: string };

/** Trusted authentication facts. They identify a principal but grant no workspace access. */
export interface CloudIdentity { provider: "clerk"; normalizedIssuer: string; subject: string; sessionRef?: string }
export interface CloudUser { internalUserId: string; status: "active" | "disabled"; initialWorkspaceId?: string }
export interface CloudIdentityLink { provider: "clerk"; normalizedIssuer: string; subject: string; internalUserId: string; status: "active" | "disabled" | "revoked" }
export interface CloudWorkspace { workspaceId: string; name: string; status: "active" | "locked" | "deleted"; revision: number; policyRevision: number }
export interface CloudMembership { memberId: string; workspaceId: string; internalUserId: string; role: CloudRole; status: "active" | "suspended" | "removed"; revision: number; joinedFromInvitationId?: string; createdAt?: number; updatedAt?: number; activatedAt?: number; suspendedAt?: number; removedAt?: number; createdByInternalUserId?: string }
export interface CloudDevice { deviceId: string; internalUserId: string; kind?: "desktop" | "mobile" | "web"; label?: string; status: "pending" | "active" | "revoked"; registeredAt?: number; lastSeenAt?: number; revokedAt?: number }
export interface CloudDeviceLink { workspaceId: string; deviceId: string; internalUserId: string; memberId: string; status: "pending" | "active" | "revoked"; revokedAt?: number }
export interface CloudProject { workspaceId: string; projectId: string; name: string; revision: number; deletedAt?: number }
export interface CloudTombstone { workspaceId: string; recordType: CloudRecordType; recordId: string; revision: number; deletedAt: number; actorDeviceId: string }
export interface CloudIdempotencyKey { workspaceId: string; deviceId: string; clientMutationId: string; idempotencyKey: string; result: MutationResult }
export interface CloudState { users: CloudUser[]; identityLinks: CloudIdentityLink[]; workspaces: CloudWorkspace[]; memberships: CloudMembership[]; devices: CloudDevice[]; deviceLinks: CloudDeviceLink[]; projects: CloudProject[]; tombstones: CloudTombstone[]; idempotencyKeys: CloudIdempotencyKey[] }
export interface OutboxMutationArgs { workspaceId: string; deviceId: string; clientMutationId: string; idempotencyKey: string; baseRevision: number; recordType: CloudRecordType; recordId: string; operation: CloudOperation; payload?: { name?: string } }
export interface AccessibleWorkspace { workspaceId: string; name: string; revision: number; policyRevision: number; memberId: string; role: CloudRole; membershipRevision: number }
export interface AccountDeviceSummary { deviceId: string; kind: "desktop" | "mobile" | "web"; label: string; status: "pending" | "active" | "revoked"; registeredAt: number; lastSeenAt: number; revokedAt?: number }

const WRITE_ROLES = new Set<CloudRole>(["owner", "admin", "editor"]);
const MANAGE_ROLES = new Set<CloudRole>(["owner", "admin"]);
const ASSIGNABLE: Record<CloudRole, readonly CloudRole[]> = { owner: ["owner", "admin", "editor", "viewer"], admin: ["admin", "editor", "viewer"], editor: [], viewer: [] };

export class CloudPolicyError extends Error { constructor(public readonly code: string, message: string, public readonly opaque = false) { super(message); } }
export function ensureInvitationTarget(recipientStatus: string | undefined, invitationExists: boolean, membershipStatus: string | undefined) {
  if (recipientStatus !== "active" || invitationExists || membershipStatus === "active" || membershipStatus === "removed") throw new CloudPolicyError("invitation-unavailable", "The invitation target is unavailable.", true);
}

export type MemberLifecycleAction = "change-role" | "suspend" | "reactivate" | "remove";
export function resolveMemberTransition(status: CloudMembership["status"], action: MemberLifecycleAction) {
  if (status === "removed") throw new CloudPolicyError("conflict", "The membership transition is unavailable.", true);
  if (action === "change-role") return status;
  if (action === "suspend" && status === "active") return "suspended" as const;
  if (action === "reactivate" && status === "suspended") return "active" as const;
  if (action === "remove" && (status === "active" || status === "suspended")) return "removed" as const;
  throw new CloudPolicyError("conflict", "The membership transition is unavailable.", true);
}
export function ensureDeviceLink(device: { internalUserId: string; status: string } | undefined, link: { internalUserId: string; memberId: string; status: string } | undefined, internalUserId: string, memberId: string) {
  if (device && (device.internalUserId !== internalUserId || device.status !== "active")) throw new CloudPolicyError("device-unavailable", "This device is unavailable.", true);
  if (link && (link.internalUserId !== internalUserId || link.memberId !== memberId || link.status !== "active")) throw new CloudPolicyError("device-unavailable", "This device is unavailable.", true);
}
export function requireIdentity(identity: CloudIdentity | null | undefined): CloudIdentity { if (!identity?.normalizedIssuer || !identity.subject) throw new CloudPolicyError("unauthenticated", "A validated external identity is required."); return identity; }
export function resolveInternalUser(state: Pick<CloudState, "users" | "identityLinks">, identity: CloudIdentity | null | undefined) {
  const external = requireIdentity(identity);
  const links = state.identityLinks.filter((x) => x.provider === external.provider && x.normalizedIssuer === external.normalizedIssuer && x.subject === external.subject);
  if (links.length > 1) throw new CloudPolicyError("identity-link-conflict", "The Fable identity link is ambiguous.", true);
  const link = links[0];
  if (!link) throw new CloudPolicyError("identity-link-not-found", "No Fable identity link is available.", true);
  if (link.status !== "active") throw new CloudPolicyError("identity-link-inactive", "The Fable identity link is unavailable.", true);
  const user = state.users.find((x) => x.internalUserId === link.internalUserId);
  if (!user || user.status !== "active") throw new CloudPolicyError("internal-user-inactive", "The Fable account is unavailable.", true);
  return { external, link, user };
}
export function requireActiveMembership(state: Pick<CloudState, "users" | "identityLinks" | "workspaces" | "memberships">, identity: CloudIdentity | null | undefined, workspaceId: string) {
  const resolved = resolveInternalUser(state, identity);
  const workspace = state.workspaces.find((x) => x.workspaceId === workspaceId);
  if (!workspace || workspace.status !== "active") throw new CloudPolicyError("workspace-unavailable", "The requested workspace is unavailable.", true);
  const membership = state.memberships.find((x) => x.workspaceId === workspaceId && x.internalUserId === resolved.user.internalUserId);
  if (!membership) throw new CloudPolicyError("membership-required", "Active Fable workspace membership is required.", true);
  if (membership.status !== "active") throw new CloudPolicyError("membership-inactive", "Active Fable workspace membership is required.", true);
  return { ...resolved, workspace, membership };
}
export function requireCanRead(state: Pick<CloudState, "users" | "identityLinks" | "workspaces" | "memberships">, identity: CloudIdentity | null | undefined, workspaceId: string) { return requireActiveMembership(state, identity, workspaceId); }
export function requireCanWrite(state: CloudState, identity: CloudIdentity | null | undefined, args: OutboxMutationArgs) {
  const authz = requireActiveMembership(state, identity, args.workspaceId);
  if (!WRITE_ROLES.has(authz.membership.role)) throw new CloudPolicyError("permission-denied", "This role cannot write shared workspace records.", true);
  const device = state.devices.find((x) => x.deviceId === args.deviceId && x.internalUserId === authz.user.internalUserId);
  const link = state.deviceLinks.find((x) => x.workspaceId === args.workspaceId && x.deviceId === args.deviceId && x.internalUserId === authz.user.internalUserId && x.memberId === authz.membership.memberId);
  if (!device || device.status !== "active" || !link || link.status !== "active") throw new CloudPolicyError("device-inactive", "An active Fable device link is required.", true);
  return { ...authz, device, link };
}
export function requireCanManageMembers(state: Pick<CloudState, "users" | "identityLinks" | "workspaces" | "memberships">, identity: CloudIdentity | null | undefined, workspaceId: string) { const authz = requireActiveMembership(state, identity, workspaceId); if (!MANAGE_ROLES.has(authz.membership.role)) throw new CloudPolicyError("permission-denied", "This role cannot manage workspace membership.", true); return authz; }
export function ensureRoleAssignment(actor: CloudRole, next: CloudRole) { if (!ASSIGNABLE[actor].includes(next)) throw new CloudPolicyError("role-assignment-denied", "This role cannot assign the requested role.", true); }
export function ensureMemberManagement(actor: CloudRole, target: CloudRole, next: CloudRole) {
  ensureRoleAssignment(actor, next);
  if (actor === "admin" && target === "owner") throw new CloudPolicyError("role-assignment-denied", "This role cannot manage an owner membership.", true);
}
export function ensureNotLastOwner(state: Pick<CloudState, "memberships">, membership: CloudMembership, nextRole = membership.role, nextStatus = membership.status) { if (membership.role !== "owner" || (nextRole === "owner" && nextStatus === "active")) return; const owners = state.memberships.filter((x) => x.workspaceId === membership.workspaceId && x.status === "active" && x.role === "owner" && x.memberId !== membership.memberId); if (!owners.length) throw new CloudPolicyError("last-active-owner", "A workspace must retain an active owner.", true); }
export function listAccessibleWorkspaces(state: Pick<CloudState, "users" | "identityLinks" | "workspaces" | "memberships">, identity: CloudIdentity | null | undefined): AccessibleWorkspace[] {
  const { user } = resolveInternalUser(state, identity);
  return state.memberships
    .filter((membership) => membership.internalUserId === user.internalUserId && membership.status === "active")
    .flatMap((membership) => {
      const memberships = state.memberships.filter((candidate) => candidate.workspaceId === membership.workspaceId && candidate.internalUserId === user.internalUserId);
      const workspaces = state.workspaces.filter((workspace) => workspace.workspaceId === membership.workspaceId && workspace.status === "active");
      if (memberships.length !== 1 || workspaces.length !== 1) return [];
      const workspace = workspaces[0];
      return [{ workspaceId: workspace.workspaceId, name: workspace.name, revision: workspace.revision, policyRevision: workspace.policyRevision, memberId: membership.memberId, role: membership.role, membershipRevision: membership.revision }];
    })
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}
export function listAccountDevices(state: Pick<CloudState, "users" | "identityLinks" | "devices">, identity: CloudIdentity | null | undefined): AccountDeviceSummary[] {
  const { user } = resolveInternalUser(state, identity);
  return state.devices
    .filter((device) => device.internalUserId === user.internalUserId && device.kind && device.label !== undefined && device.registeredAt !== undefined && device.lastSeenAt !== undefined)
    .map((device) => ({ deviceId: device.deviceId, kind: device.kind!, label: device.label!, status: device.status, registeredAt: device.registeredAt!, lastSeenAt: device.lastSeenAt!, ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }) }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}
export function revokeAccountDeviceToState(state: Pick<CloudState, "users" | "identityLinks" | "devices" | "deviceLinks">, identity: CloudIdentity | null | undefined, deviceId: string, now = Date.now()) {
  const { user } = resolveInternalUser(state, identity);
  const devices = state.devices.filter((device) => device.deviceId === deviceId);
  if (devices.length !== 1 || devices[0].internalUserId !== user.internalUserId) throw new CloudPolicyError("device-unavailable", "This device is unavailable.", true);
  const device = devices[0];
  const links = state.deviceLinks.filter((link) => link.deviceId === deviceId && link.internalUserId === user.internalUserId);
  if (device.status !== "revoked") { device.status = "revoked"; device.revokedAt = now; }
  for (const link of links) if (link.status !== "revoked") { link.status = "revoked"; link.revokedAt = now; }
  return { deviceId, status: "revoked" as const, revokedWorkspaceLinks: links.length };
}
export interface BootstrapState extends CloudState { bootstrapReceipts: { identity: string; key: string; fingerprint: string; result: BootstrapResult }[] }
export type BootstrapResult = { status: "created" | "existing" | "conflict"; internalUserId?: string; workspaceId?: string; memberId?: string; code?: "identity-link-conflict" | "idempotency-conflict" };
export function bootstrapAccountToState(state: BootstrapState, identity: CloudIdentity, key: string, fingerprint = "") : BootstrapResult {
  const principal = `${identity.provider}:${identity.normalizedIssuer}:${identity.subject}`; const receipt = state.bootstrapReceipts.find((x) => x.identity === principal && x.key === key); if (receipt) return receipt.fingerprint === fingerprint ? receipt.result : { status: "conflict", code: "idempotency-conflict" };
  const links = state.identityLinks.filter((x) => x.provider === identity.provider && x.normalizedIssuer === identity.normalizedIssuer && x.subject === identity.subject);
  if (links.length > 1) return { status: "conflict", code: "identity-link-conflict" };
  let link = links[0]; let created = false;
  if (!link) { const internalUserId = `usr-${state.users.length + 1}`; link = { ...identity, internalUserId, status: "active" }; state.users.push({ internalUserId, status: "active" }); state.identityLinks.push(link); created = true; }
  const user = state.users.find((candidate) => candidate.internalUserId === link!.internalUserId);
  if (!user || user.status !== "active") return { status: "conflict", code: "identity-link-conflict" };
  let member = user.initialWorkspaceId ? state.memberships.find((candidate) => candidate.workspaceId === user.initialWorkspaceId && candidate.internalUserId === user.internalUserId && candidate.status === "active" && candidate.role === "owner") : undefined;
  if (!member) { const workspaceId = `ws-${state.workspaces.length + 1}`; member = { memberId: `member-${state.memberships.length + 1}`, workspaceId, internalUserId: link.internalUserId, role: "owner", status: "active", revision: 1 }; state.workspaces.push({ workspaceId, name: "Fable workspace", status: "active", revision: 0, policyRevision: 1 }); state.memberships.push(member); user.initialWorkspaceId = workspaceId; }
  const result: BootstrapResult = { status: created ? "created" : "existing", internalUserId: link.internalUserId, workspaceId: member.workspaceId, memberId: member.memberId }; state.bootstrapReceipts.push({ identity: principal, key, fingerprint, result }); return result;
}
export function applyOutboxMutationToState(state: CloudState, identity: CloudIdentity | null | undefined, args: OutboxMutationArgs, now = Date.now()): MutationResult {
  const expected = `${args.workspaceId}:${args.deviceId}:${args.clientMutationId}`;
  if (args.idempotencyKey !== expected) throw new CloudPolicyError("idempotency-conflict", "The idempotency key does not match the mutation namespace.", true);
  const replay = state.idempotencyKeys.find((x) => x.workspaceId === args.workspaceId && x.deviceId === args.deviceId && x.clientMutationId === args.clientMutationId); if (replay) return replay.result;
  const reject = (code: string, message: string) => { const result: MutationResult = { status: "rejected", code, message }; state.idempotencyKeys.push({ workspaceId: args.workspaceId, deviceId: args.deviceId, clientMutationId: args.clientMutationId, idempotencyKey: args.idempotencyKey, result }); return result; };
  try {
    requireCanWrite(state, identity, args);
    const tombstone = state.tombstones.find((x) => x.workspaceId === args.workspaceId && x.recordType === args.recordType && x.recordId === args.recordId);
    if (tombstone && args.operation !== "delete") return reject("conflict", "The shared record is unavailable.");
    const workspace = state.workspaces.find((x) => x.workspaceId === args.workspaceId)!;
    const existing = state.projects.find((x) => x.workspaceId === args.workspaceId && x.projectId === args.recordId);
    const revision = workspace.revision + 1;
    if (args.operation === "create") { if (existing && !existing.deletedAt) return reject("conflict", "The shared record is unavailable."); state.projects.push({ workspaceId: args.workspaceId, projectId: args.recordId, name: args.payload?.name?.trim() || "Untitled project", revision }); }
    else if (args.operation === "update") { if (!existing || existing.deletedAt || existing.revision !== args.baseRevision) return reject("conflict", "The shared record is unavailable."); existing.name = args.payload?.name?.trim() || existing.name; existing.revision = revision; }
    else { if (!existing || existing.deletedAt || existing.revision !== args.baseRevision) return reject("conflict", "The shared record is unavailable."); existing.deletedAt = now; existing.revision = revision; state.tombstones.push({ workspaceId: args.workspaceId, recordType: args.recordType, recordId: args.recordId, revision, deletedAt: now, actorDeviceId: args.deviceId }); }
    workspace.revision = revision; const result: MutationResult = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId }; state.idempotencyKeys.push({ workspaceId: args.workspaceId, deviceId: args.deviceId, clientMutationId: args.clientMutationId, idempotencyKey: args.idempotencyKey, result }); return result;
  } catch (error) { if (error instanceof CloudPolicyError) return reject(error.code, "The shared record is unavailable."); throw error; }
}

export type LifecycleOutcome = "accepted" | "rejected" | "conflict";
export interface CloudInvitation {
  invitationId: string;
  workspaceId: string;
  role: CloudRole;
  inviterMemberId: string;
  recipientInternalUserId: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: number;
  presentationRef: string;
  acceptedByInternalUserId?: string;
  acceptedMembershipId?: string;
  acceptedAt?: number;
  revokedByMemberId?: string;
  revokedAt?: number;
  createdAt: number;
  updatedAt: number;
  createdByInternalUserId: string;
}
export interface LifecycleReceipt { actorInternalUserId: string; key: string; operation: string; fingerprint: string; result: LifecycleResult; createdAt: number }
export interface LifecycleAudit {
  workspaceId: string;
  actorInternalUserId: string;
  actorMemberId?: string;
  targetMemberId?: string;
  invitationId?: string;
  operation: string;
  outcome: LifecycleOutcome;
  code?: string;
  deviceId?: string;
  sessionRef?: string;
  createdAt: number;
}
export interface MembershipLifecycleState extends CloudState { invitations: CloudInvitation[]; lifecycleReceipts: LifecycleReceipt[]; lifecycleAudit: LifecycleAudit[] }
export type CanonicalMembership = {
  authority: "convex"; schemaVersion: 1; revision: number; workspaceId: string; memberId: string; internalUserId: string; role: CloudRole;
  status: CloudMembership["status"]; joinedFromInvitationId?: string; activatedAt: string; suspendedAt?: string; removedAt?: string;
  createdByInternalUserId: string; createdAt: string; updatedAt: string;
};
export type CanonicalInvitation = {
  authority: "convex"; schemaVersion: 1; revision: number; workspaceId: string; invitationId: string; status: CloudInvitation["status"];
  role: CloudRole; inviterMemberId: string; recipientConstraint: { kind: "internal-user"; internalUserId: string }; expiresAt: string;
  acceptedByInternalUserId?: string; acceptedMembershipId?: string; acceptedAt?: string; revokedByMemberId?: string; revokedAt?: string;
  createdByInternalUserId: string; createdAt: string; updatedAt: string;
};
export type LifecycleResult =
  | { status: "accepted"; invitation?: CanonicalInvitation; membership?: CanonicalMembership; lastOwnerSafety?: { status: "safe"; remainingActiveOwnerCount: number }; idempotency: { key: string; replayed: boolean; recordedAt: string } }
  | { status: "conflict" | "rejected"; code: string; message: string; idempotency?: { key: string; replayed: boolean; recordedAt: string } };

type LifecycleActor = ReturnType<typeof requireCanManageMembers>;

function iso(value: number | undefined) { return value === undefined ? undefined : new Date(value).toISOString(); }
export function canonicalMembership(record: CloudMembership): CanonicalMembership {
  const createdAt = record.createdAt ?? record.activatedAt ?? 0;
  const updatedAt = record.updatedAt ?? createdAt;
  return {
    authority: "convex", schemaVersion: 1, revision: record.revision, workspaceId: record.workspaceId, memberId: record.memberId,
    internalUserId: record.internalUserId, role: record.role, status: record.status,
    ...(record.joinedFromInvitationId ? { joinedFromInvitationId: record.joinedFromInvitationId } : {}),
    activatedAt: iso(record.activatedAt ?? createdAt)!, ...(record.suspendedAt === undefined ? {} : { suspendedAt: iso(record.suspendedAt)! }),
    ...(record.removedAt === undefined ? {} : { removedAt: iso(record.removedAt)! }),
    createdByInternalUserId: record.createdByInternalUserId ?? record.internalUserId, createdAt: iso(createdAt)!, updatedAt: iso(updatedAt)!,
  };
}
export function canonicalInvitation(record: CloudInvitation): CanonicalInvitation {
  return {
    authority: "convex", schemaVersion: 1, revision: invitationRevision(record), workspaceId: record.workspaceId, invitationId: record.invitationId,
    status: record.status, role: record.role, inviterMemberId: record.inviterMemberId,
    recipientConstraint: { kind: "internal-user", internalUserId: record.recipientInternalUserId }, expiresAt: iso(record.expiresAt)!,
    ...(record.acceptedByInternalUserId ? { acceptedByInternalUserId: record.acceptedByInternalUserId } : {}),
    ...(record.acceptedMembershipId ? { acceptedMembershipId: record.acceptedMembershipId } : {}), ...(record.acceptedAt === undefined ? {} : { acceptedAt: iso(record.acceptedAt)! }),
    ...(record.revokedByMemberId ? { revokedByMemberId: record.revokedByMemberId } : {}), ...(record.revokedAt === undefined ? {} : { revokedAt: iso(record.revokedAt)! }),
    createdByInternalUserId: record.createdByInternalUserId, createdAt: iso(record.createdAt)!, updatedAt: iso(record.updatedAt)!,
  };
}
function invitationRevision(record: CloudInvitation) { return record.status === "pending" ? 1 : 2; }
function fingerprint(value: unknown) { return JSON.stringify(value); }
function lifecycleError(code: string, message = "The requested membership operation is unavailable."): LifecycleResult { return { status: ["idempotency-conflict", "stale-revision", "conflict", "invitation-expired", "invitation-already-consumed"].includes(code) ? "conflict" : "rejected", code, message }; }
function findReceipt(state: MembershipLifecycleState, actor: string, key: string, operation: string, intent: string): LifecycleResult | undefined {
  const matches = state.lifecycleReceipts.filter((entry) => entry.actorInternalUserId === actor && entry.key === key);
  if (matches.length > 1) return lifecycleError("idempotency-conflict");
  const receipt = matches[0];
  if (!receipt) return undefined;
  if (receipt.operation !== operation || receipt.fingerprint !== intent) return lifecycleError("idempotency-conflict");
  return receipt.result.status === "accepted" ? { ...receipt.result, idempotency: { ...receipt.result.idempotency, replayed: true } } : receipt.result;
}
function recordLifecycle(state: MembershipLifecycleState, identity: CloudIdentity, actor: { user: CloudUser; membership?: CloudMembership }, key: string, operation: string, intent: string, result: LifecycleResult, context: Omit<LifecycleAudit, "actorInternalUserId" | "actorMemberId" | "deviceId" | "sessionRef" | "operation" | "outcome" | "code" | "createdAt">, now: number) {
  const receiptResult: LifecycleResult = result.status === "accepted" ? { ...result, idempotency: { key, replayed: false, recordedAt: iso(now)! } } : result;
  state.lifecycleReceipts.push({ actorInternalUserId: actor.user.internalUserId, key, operation, fingerprint: intent, result: receiptResult, createdAt: now });
  const deviceLinks = actor.membership ? state.deviceLinks.filter((link) => link.workspaceId === context.workspaceId && link.memberId === actor.membership!.memberId && link.status === "active") : [];
  state.lifecycleAudit.push({ ...context, actorInternalUserId: actor.user.internalUserId, ...(actor.membership ? { actorMemberId: actor.membership.memberId } : {}), operation, outcome: result.status, ...(result.status === "accepted" ? {} : { code: result.code }), ...(deviceLinks.length === 1 ? { deviceId: deviceLinks[0].deviceId } : {}), ...(identity.sessionRef ? { sessionRef: identity.sessionRef } : {}), createdAt: now });
  return receiptResult;
}
function expireInvitations(state: MembershipLifecycleState, now: number) { for (const invitation of state.invitations) if (invitation.status === "pending" && invitation.expiresAt <= now) { invitation.status = "expired"; invitation.updatedAt = now; } }
function uniqueInvitation(state: MembershipLifecycleState, invitationId: string) { const found = state.invitations.filter((entry) => entry.invitationId === invitationId); if (found.length !== 1) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true); return found[0]; }
function activeOwnerCount(state: MembershipLifecycleState, workspaceId: string, exceptMemberId?: string) { return state.memberships.filter((member) => member.workspaceId === workspaceId && member.memberId !== exceptMemberId && member.status === "active" && member.role === "owner").length; }

export function listWorkspaceInvitationsToState(state: MembershipLifecycleState, identity: CloudIdentity, workspaceId: string, now = Date.now()) {
  requireCanManageMembers(state, identity, workspaceId); expireInvitations(state, now);
  return state.invitations.filter((entry) => entry.workspaceId === workspaceId).map(canonicalInvitation).sort((a, b) => a.invitationId.localeCompare(b.invitationId));
}
export function listRecipientPendingInvitationsToState(state: MembershipLifecycleState, identity: CloudIdentity, now = Date.now()) {
  const { user } = resolveInternalUser(state, identity); expireInvitations(state, now);
  return state.invitations.filter((entry) => entry.recipientInternalUserId === user.internalUserId && entry.status === "pending").map((entry) => ({ invitation: canonicalInvitation(entry), presentationProof: { invitationId: entry.invitationId, proofRef: entry.presentationRef, verifiedAt: iso(now)! } })).sort((a, b) => a.invitation.invitationId.localeCompare(b.invitation.invitationId));
}
export function createInvitationToState(state: MembershipLifecycleState, identity: CloudIdentity, args: { workspaceId: string; role: CloudRole; recipientInternalUserId: string; expiresAt: number; idempotencyKey: string; invitationId: string; presentationRef: string }, now = Date.now()): LifecycleResult {
  const actor = requireCanManageMembers(state, identity, args.workspaceId); const intent = fingerprint(["invitation.create", args.workspaceId, args.role, args.recipientInternalUserId, args.expiresAt]);
  const replay = findReceipt(state, actor.user.internalUserId, args.idempotencyKey, "invitation.create", intent); if (replay) return replay;
  let result: LifecycleResult;
  try {
    ensureRoleAssignment(actor.membership.role, args.role); expireInvitations(state, now); if (args.expiresAt <= now) throw new CloudPolicyError("invitation-expired", "Invitation expiry must be in the future.");
    if (state.invitations.some((entry) => entry.invitationId === args.invitationId)) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true);
    const recipient = state.users.find((entry) => entry.internalUserId === args.recipientInternalUserId); const membership = state.memberships.find((entry) => entry.workspaceId === args.workspaceId && entry.internalUserId === args.recipientInternalUserId);
    const duplicate = state.invitations.some((entry) => entry.workspaceId === args.workspaceId && entry.recipientInternalUserId === args.recipientInternalUserId && entry.status === "pending"); ensureInvitationTarget(recipient?.status, duplicate, membership?.status);
    if (membership) ensureMemberManagement(actor.membership.role, membership.role, args.role);
    const invitation: CloudInvitation = { invitationId: args.invitationId, workspaceId: args.workspaceId, role: args.role, inviterMemberId: actor.membership.memberId, recipientInternalUserId: args.recipientInternalUserId, status: "pending", expiresAt: args.expiresAt, presentationRef: args.presentationRef, createdAt: now, updatedAt: now, createdByInternalUserId: actor.user.internalUserId }; state.invitations.push(invitation);
    result = { status: "accepted", invitation: canonicalInvitation(invitation), idempotency: { key: args.idempotencyKey, replayed: false, recordedAt: iso(now)! } };
  } catch (error) { result = error instanceof CloudPolicyError ? lifecycleError(error.code, error.message) : lifecycleError("conflict"); }
  return recordLifecycle(state, identity, actor, args.idempotencyKey, "invitation.create", intent, result, { workspaceId: args.workspaceId, invitationId: args.invitationId }, now);
}
export function acceptInvitationToState(state: MembershipLifecycleState, identity: CloudIdentity, args: { invitationId: string; presentationRef: string; idempotencyKey: string }, now = Date.now()): LifecycleResult {
  const actor = resolveInternalUser(state, identity); const intent = fingerprint(["invitation.accept", args.invitationId, args.presentationRef]); const replay = findReceipt(state, actor.user.internalUserId, args.idempotencyKey, "invitation.accept", intent); if (replay) return replay;
  let workspaceId = "unavailable"; let targetMemberId: string | undefined; let result: LifecycleResult;
  try {
    expireInvitations(state, now); const invitation = uniqueInvitation(state, args.invitationId); workspaceId = invitation.workspaceId;
    if (invitation.status === "expired") throw new CloudPolicyError("invitation-expired", "The invitation is unavailable.", true);
    if (invitation.status !== "pending") throw new CloudPolicyError("invitation-already-consumed", "The invitation is unavailable.", true);
    if (invitation.recipientInternalUserId !== actor.user.internalUserId) throw new CloudPolicyError("invitation-recipient-mismatch", "The invitation is unavailable.", true);
    if (invitation.presentationRef !== args.presentationRef) throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true);
    const workspace = state.workspaces.filter((entry) => entry.workspaceId === invitation.workspaceId && entry.status === "active"); if (workspace.length !== 1) throw new CloudPolicyError("workspace-unavailable", "The invitation is unavailable.", true);
    const memberships = state.memberships.filter((entry) => entry.workspaceId === invitation.workspaceId && entry.internalUserId === actor.user.internalUserId); if (memberships.length > 1) throw new CloudPolicyError("conflict", "The invitation is unavailable.", true);
    let membership = memberships[0];
    if (membership?.status === "removed" || membership?.status === "active") throw new CloudPolicyError("invitation-unavailable", "The invitation is unavailable.", true);
    if (membership) { membership.status = "active"; membership.role = invitation.role; membership.revision += 1; membership.updatedAt = now; membership.activatedAt = now; membership.suspendedAt = undefined; }
    else { membership = { memberId: `member:${invitation.invitationId}`, workspaceId: invitation.workspaceId, internalUserId: actor.user.internalUserId, role: invitation.role, status: "active", revision: 1, joinedFromInvitationId: invitation.invitationId, createdAt: now, updatedAt: now, activatedAt: now, createdByInternalUserId: invitation.createdByInternalUserId }; state.memberships.push(membership); }
    targetMemberId = membership.memberId; invitation.status = "accepted"; invitation.acceptedByInternalUserId = actor.user.internalUserId; invitation.acceptedMembershipId = membership.memberId; invitation.acceptedAt = now; invitation.updatedAt = now;
    result = { status: "accepted", invitation: canonicalInvitation(invitation), membership: canonicalMembership(membership), idempotency: { key: args.idempotencyKey, replayed: false, recordedAt: iso(now)! } };
  } catch (error) { result = error instanceof CloudPolicyError ? lifecycleError(error.code, error.message) : lifecycleError("conflict"); }
  return recordLifecycle(state, identity, { user: actor.user, ...(targetMemberId ? { membership: state.memberships.find((entry) => entry.memberId === targetMemberId) } : {}) }, args.idempotencyKey, "invitation.accept", intent, result, { workspaceId, invitationId: args.invitationId, ...(targetMemberId ? { targetMemberId } : {}) }, now);
}
export function revokeInvitationToState(state: MembershipLifecycleState, identity: CloudIdentity, args: { workspaceId: string; invitationId: string; idempotencyKey: string }, now = Date.now()): LifecycleResult {
  const actor = requireCanManageMembers(state, identity, args.workspaceId); const intent = fingerprint(["invitation.revoke", args.workspaceId, args.invitationId]); const replay = findReceipt(state, actor.user.internalUserId, args.idempotencyKey, "invitation.revoke", intent); if (replay) return replay; let result: LifecycleResult;
  try { expireInvitations(state, now); const invitation = uniqueInvitation(state, args.invitationId); if (invitation.workspaceId !== args.workspaceId || invitation.status !== "pending") throw new CloudPolicyError("invitation-already-consumed", "The invitation is unavailable.", true); invitation.status = "revoked"; invitation.revokedByMemberId = actor.membership.memberId; invitation.revokedAt = now; invitation.updatedAt = now; result = { status: "accepted", invitation: canonicalInvitation(invitation), idempotency: { key: args.idempotencyKey, replayed: false, recordedAt: iso(now)! } }; }
  catch (error) { result = error instanceof CloudPolicyError ? lifecycleError(error.code, error.message) : lifecycleError("conflict"); }
  return recordLifecycle(state, identity, actor, args.idempotencyKey, "invitation.revoke", intent, result, { workspaceId: args.workspaceId, invitationId: args.invitationId }, now);
}
export function changeMembershipToState(state: MembershipLifecycleState, identity: CloudIdentity, args: { workspaceId: string; memberId: string; action: MemberLifecycleAction; role?: CloudRole; baseRevision: number; idempotencyKey: string }, now = Date.now()): LifecycleResult {
  const actor = requireCanManageMembers(state, identity, args.workspaceId); const intent = fingerprint(["membership.change", args.workspaceId, args.memberId, args.action, args.role ?? null, args.baseRevision]); const replay = findReceipt(state, actor.user.internalUserId, args.idempotencyKey, "membership.change", intent); if (replay) return replay; let result: LifecycleResult;
  try {
    const targets = state.memberships.filter((entry) => entry.memberId === args.memberId); if (targets.length !== 1 || targets[0].workspaceId !== args.workspaceId) throw new CloudPolicyError("membership-required", "The membership is unavailable.", true); const target = targets[0];
    if (target.revision !== args.baseRevision) throw new CloudPolicyError("stale-revision", "The membership revision is stale.", true); const nextRole = args.action === "change-role" ? args.role : target.role; if (!nextRole) throw new CloudPolicyError("role-assignment-denied", "The requested role cannot be assigned.", true);
    ensureMemberManagement(actor.membership.role, target.role, nextRole); const nextStatus = resolveMemberTransition(target.status, args.action); ensureNotLastOwner(state, target, nextRole, nextStatus);
    target.role = nextRole; target.status = nextStatus; target.revision += 1; target.updatedAt = now;
    if (args.action === "suspend") target.suspendedAt = now; if (args.action === "reactivate") { target.activatedAt = now; target.suspendedAt = undefined; } if (args.action === "remove") { target.removedAt = now; target.suspendedAt = undefined; }
    if (args.action === "suspend" || args.action === "remove") for (const link of state.deviceLinks.filter((entry) => entry.workspaceId === args.workspaceId && entry.memberId === target.memberId && entry.status !== "revoked")) { link.status = "revoked"; link.revokedAt = now; }
    result = { status: "accepted", membership: canonicalMembership(target), lastOwnerSafety: { status: "safe", remainingActiveOwnerCount: activeOwnerCount(state, args.workspaceId) }, idempotency: { key: args.idempotencyKey, replayed: false, recordedAt: iso(now)! } };
  } catch (error) { result = error instanceof CloudPolicyError ? lifecycleError(error.code, error.message) : lifecycleError("conflict"); }
  return recordLifecycle(state, identity, actor, args.idempotencyKey, "membership.change", intent, result, { workspaceId: args.workspaceId, targetMemberId: args.memberId }, now);
}
