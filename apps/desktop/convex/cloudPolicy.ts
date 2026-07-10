export type CloudRole = "owner" | "admin" | "editor" | "viewer";
export type CloudRecordType = "project";
export type CloudOperation = "create" | "update" | "delete";
export type MutationResult =
  | { status: "accepted"; revision: number; recordType: CloudRecordType; recordId: string }
  | { status: "rejected"; code: string; message: string };

/** Trusted authentication facts. They identify a principal but grant no workspace access. */
export interface CloudIdentity { provider: "clerk"; normalizedIssuer: string; subject: string }
export interface CloudUser { internalUserId: string; status: "active" | "disabled"; initialWorkspaceId?: string }
export interface CloudIdentityLink { provider: "clerk"; normalizedIssuer: string; subject: string; internalUserId: string; status: "active" | "disabled" | "revoked" }
export interface CloudWorkspace { workspaceId: string; name: string; status: "active" | "locked" | "deleted"; revision: number; policyRevision: number }
export interface CloudMembership { memberId: string; workspaceId: string; internalUserId: string; role: CloudRole; status: "active" | "suspended" | "removed"; revision: number }
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
  if (recipientStatus !== "active" || invitationExists || membershipStatus === "active") throw new CloudPolicyError("invitation-unavailable", "The invitation target is unavailable.", true);
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
