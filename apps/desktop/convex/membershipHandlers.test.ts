import { describe, expect, it } from "vitest";
import { acceptInvitation, createInvitation, listRecipientPending } from "./membership";

type Doc = Record<string, any> & { _id: string };
type Tables = Record<string, Doc[]>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];
  constructor(private readonly docs: Doc[]) {}
  withIndex(_index: string, build: (query: { eq: (field: string, value: unknown) => any }) => unknown) {
    const query = { eq: (field: string, value: unknown): any => { this.filters.push([field, value]); return query; } };
    build(query); return this;
  }
  async collect() { return this.docs.filter((doc) => this.filters.every(([field, value]) => doc[field] === value)); }
  async first() { return (await this.collect())[0]; }
}

function fixture(subject = "owner") {
  const now = Date.now();
  const tables: Tables = {
    internal_users: ["owner", "editor", "recipient"].map((name) => ({ _id: `user:${name}`, internalUserId: `u-${name}`, status: "active", createdAt: 1, updatedAt: 1, revision: 1 })),
    external_identity_links: ["owner", "editor", "recipient"].map((name) => ({ _id: `identity:${name}`, externalIdentityId: `identity-${name}`, provider: "clerk", normalizedIssuer: "https://issuer.example", subject: name, internalUserId: `u-${name}`, status: "active", lastValidatedAt: 1, createdAt: 1, updatedAt: 1, revision: 1 })),
    workspaces: [{ _id: "workspace:a", workspaceId: "ws-a", name: "A", status: "active", revision: 0, policyRevision: 1, createdByInternalUserId: "u-owner", createdAt: 1, updatedAt: 1 }],
    workspace_memberships: [
      { _id: "membership:owner", memberId: "m-owner", workspaceId: "ws-a", internalUserId: "u-owner", role: "owner", status: "active", revision: 1, createdAt: 1, updatedAt: 1, activatedAt: 1 },
      { _id: "membership:editor", memberId: "m-editor", workspaceId: "ws-a", internalUserId: "u-editor", role: "editor", status: "active", revision: 1, createdAt: 1, updatedAt: 1, activatedAt: 1 },
    ],
    workspace_invitations: [], membership_lifecycle_idempotency: [], membership_lifecycle_audit: [], workspace_device_links: [], account_devices: [],
  };
  let currentSubject = subject; let writes = 0; let sequence = 0;
  const db = {
    query: (table: string) => new FakeQuery(tables[table] ?? []),
    insert: async (table: string, value: Record<string, unknown>) => { writes += 1; const doc = { _id: `${table}:${++sequence}`, ...value }; (tables[table] ??= []).push(doc); return doc._id; },
    patch: async (id: string, value: Record<string, unknown>) => { writes += 1; const doc = Object.values(tables).flat().find((entry) => entry._id === id); if (!doc) throw new Error(`Missing ${id}`); Object.assign(doc, value); },
  };
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: currentSubject, issuer: "https://issuer.example", tokenIdentifier: `https://issuer.example|raw-${currentSubject}-token` }) } };
  return { ctx, tables, now, setSubject: (next: string) => { currentSubject = next; }, writes: () => writes };
}

const createArgs = (expiresAt: number, overrides: Record<string, unknown> = {}) => ({ workspaceId: "ws-a", role: "editor", recipientInternalUserId: "u-recipient", expiresAt, idempotencyKey: "create-key", ...overrides });
const direct = (invitationId: string, idempotencyKey = "accept-key") => ({ invitationId, presentation: { kind: "direct-inbox", invitationId }, idempotencyKey });

