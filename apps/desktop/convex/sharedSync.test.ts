import { describe, expect, it } from "vitest";
import { applyOutboxMutation, canonicalProjectPayload, computedFingerprint, projectRecord, projectTombstone, replayedMutation } from "./mutations";
import { getWorkspaceDelta, subscribeWorkspace, workspaceDelta } from "./viewer";

type Doc = Record<string, any> & { _id: string };
class FakeQuery {
  filters: Array<(doc: Doc) => boolean> = [];
  constructor(private docs: Doc[]) {}
  withIndex(_name: string, build: (q: any) => unknown) {
    const q: any = {
      eq: (field: string, value: unknown) => { this.filters.push((doc) => doc[field] === value); return q; },
      gt: (field: string, value: number) => { this.filters.push((doc) => doc[field] > value); return q; }
    };
    build(q); return this;
  }
  async collect() { return this.docs.filter((doc) => this.filters.every((filter) => filter(doc))); }
  async first() { return (await this.collect())[0] ?? null; }
}

function hostedFixture(role = "editor", subject = "user") {
  const tables: Record<string, Doc[]> = {
    internal_users: [{ _id: "user:1", internalUserId: "user-a", status: "active" }],
    external_identity_links: [{ _id: "identity:1", provider: "clerk", normalizedIssuer: "https://issuer.example", subject, internalUserId: "user-a", status: "active" }],
    workspaces: [{ _id: "workspace:1", workspaceId: "ws-a", status: "active", revision: 0 }],
    workspace_memberships: [{ _id: "member:1", memberId: "member-a", workspaceId: "ws-a", internalUserId: "user-a", role, status: "active" }],
    account_devices: [{ _id: "device:1", deviceId: "device-a", internalUserId: "user-a", status: "active" }],
    workspace_device_links: [{ _id: "device-link:1", workspaceId: "ws-a", deviceId: "device-a", internalUserId: "user-a", memberId: "member-a", status: "active" }],
    shared_projects: [], tombstones: [], shared_record_changes: [], idempotency_keys: [], mutation_audit: []
  };
  let writes = 0; let sequence = 0;
  const db = {
    query: (table: string) => new FakeQuery(tables[table] ?? []),
    get: async (id: string) => Object.values(tables).flat().find((doc) => doc._id === id) ?? null,
    insert: async (table: string, value: any) => { writes++; const doc = { _id: `${table}:${++sequence}`, ...value }; (tables[table] ??= []).push(doc); return doc._id; },
    patch: async (id: string, value: any) => { writes++; const doc = Object.values(tables).flat().find((row) => row._id === id); if (!doc) throw new Error("missing row"); Object.assign(doc, value); }
  };
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject, issuer: "https://issuer.example", tokenIdentifier: "opaque" }) } };
  return { ctx, tables, writes: () => writes };
}

async function mutationArgs(operation: "create" | "update" | "delete", baseRevision: number, clientMutationId: string, payload?: any) {
  const args: any = { workspaceId: "ws-a", deviceId: "device-a", clientMutationId,
    idempotencyKey: `ws-a:device-a:${clientMutationId}`, baseRevision, recordType: "project",
    recordId: "project-a", operation, ...(payload === undefined ? {} : { payload }) };
  args.intentFingerprint = await computedFingerprint(args, payload === undefined ? null : canonicalProjectPayload(operation, payload));
  return args;
}

const record = (revision = 1) => ({
  workspaceId: "ws-a", projectId: "project-a", name: "Shared plan", revision,
  createdByInternalUserId: "user-a", createdByDeviceId: "device-a",
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000
});
const tombstone = (revision = 2) => ({
  workspaceId: "ws-a", recordType: "project", recordId: "project-a", revision,
  deletedAt: 1_700_000_001_000, actorInternalUserId: "user-a",
  actorMemberId: "member-a", actorDeviceId: "device-a", reasonClass: "user-delete"
});

