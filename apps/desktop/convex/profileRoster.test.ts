import { describe, expect, it } from "vitest";
import { validatedDisplayProfile } from "./convexAuth";
import { listRoster } from "./membership";
import { bootstrapAccount } from "./workspace";

type Doc = Record<string, any> & { _id: string };
type Tables = Record<string, Doc[]>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];
  constructor(private readonly docs: Doc[]) {}
  withIndex(_index: string, build: (query: { eq: (field: string, value: unknown) => any }) => unknown) {
    const query = { eq: (field: string, value: unknown): any => { this.filters.push([field, value]); return query; } };
    build(query);
    return this;
  }
  async collect() { return this.docs.filter((doc) => this.filters.every(([field, value]) => doc[field] === value)); }
}

function fixture(subject = "owner", extraIdentity: Record<string, unknown> = {}) {
  const tables: Tables = {
    internal_users: [], external_identity_links: [], workspaces: [], workspace_memberships: [],
    bootstrap_idempotency: [], account_devices: [], workspace_device_links: [],
  };
  let currentSubject = subject;
  let identityClaims = extraIdentity;
  let sequence = 0;
  const db = {
    query: (table: string) => new FakeQuery(tables[table] ?? []),
    insert: async (table: string, value: Record<string, unknown>) => {
      const id = `${table}:${++sequence}`;
      (tables[table] ??= []).push({ _id: id, ...value });
      return id;
    },
    patch: async (id: string, value: Record<string, unknown>) => {
      const doc = Object.values(tables).flat().find((entry) => entry._id === id);
      if (!doc) throw new Error(`Missing ${id}`);
      Object.assign(doc, value);
    },
  };
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: currentSubject, issuer: "https://issuer.example", tokenIdentifier: `https://issuer.example|${currentSubject}`, ...identityClaims }) },
  };
  return {
    ctx, tables,
    setSubject: (next: string) => { currentSubject = next; },
    setIdentityClaims: (next: Record<string, unknown>) => { identityClaims = next; },
  };
}

describe("validated display profiles", () => {
  it("normalizes a name and masks only a verified email", () => {
    expect(validatedDisplayProfile({ name: "  Jo\u202esh   Smith  ", email: "Josh@Example.COM", emailVerified: true })).toEqual({
      displayName: "Josh Smith",
      emailHint: "J***@example.com",
    });
    expect(validatedDisplayProfile({ email: "secret@example.com", emailVerified: false })).toBeUndefined();
  });

  it("omits invalid claims instead of weakening authentication", () => {
    expect(validatedDisplayProfile({ name: "\u0000\u200f", email: "not-an-email", emailVerified: true })).toBeUndefined();
    expect(validatedDisplayProfile({ name: "x".repeat(121) })).toBeUndefined();
  });
});