describe("registered hosted membership handlers", () => {
  it("authorizes before idempotency and performs no unauthorized writes", async () => {
    const f = fixture("editor");
    f.tables.membership_lifecycle_idempotency.push({ _id: "receipt:forged", actorInternalUserId: "u-owner", idempotencyKey: "create-key", operation: "invitation.create", intentFingerprint: "forged", result: { status: "accepted" }, createdAt: f.now });
    const before = f.writes();
    await expect((createInvitation as any)._handler(f.ctx, createArgs(f.now + 60_000))).rejects.toThrow(/role/i);
    expect(f.writes()).toBe(before);
    expect(f.tables.workspace_invitations).toHaveLength(0);
  });

  it("returns exact replay and rejects changed intent under the same key", async () => {
    const f = fixture(); const args = createArgs(f.now + 60_000);
    const first = await (createInvitation as any)._handler(f.ctx, args);
    expect(first).toMatchObject({ status: "accepted", invitation: { authority: "convex", status: "pending", recipientConstraint: { kind: "internal-user", internalUserId: "u-recipient" } }, idempotency: { key: "create-key", replayed: false } });
    expect(first.invitation).not.toHaveProperty("presentationRef");
    const writesAfterFirst = f.writes(); const replayed = await (createInvitation as any)._handler(f.ctx, args);
    expect(replayed).toEqual({ ...first, idempotency: { ...first.idempotency, replayed: true } });
    expect(f.writes()).toBe(writesAfterFirst);
    const changed = await (createInvitation as any)._handler(f.ctx, createArgs(f.now + 60_000, { role: "viewer" }));
    expect(changed).toEqual({ status: "conflict", error: { type: "authorization-error", code: "idempotency-conflict", message: "The requested membership operation is unavailable.", retryable: false, disclosure: "opaque" } });
    expect(f.tables.workspace_invitations).toHaveLength(1);
  });

  it("keeps recipient queries pure and returns only honest direct-inbox selection", async () => {
    const f = fixture("recipient");
    f.tables.workspace_invitations.push(
      { _id: "invite:active", invitationId: "inv-active", workspaceId: "ws-a", role: "editor", inviterMemberId: "m-owner", recipientKind: "internal-user", recipientInternalUserId: "u-recipient", status: "pending", expiresAt: f.now + 60_000, createdAt: 1, updatedAt: 1, createdByInternalUserId: "u-owner" },
      { _id: "invite:expired", invitationId: "inv-expired", workspaceId: "ws-a", role: "viewer", inviterMemberId: "m-owner", recipientKind: "internal-user", recipientInternalUserId: "u-recipient", status: "pending", expiresAt: f.now - 1, createdAt: 1, updatedAt: 1, createdByInternalUserId: "u-owner" },
    );
    const before = f.writes(); const result = await (listRecipientPending as any)._handler(f.ctx, {});
    expect(result).toEqual([{
      invitation: expect.objectContaining({ invitationId: "inv-active", status: "pending" }),
      selection: { kind: "direct-inbox", invitationId: "inv-active" },
      workspaceName: "A",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/proof|presentationRef/);
    expect(f.tables.workspace_invitations[1].status).toBe("pending");
    expect(f.writes()).toBe(before);
  });

  it("fails closed rather than inventing a workspace name for an inbox item", async () => {
    const f = fixture("recipient");
    f.tables.workspace_invitations.push({
      _id: "invite:active", invitationId: "inv-active", workspaceId: "ws-missing", role: "editor",
      inviterMemberId: "m-owner", recipientKind: "internal-user", recipientInternalUserId: "u-recipient",
      status: "pending", expiresAt: f.now + 60_000, createdAt: 1, updatedAt: 1,
      createdByInternalUserId: "u-owner",
    });
    await expect((listRecipientPending as any)._handler(f.ctx, {})).rejects.toThrow(/workspace/i);
    expect(f.writes()).toBe(0);
  });

  it("accepts only the authenticated direct-inbox recipient and consumes once", async () => {
    const f = fixture(); const created = await (createInvitation as any)._handler(f.ctx, createArgs(f.now + 60_000)); const invitationId = created.invitation.invitationId;
    f.setSubject("editor");
    const wrongRecipient = await (acceptInvitation as any)._handler(f.ctx, direct(invitationId, "wrong-recipient"));
    expect(wrongRecipient).toMatchObject({ status: "rejected", error: { code: "invitation-recipient-mismatch" } });
    expect(f.tables.workspace_invitations[0].status).toBe("pending");
    f.setSubject("recipient");
    const bearer = await (acceptInvitation as any)._handler(f.ctx, { invitationId, presentation: { kind: "bearer-proof", proof: { invitationId } }, idempotencyKey: "bearer" });
    expect(bearer).toMatchObject({ status: "rejected", error: { code: "invitation-unavailable" } });
    const accepted = await (acceptInvitation as any)._handler(f.ctx, direct(invitationId));
    expect(Object.keys(accepted).sort()).toEqual(["idempotency", "invitation", "membership", "status"]);
    expect(accepted).toMatchObject({ status: "accepted", invitation: { status: "accepted", acceptedByInternalUserId: "u-recipient" }, membership: { status: "active", role: "editor" }, idempotency: { replayed: false } });
    const replayWrites = f.writes(); expect(await (acceptInvitation as any)._handler(f.ctx, direct(invitationId))).toEqual({ ...accepted, idempotency: { ...accepted.idempotency, replayed: true } }); expect(f.writes()).toBe(replayWrites);
    expect(await (acceptInvitation as any)._handler(f.ctx, direct(invitationId, "consumed"))).toMatchObject({ status: "conflict", error: { code: "invitation-already-consumed" } });
    const audit = f.tables.membership_lifecycle_audit.find((entry) => entry.operation === "invitation.accept" && entry.outcome === "accepted");
    expect(audit).toBeDefined(); if (!audit) throw new Error("Expected accepted invitation audit");
    expect(audit.sessionRef).toMatch(/^session:[a-f0-9]{64}$/); expect(audit.sessionRef).not.toContain("raw-recipient-token"); expect(JSON.stringify(f.tables.membership_lifecycle_audit)).not.toContain("raw-recipient-token");
  });

  it("accepts migration-era invitations without presentationRef and rejects expiry", async () => {
    const f = fixture("recipient");
    f.tables.workspace_invitations.push({ _id: "invite:legacy", invitationId: "inv-legacy", workspaceId: "ws-a", role: "viewer", inviterMemberId: "m-owner", recipientKind: "internal-user", recipientInternalUserId: "u-recipient", status: "pending", expiresAt: f.now + 60_000, createdAt: 1, updatedAt: 1, createdByInternalUserId: "u-owner" });
    expect(await (acceptInvitation as any)._handler(f.ctx, direct("inv-legacy"))).toMatchObject({ status: "accepted", membership: { role: "viewer" } });
    f.tables.workspace_invitations.push({ _id: "invite:expired", invitationId: "inv-expired", workspaceId: "ws-a", role: "viewer", inviterMemberId: "m-owner", recipientKind: "internal-user", recipientInternalUserId: "u-recipient", status: "pending", expiresAt: f.now - 1, createdAt: 1, updatedAt: 1, createdByInternalUserId: "u-owner" });
    expect(await (acceptInvitation as any)._handler(f.ctx, direct("inv-expired", "expired"))).toMatchObject({ status: "conflict", error: { code: "invitation-expired" } });
    expect(f.tables.workspace_invitations.find((entry) => entry.invitationId === "inv-expired")?.status).toBe("expired");
  });
});
