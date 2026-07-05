export type CloudRole = "owner" | "admin" | "editor" | "viewer";
export type CloudStatus = "active" | "revoked";
export type WorkspaceStatus = "active" | "disabled" | "deleted";
export type CloudOperation = "create" | "update" | "delete";
export type CloudRecordType = "project";
export type MutationResult =
  | { status: "accepted"; revision: number; recordType: CloudRecordType; recordId: string }
  | { status: "rejected"; code: string; message: string };

export interface CloudIdentity {
  subject: string;
  orgId?: string;
}

export interface CloudWorkspace {
  workspaceId: string;
  clerkOrgId: string;
  name: string;
  status: WorkspaceStatus;
  revision: number;
}

export interface CloudMembership {
  workspaceId: string;
  clerkUserId: string;
  clerkOrgId: string;
  role: CloudRole;
  status: CloudStatus;
}

export interface CloudDevice {
  workspaceId: string;
  deviceId: string;
  clerkUserId: string;
  status: CloudStatus;
}

export interface CloudProject {
  workspaceId: string;
  projectId: string;
  name: string;
  revision: number;
  deletedAt?: number;
}

export interface CloudTombstone {
  workspaceId: string;
  recordType: CloudRecordType;
  recordId: string;
  revision: number;
  deletedAt: number;
  actorDeviceId: string;
}

export interface CloudIdempotencyKey {
  workspaceId: string;
  deviceId: string;
  clientMutationId: string;
  idempotencyKey: string;
  result: MutationResult;
}

export interface CloudState {
  workspaces: CloudWorkspace[];
  memberships: CloudMembership[];
  devices: CloudDevice[];
  projects: CloudProject[];
  tombstones: CloudTombstone[];
  idempotencyKeys: CloudIdempotencyKey[];
}

export interface OutboxMutationArgs {
  workspaceId: string;
  deviceId: string;
  clientMutationId: string;
  idempotencyKey: string;
  baseRevision: number;
  recordType: CloudRecordType;
  recordId: string;
  operation: CloudOperation;
  payload?: { name?: string };
}

const WRITE_ROLES = new Set<CloudRole>(["owner", "admin", "editor"]);
const MANAGE_ROLES = new Set<CloudRole>(["owner", "admin"]);

export class CloudPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function requireIdentity(identity: CloudIdentity | null | undefined): CloudIdentity {
  if (!identity?.subject) {
    throw new CloudPolicyError("unauthenticated", "A valid Clerk identity is required.");
  }
  return identity;
}

export function requireActiveMembership(
  state: Pick<CloudState, "workspaces" | "memberships">,
  identity: CloudIdentity | null | undefined,
  workspaceId: string
) {
  const user = requireIdentity(identity);
  const workspace = state.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace || workspace.status !== "active") {
    throw new CloudPolicyError("workspace-not-found", "The shared workspace is unavailable.");
  }
  if (workspace.clerkOrgId && user.orgId !== workspace.clerkOrgId) {
    throw new CloudPolicyError("wrong-organization", "The Clerk organization does not match this workspace.");
  }
  const membership = state.memberships.find(
    (candidate) => candidate.workspaceId === workspaceId && candidate.clerkUserId === user.subject
  );
  if (!membership || membership.status !== "active") {
    throw new CloudPolicyError("membership-required", "Active Fable workspace membership is required.");
  }
  if (membership.clerkOrgId !== workspace.clerkOrgId) {
    throw new CloudPolicyError("wrong-organization", "The membership organization does not match this workspace.");
  }
  return { user, workspace, membership };
}

export function requireCanRead(
  state: Pick<CloudState, "workspaces" | "memberships">,
  identity: CloudIdentity | null | undefined,
  workspaceId: string
) {
  return requireActiveMembership(state, identity, workspaceId);
}