describe("hosted profile and roster handlers", () => {
  it("caches masked claims and refreshes them on an exact bootstrap replay", async () => {
    const f = fixture("owner", { name: "Josh", email: "private@example.com", emailVerified: true });
    const args = { idempotencyKey: "bootstrap", initialWorkspaceName: "A" };
    const first = await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(first.status).toBe("created");
    expect(f.tables.internal_users[0].profile).toEqual({ displayName: "Josh", emailHint: "p***@example.com" });
    expect(JSON.stringify(f.tables)).not.toContain("private@example.com");

    f.setIdentityClaims({ name: "Joshua", email: "changed@example.com", emailVerified: true });
    const replay = await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(replay).toMatchObject({ status: "created", idempotency: { key: "bootstrap", replayed: true } });
    expect(f.tables.internal_users[0].profile).toEqual({ displayName: "Joshua", emailHint: "c***@example.com" });
    expect(f.tables.workspaces).toHaveLength(1);
    expect(f.tables.workspace_memberships).toHaveLength(1);
  });

  it("clears a cached hint when current validated claims no longer share it", async () => {
    const f = fixture("owner", { email: "private@example.com", emailVerified: true });
    const args = { idempotencyKey: "bootstrap", initialWorkspaceName: "A" };
    await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(f.tables.internal_users[0].profile).toEqual({ emailHint: "p***@example.com" });

    f.setIdentityClaims({ email: "private@example.com", emailVerified: false });
    await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(f.tables.internal_users[0].profile).toBeUndefined();
    expect(f.tables.internal_users[0].profileObservedAt).toEqual(expect.any(Number));
  });

  it("rejects an exact bootstrap replay after its owner membership becomes inactive", async () => {
    const f = fixture("owner", { name: "Owner" });
    const args = { idempotencyKey: "bootstrap", initialWorkspaceName: "A" };
    await (bootstrapAccount as any)._handler(f.ctx, args);
    f.tables.workspace_memberships[0].status = "suspended";
    f.setIdentityClaims({ name: "Changed" });

    await expect((bootstrapAccount as any)._handler(f.ctx, args)).resolves.toEqual({ status: "rejected", code: "workspace-unavailable" });
    expect(f.tables.internal_users[0].profile).toEqual({ displayName: "Owner" });
  });

  it("keeps bootstrap available after a legitimate role change", async () => {
    const f = fixture("owner", { name: "Owner" });
    const firstArgs = { idempotencyKey: "bootstrap", initialWorkspaceName: "A" };
    const first = await (bootstrapAccount as any)._handler(f.ctx, firstArgs);
    f.tables.workspace_memberships[0].role = "editor";

    await expect((bootstrapAccount as any)._handler(f.ctx, firstArgs)).resolves.toMatchObject({ status: "created", memberId: first.memberId });
    await expect((bootstrapAccount as any)._handler(f.ctx, { ...firstArgs, idempotencyKey: "bootstrap-2" })).resolves.toMatchObject({ status: "existing", memberId: first.memberId });
  });

  it("returns only the authorized workspace roster with fresh display hints", async () => {
    const f = fixture("owner", { name: "Owner" });
    const bootstrap = await (bootstrapAccount as any)._handler(f.ctx, { idempotencyKey: "bootstrap", initialWorkspaceName: "A" });
    const workspaceId = bootstrap.workspaceId;
    f.tables.internal_users.push({ _id: "user:other", internalUserId: "u-other", status: "active", profile: { displayName: "Other", emailHint: "o***@example.com" }, profileObservedAt: Date.now(), createdAt: 1, updatedAt: 1, revision: 1 });
    f.tables.workspace_memberships.push({ _id: "membership:other", memberId: "member-other", workspaceId, internalUserId: "u-other", role: "viewer", status: "suspended", revision: 2, createdAt: 1, updatedAt: 1, activatedAt: 1 });

    const roster = await (listRoster as any)._handler(f.ctx, { workspaceId });
    expect(roster).toMatchObject({ workspaceId, actorRole: "owner" });
    expect(roster.members).toHaveLength(2);
    expect(roster.members.find((member: any) => member.memberId === "member-other")).toMatchObject({ role: "viewer", status: "suspended", displayName: "Other", isCurrentUser: false });
    expect(roster.members.find((member: any) => member.isCurrentUser)).toMatchObject({ role: "owner", displayName: "Owner" });
    expect(JSON.stringify(roster)).not.toContain("u-other");

    await expect((listRoster as any)._handler(f.ctx, { workspaceId: "ws-foreign" })).rejects.toThrow(/workspace/i);
  });

  it("fails closed for an ambiguous user and omits stale profiles", async () => {
    const f = fixture("owner", { name: "Owner" });
    const bootstrap = await (bootstrapAccount as any)._handler(f.ctx, { idempotencyKey: "bootstrap", initialWorkspaceName: "A" });
    f.tables.internal_users[0].profileObservedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const roster = await (listRoster as any)._handler(f.ctx, { workspaceId: bootstrap.workspaceId });
    expect(roster.members[0]).not.toHaveProperty("displayName");

    f.tables.internal_users.push({ ...f.tables.internal_users[0], _id: "user:duplicate" });
    await expect((listRoster as any)._handler(f.ctx, { workspaceId: bootstrap.workspaceId })).rejects.toThrow(/unavailable/i);
  });
});