describe("shared project hosted sync contract", () => {
  it("replays only an identical fingerprint", () => {
    const accepted = { status: "accepted" as const, workspaceRevision: 1 as never, record: projectRecord(record()) };
    expect(replayedMutation({ intentFingerprint: "a".repeat(64), result: accepted }, "a".repeat(64))).toEqual(accepted);
    expect(replayedMutation({ intentFingerprint: "a".repeat(64), result: accepted }, "b".repeat(64)))
      .toMatchObject({ status: "rejected", code: "idempotency-conflict" });
  });

  it("enforces canonical project bounds and rejects empty supplied updates", () => {
    expect(canonicalProjectPayload("create", { title: "  Plan  " })).toEqual({ title: "Plan" });
    expect(() => canonicalProjectPayload("create", { title: "" })).toThrow();
    expect(() => canonicalProjectPayload("create", { title: "x".repeat(201) })).toThrow();
    expect(() => canonicalProjectPayload("create", { title: "Plan", description: null })).toThrow();
    expect(() => canonicalProjectPayload("update", { title: "   " })).toThrow();
    expect(() => canonicalProjectPayload("update", { description: "x".repeat(4_001) })).toThrow();
    expect(() => canonicalProjectPayload("update", { instructions: "x".repeat(32_001) })).toThrow();
    expect(() => canonicalProjectPayload("delete", {})).toThrow();
  });

  it("projects closed authority and actor fields", () => {
    expect(projectRecord(record())).toMatchObject({
      authority: "convex", visibility: "workspace-shared", title: "Shared plan",
      createdByInternalUserId: "user-a", createdByDeviceId: "device-a"
    });
    expect(projectTombstone(tombstone())).toMatchObject({
      actorInternalUserId: "user-a", actorMemberId: "member-a", actorDeviceId: "device-a"
    });
  });

  it("orders a bounded delta and rejects ambiguous revisions", () => {
    const delta = workspaceDelta("ws-a", 0, 2, [record(1)], [tombstone(2)]);
    expect(delta.changes.map((change) => change.kind)).toEqual(["record", "tombstone"]);
    expect(() => workspaceDelta("ws-a", 0, 1, [record(1)], [tombstone(1)])).toThrow(/ambiguous/i);
    expect(() => workspaceDelta("ws-a", 0, 2, [record(2)], [])).toThrow(/contiguous/i);
    expect(() => workspaceDelta("ws-a", 2, 1, [], [])).toThrow(/cursor/i);
  });

  it("never emits the deleted project row alongside its tombstone", () => {
    const delta = workspaceDelta("ws-a", 1, 2, [{ ...record(2), deletedAt: 1_700_000_001_000 }], [tombstone(2)]);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0].kind).toBe("tombstone");
  });
});

describe("registered shared sync handlers", () => {
  it("authorizes before replay and gives viewers an opaque zero-write denial", async () => {
    const f = hostedFixture("viewer");
    f.tables.idempotency_keys.push({ _id: "receipt:forged", workspaceId: "ws-a", deviceId: "device-a", clientMutationId: "create", intentFingerprint: "x", result: { status: "accepted" } });
    const result = await (applyOutboxMutation as any)._handler(f.ctx, await mutationArgs("create", 0, "create", { title: "Plan" }));
    expect(result).toMatchObject({ status: "rejected", code: "permission-denied" });
    expect(f.writes()).toBe(0);
    expect(f.tables.shared_record_changes).toHaveLength(0);
    const device = hostedFixture();
    device.tables.account_devices[0].status = "revoked";
    const denied = await (applyOutboxMutation as any)._handler(device.ctx, await mutationArgs("create", 0, "device", { title: "Plan" }));
    expect(denied).toMatchObject({ status: "rejected", code: "device-inactive" });
    expect(device.writes()).toBe(0);
  });

  it("records immutable create update delete history and serves cursor slices", async () => {
    const f = hostedFixture();
    expect(await (applyOutboxMutation as any)._handler(f.ctx, await mutationArgs("create", 0, "c1", { title: "Plan" }))).toMatchObject({ status: "accepted", workspaceRevision: 1 });
    expect(await (applyOutboxMutation as any)._handler(f.ctx, await mutationArgs("update", 1, "c2", { title: "Plan 2" }))).toMatchObject({ status: "accepted", workspaceRevision: 2 });
    expect(await (applyOutboxMutation as any)._handler(f.ctx, await mutationArgs("delete", 2, "c3"))).toMatchObject({ status: "accepted", workspaceRevision: 3 });
    expect(f.tables.shared_record_changes.map((row) => row.revision)).toEqual([1, 2, 3]);
    expect((await (getWorkspaceDelta as any)._handler(f.ctx, { workspaceId: "ws-a", afterRevision: 0 })).changes.map((change: any) => change.kind)).toEqual(["record", "record", "tombstone"]);
    expect((await (getWorkspaceDelta as any)._handler(f.ctx, { workspaceId: "ws-a", afterRevision: 1 })).changes.map((change: any) => change.kind)).toEqual(["record", "tombstone"]);
    expect(await (subscribeWorkspace as any)._handler(f.ctx, { workspaceId: "ws-a" })).toEqual([]);
  });

  it("recomputes fingerprints and blocks incomplete legacy history without writes", async () => {
    const f = hostedFixture();
    const args = await mutationArgs("create", 0, "same", { title: "Plan" });
    await (applyOutboxMutation as any)._handler(f.ctx, args);
    const before = f.writes();
    expect(await (applyOutboxMutation as any)._handler(f.ctx, { ...args, payload: { title: "Changed" } })).toMatchObject({ status: "rejected", code: "idempotency-conflict" });
    expect(f.writes()).toBe(before);
    f.tables.workspaces[0].revision = 2;
    f.tables.tombstones.push({ _id: "legacy:tombstone", workspaceId: "ws-a", recordType: "project",
      recordId: "old", revision: 2, deletedAt: Date.now(), actorInternalUserId: "user-a",
      actorDeviceId: "device-a", reasonClass: "user-delete" });
    const blockedBefore = f.writes();
    expect(await (applyOutboxMutation as any)._handler(f.ctx, await mutationArgs("update", 2, "legacy", { title: "Blocked" }))).toMatchObject({ status: "rejected", code: "backfill-required" });
    expect(f.writes()).toBe(blockedBefore);
    await expect((getWorkspaceDelta as any)._handler(f.ctx, { workspaceId: "ws-a", afterRevision: 0 })).rejects.toThrow(/backfill/i);
  });
});