export function requireCanWrite(state: CloudState, identity: CloudIdentity | null | undefined, args: OutboxMutationArgs) {
  const authz = requireActiveMembership(state, identity, args.workspaceId);
  if (!WRITE_ROLES.has(authz.membership.role)) {
    throw new CloudPolicyError("role-denied", "Viewer members cannot write shared workspace records.");
  }
  const device = state.devices.find(
    (candidate) => candidate.workspaceId === args.workspaceId && candidate.deviceId === args.deviceId
  );
  if (!device || device.clerkUserId !== authz.user.subject || device.status !== "active") {
    throw new CloudPolicyError("device-revoked", "This device is not linked for shared workspace writes.");
  }
  return { ...authz, device };
}

export function requireCanManageMembers(
  state: Pick<CloudState, "workspaces" | "memberships">,
  identity: CloudIdentity | null | undefined,
  workspaceId: string
) {
  const authz = requireActiveMembership(state, identity, workspaceId);
  if (!MANAGE_ROLES.has(authz.membership.role)) {
    throw new CloudPolicyError("role-denied", "This role cannot manage workspace membership.");
  }
  return authz;
}

export function applyOutboxMutationToState(
  state: CloudState,
  identity: CloudIdentity | null | undefined,
  args: OutboxMutationArgs,
  now = Date.now()
): MutationResult {
  const expectedIdempotencyKey = `${args.workspaceId}:${args.deviceId}:${args.clientMutationId}`;
  if (args.idempotencyKey !== expectedIdempotencyKey) {
    throw new CloudPolicyError("bad-idempotency-key", "The idempotency key does not match the mutation namespace.");
  }
  const replay = state.idempotencyKeys.find(
    (key) =>
      key.workspaceId === args.workspaceId &&
      key.deviceId === args.deviceId &&
      key.clientMutationId === args.clientMutationId
  );
  if (replay) {
    return replay.result;
  }

  const reject = (code: string, message: string): MutationResult => {
    const result: MutationResult = { status: "rejected", code, message };
    state.idempotencyKeys.push({
      workspaceId: args.workspaceId,
      deviceId: args.deviceId,
      clientMutationId: args.clientMutationId,
      idempotencyKey: args.idempotencyKey,
      result
    });
    return result;
  };

  try {
    const { workspace } = requireCanWrite(state, identity, args);
    const tombstone = state.tombstones.find(
      (candidate) =>
        candidate.workspaceId === args.workspaceId &&
        candidate.recordType === args.recordType &&
        candidate.recordId === args.recordId
    );
    if (tombstone && args.operation !== "delete") {
      return reject("tombstoned", "Deleted shared records cannot be resurrected by stale updates.");
    }

    const existing = state.projects.find(
      (candidate) => candidate.workspaceId === args.workspaceId && candidate.projectId === args.recordId
    );
    let result: MutationResult;
    const revision = workspace.revision + 1;
    if (args.operation === "create") {
      if (existing && !existing.deletedAt) {
        return reject("duplicate-record", "The shared project already exists.");
      }
      state.projects.push({
        workspaceId: args.workspaceId,
        projectId: args.recordId,
        name: args.payload?.name?.trim() || "Untitled project",
        revision
      });
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    } else if (args.operation === "update") {
      if (!existing || existing.deletedAt) {
        return reject("missing-record", "The shared project is unavailable.");
      }
      if (existing.revision !== args.baseRevision) {
        return reject("stale-revision", "The shared project changed before this mutation was applied.");
      }
      existing.name = args.payload?.name?.trim() || existing.name;
      existing.revision = revision;
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    } else {
      if (!existing || existing.deletedAt) {
        return reject("missing-record", "The shared project is unavailable.");
      }
      existing.deletedAt = now;
      existing.revision = revision;
      state.tombstones.push({
        workspaceId: args.workspaceId,
        recordType: args.recordType,
        recordId: args.recordId,
        revision,
        deletedAt: now,
        actorDeviceId: args.deviceId
      });
      result = { status: "accepted", revision, recordType: args.recordType, recordId: args.recordId };
    }
    workspace.revision = revision;
    state.idempotencyKeys.push({
      workspaceId: args.workspaceId,
      deviceId: args.deviceId,
      clientMutationId: args.clientMutationId,
      idempotencyKey: args.idempotencyKey,
      result
    });
    return result;
  } catch (error) {
    if (error instanceof CloudPolicyError) {
      return reject(error.code, error.message);
    }
    throw error;
  }
}
