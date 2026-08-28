import { describe, expect, it } from "vitest";
import { validatedDisplayProfile } from "./convexAuth";
import { bootstrapAccount } from "./workspace";

type Doc = Record<string, any> & { _id: string };
type Tables = Record<string, Doc[]>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];

  constructor(private readonly docs: Doc[]) {}

  withIndex(
    _index: string,
    build: (query: { eq: (field: string, value: unknown) => any }) => unknown,
  ) {
    const query = {
      eq: (field: string, value: unknown): any => {
        this.filters.push([field, value]);
        return query;
      },
    };
    build(query);
    return this;
  }

  async collect() {
    return this.docs.filter((doc) =>
      this.filters.every(([field, value]) => doc[field] === value),
    );
  }
}

function fixture(extraIdentity: Record<string, unknown> = {}) {
  const tables: Tables = {
    internal_users: [],
    external_identity_links: [],
    workspaces: [],
    workspace_memberships: [],
    bootstrap_idempotency: [],
    account_devices: [],
    workspace_device_links: [],
  };
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
    auth: {
      getUserIdentity: async () => ({
        subject: "owner",
        issuer: "https://issuer.example",
        tokenIdentifier: "https://issuer.example|owner",
        ...identityClaims,
      }),
    },
  };
  return {
    ctx,
    tables,
    setIdentityClaims: (next: Record<string, unknown>) => {
      identityClaims = next;
    },
  };
}

describe("optional hosted account bootstrap", () => {
  it("normalizes a name and masks only a verified email", () => {
    expect(
      validatedDisplayProfile({
        name: "  Jo\u202esh   Smith  ",
        email: "Josh@Example.COM",
        emailVerified: true,
      }),
    ).toEqual({
      displayName: "Josh Smith",
      emailHint: "J***@example.com",
    });
    expect(
      validatedDisplayProfile({
        email: "secret@example.com",
        emailVerified: false,
      }),
    ).toBeUndefined();
  });

  it("creates exactly one personal hosted workspace and replays safely", async () => {
    const f = fixture({
      name: "Josh",
      email: "private@example.com",
      emailVerified: true,
    });
    const args = { idempotencyKey: "bootstrap", initialWorkspaceName: "Personal" };
    const first = await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(first.status).toBe("created");
    expect(f.tables.internal_users[0].profile).toEqual({
      displayName: "Josh",
      emailHint: "p***@example.com",
    });
    expect(JSON.stringify(f.tables)).not.toContain("private@example.com");

    f.setIdentityClaims({ name: "Joshua" });
    const replay = await (bootstrapAccount as any)._handler(f.ctx, args);
    expect(replay).toMatchObject({
      status: "created",
      idempotency: { key: "bootstrap", replayed: true },
    });
    expect(f.tables.workspaces).toHaveLength(1);
    expect(f.tables.workspace_memberships).toHaveLength(1);
  });

  it("fails closed when the bootstrap owner is no longer active", async () => {
    const f = fixture({ name: "Owner" });
    const args = { idempotencyKey: "bootstrap", initialWorkspaceName: "Personal" };
    await (bootstrapAccount as any)._handler(f.ctx, args);
    f.tables.workspace_memberships[0].status = "suspended";

    await expect((bootstrapAccount as any)._handler(f.ctx, args)).resolves.toEqual({
      status: "rejected",
      code: "workspace-unavailable",
    });
  });

  it("rejects idempotency-key reuse with a different bootstrap intent", async () => {
    const f = fixture();
    await (bootstrapAccount as any)._handler(f.ctx, {
      idempotencyKey: "bootstrap",
      initialWorkspaceName: "Personal",
    });
    await expect(
      (bootstrapAccount as any)._handler(f.ctx, {
        idempotencyKey: "bootstrap",
        initialWorkspaceName: "Different",
      }),
    ).resolves.toEqual({ status: "conflict", code: "idempotency-conflict" });
  });
});
