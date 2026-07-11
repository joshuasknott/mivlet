import { describe, expect, it } from "vitest";
import {
  acceptInvitationToState,
  changeMembershipToState,
  createInvitationToState,
  listRecipientPendingInvitationsToState,
  listWorkspaceInvitationsToState,
  projectMemberManagement,
  revokeInvitationToState,
  type CloudIdentity,
  type CloudMembership,
  type MembershipLifecycleState,
} from "./cloudPolicy";

const issuer = "https://issuer.example";
const owner: CloudIdentity = { provider: "clerk", normalizedIssuer: issuer, subject: "owner", sessionRef: "session:001" };
const admin: CloudIdentity = { provider: "clerk", normalizedIssuer: issuer, subject: "admin", sessionRef: "session:002" };
const recipient: CloudIdentity = { provider: "clerk", normalizedIssuer: issuer, subject: "recipient", sessionRef: "session:003" };
const outsider: CloudIdentity = { provider: "clerk", normalizedIssuer: issuer, subject: "outsider", sessionRef: "session:004" };

function state(): MembershipLifecycleState {
  return {
    users: ["owner", "admin", "recipient", "outsider"].map((name) => ({ internalUserId: `u-${name}`, status: "active" as const })),
    identityLinks: ["owner", "admin", "recipient", "outsider"].map((name) => ({ provider: "clerk" as const, normalizedIssuer: issuer, subject: name, internalUserId: `u-${name}`, status: "active" as const })),
    workspaces: [{ workspaceId: "ws-a", name: "A", status: "active", revision: 0, policyRevision: 1 }, { workspaceId: "ws-b", name: "B", status: "active", revision: 0, policyRevision: 1 }],
    memberships: [
      { memberId: "m-owner", workspaceId: "ws-a", internalUserId: "u-owner", role: "owner", status: "active", revision: 1, createdAt: 1, updatedAt: 1, activatedAt: 1 },
      { memberId: "m-admin", workspaceId: "ws-a", internalUserId: "u-admin", role: "admin", status: "active", revision: 1, createdAt: 1, updatedAt: 1, activatedAt: 1 },
    ],
    devices: [{ deviceId: "d-owner", internalUserId: "u-owner", status: "active" }, { deviceId: "d-recipient", internalUserId: "u-recipient", status: "active" }],
    deviceLinks: [{ workspaceId: "ws-a", deviceId: "d-owner", internalUserId: "u-owner", memberId: "m-owner", status: "active" }],
    projects: [], tombstones: [], idempotencyKeys: [], invitations: [], lifecycleReceipts: [], lifecycleAudit: [],
  };
}
function create(s: MembershipLifecycleState, overrides: Partial<Parameters<typeof createInvitationToState>[2]> = {}, now = 100) {
  return createInvitationToState(s, owner, { workspaceId: "ws-a", role: "editor", recipientInternalUserId: "u-recipient", expiresAt: 1_000, idempotencyKey: "create-1", invitationId: "inv-1", ...overrides }, now);
}

describe("hosted membership lifecycle", () => {
  it("runs the deterministic two-principal invitation through removal", () => {
    const s = state(); const created = create(s);
    expect(created).toMatchObject({ status: "accepted", invitation: { authority: "convex", status: "pending", recipientConstraint: { kind: "internal-user", internalUserId: "u-recipient" } }, idempotency: { replayed: false } });
    expect(create(s)).toMatchObject({ status: "accepted", idempotency: { replayed: true } });
    expect(create(s, { role: "viewer" })).toMatchObject({ status: "conflict", code: "idempotency-conflict" });
    expect(listRecipientPendingInvitationsToState(s, recipient, 110)[0]).toMatchObject({ selection: { kind: "direct-inbox", invitationId: "inv-1" } });

    const accepted = acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "accept-1" }, 120);
    expect(accepted).toMatchObject({ status: "accepted", invitation: { status: "accepted", acceptedByInternalUserId: "u-recipient" }, membership: { role: "editor", status: "active", revision: 1 } });
    const memberId = accepted.status === "accepted" ? accepted.membership!.memberId : "";
    expect(acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "accept-2" }, 121)).toMatchObject({ status: "conflict", code: "invitation-already-consumed" });

    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "change-role", role: "viewer", baseRevision: 1, idempotencyKey: "role-1" }, 130)).toMatchObject({ status: "accepted", membership: { role: "viewer", status: "active", revision: 2 } });
    s.deviceLinks.push({ workspaceId: "ws-a", deviceId: "d-recipient", internalUserId: "u-recipient", memberId, status: "active" });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "suspend", baseRevision: 2, idempotencyKey: "suspend-1" }, 140)).toMatchObject({ status: "accepted", membership: { status: "suspended", revision: 3 } });
    expect(s.deviceLinks.find((link) => link.deviceId === "d-recipient")).toMatchObject({ status: "revoked", revokedAt: 140 });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "change-role", role: "editor", baseRevision: 3, idempotencyKey: "role-2" }, 150)).toMatchObject({ status: "accepted", membership: { role: "editor", status: "suspended", revision: 4 } });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "reactivate", baseRevision: 4, idempotencyKey: "reactivate-1" }, 160)).toMatchObject({ status: "accepted", membership: { status: "active", revision: 5 } });
    expect(s.deviceLinks.find((link) => link.deviceId === "d-recipient")?.status).toBe("revoked");
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "remove", baseRevision: 5, idempotencyKey: "remove-1" }, 170)).toMatchObject({ status: "accepted", membership: { status: "removed", revision: 6 } });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "reactivate", baseRevision: 6, idempotencyKey: "reactivate-removed" }, 180)).toMatchObject({ status: "conflict", code: "conflict" });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId, action: "change-role", role: "viewer", baseRevision: 6, idempotencyKey: "role-removed" }, 181)).toMatchObject({ status: "conflict", code: "conflict" });
    expect(s.memberships.find((entry) => entry.memberId === memberId)).toMatchObject({ role: "editor", status: "removed", revision: 6 });
    expect(s.lifecycleAudit.every((entry) => !Object.values(entry).some((value) => typeof value === "string" && value.includes("bearer")))).toBe(true);
    expect(s.lifecycleAudit.find((entry) => entry.operation === "membership.change")).toMatchObject({ actorInternalUserId: "u-owner", actorMemberId: "m-owner", deviceId: "d-owner", sessionRef: "session:001" });
    expect(JSON.stringify(s.lifecycleAudit)).not.toContain("issuer.example");
  });

  it("allows invitation acceptance to reactivate one suspended membership but never a removed one", () => {
    const suspended = state(); suspended.memberships.push({ memberId: "m-recipient", workspaceId: "ws-a", internalUserId: "u-recipient", role: "viewer", status: "suspended", revision: 4, createdAt: 1, updatedAt: 50, activatedAt: 1, suspendedAt: 50 });
    expect(create(suspended)).toMatchObject({ status: "accepted" });
    expect(acceptInvitationToState(suspended, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "accept" }, 120)).toMatchObject({ status: "accepted", membership: { memberId: "m-recipient", role: "editor", status: "active", revision: 5 } });
    const removed = state(); removed.memberships.push({ memberId: "m-recipient", workspaceId: "ws-a", internalUserId: "u-recipient", role: "viewer", status: "removed", revision: 4, createdAt: 1, updatedAt: 50, activatedAt: 1, removedAt: 50 });
    expect(create(removed)).toMatchObject({ status: "rejected", code: "invitation-unavailable" });
  });

  it("normalizes expiry in query projections and rejects expired acceptance", () => {
    const s = state(); create(s, { expiresAt: 150 });
    expect(listWorkspaceInvitationsToState(s, owner, "ws-a", 151)).toMatchObject([{ status: "expired" }]);
    expect(listRecipientPendingInvitationsToState(s, recipient, 151)).toEqual([]);
    expect(s.invitations[0].status).toBe("pending");
    expect(acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "accept" }, 151)).toMatchObject({ status: "conflict", code: "invitation-expired" });
    expect(s.invitations[0].status).toBe("expired");
  });

  it("rejects wrong recipient and wrong presentation reference without consuming the invitation", () => {
    const s = state(); create(s);
    expect(acceptInvitationToState(s, outsider, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "wrong-user" }, 120)).toMatchObject({ status: "rejected", code: "invitation-recipient-mismatch" });
    const rejected = acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "other" }, idempotencyKey: "wrong-ref" }, 120);
    expect(rejected).toMatchObject({ status: "rejected", code: "invitation-unavailable" });
    expect(acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "other" }, idempotencyKey: "wrong-ref" }, 121)).toEqual(rejected);
    expect(s.invitations[0].status).toBe("pending");
  });

  it("rejects duplicate pending targets and supports explicit revocation", () => {
    const s = state(); create(s);
    expect(create(s, { idempotencyKey: "create-2", invitationId: "inv-2" })).toMatchObject({ status: "rejected", code: "invitation-unavailable" });
    expect(revokeInvitationToState(s, owner, { workspaceId: "ws-a", invitationId: "inv-1", idempotencyKey: "revoke" }, 120)).toMatchObject({ status: "accepted", invitation: { status: "revoked", revokedByMemberId: "m-owner" } });
    expect(acceptInvitationToState(s, recipient, { invitationId: "inv-1", presentation: { kind: "direct-inbox", invitationId: "inv-1" }, idempotencyKey: "accept" }, 130)).toMatchObject({ status: "conflict", code: "invitation-already-consumed" });
  });

  it("enforces admin owner boundaries, final-owner safety, stale revisions, and workspace scope", () => {
    const s = state();
    expect(createInvitationToState(s, admin, { workspaceId: "ws-a", role: "owner", recipientInternalUserId: "u-recipient", expiresAt: 1_000, idempotencyKey: "admin-owner", invitationId: "inv-admin" }, 100)).toMatchObject({ status: "rejected", code: "role-assignment-denied" });
    s.memberships.push({ memberId: "m-outsider-owner", workspaceId: "ws-a", internalUserId: "u-outsider", role: "owner", status: "suspended", revision: 2, createdAt: 1, updatedAt: 50, activatedAt: 1, suspendedAt: 50 });
    expect(createInvitationToState(s, admin, { workspaceId: "ws-a", role: "editor", recipientInternalUserId: "u-outsider", expiresAt: 1_000, idempotencyKey: "admin-existing-owner", invitationId: "inv-existing-owner" }, 100)).toMatchObject({ status: "rejected", code: "role-assignment-denied" });
    expect(changeMembershipToState(s, admin, { workspaceId: "ws-a", memberId: "m-owner", action: "change-role", role: "admin", baseRevision: 1, idempotencyKey: "manage-owner" }, 100)).toMatchObject({ status: "rejected", code: "role-assignment-denied" });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId: "m-owner", action: "remove", baseRevision: 1, idempotencyKey: "self-remove" }, 100)).toMatchObject({ status: "rejected", code: "permission-denied" });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId: "m-admin", action: "change-role", role: "admin", baseRevision: 1, idempotencyKey: "same-role" }, 100)).toMatchObject({ status: "conflict", code: "conflict" });
    expect(changeMembershipToState(s, owner, { workspaceId: "ws-a", memberId: "m-admin", action: "suspend", baseRevision: 99, idempotencyKey: "stale" }, 100)).toMatchObject({ status: "conflict", code: "stale-revision" });
    expect(() => changeMembershipToState(s, owner, { workspaceId: "ws-b", memberId: "m-admin", action: "suspend", baseRevision: 1, idempotencyKey: "cross" }, 100)).toThrow(/membership/i);
  });

  it("projects exact actions without granting self, non-manager, or admin-to-owner controls", () => {
    const s = state();
    const ownerMember = s.memberships.find((member) => member.memberId === "m-owner")!;
    const adminMember = s.memberships.find((member) => member.memberId === "m-admin")!;
    const editorMember: CloudMembership = { memberId: "m-editor", workspaceId: "ws-a", internalUserId: "u-recipient", role: "editor", status: "active", revision: 1 };
    s.memberships.push(editorMember);

    expect(projectMemberManagement(s, ownerMember, ownerMember)).toEqual({
      allowedRoles: [], allowedActions: [], blockedReason: "last-active-owner",
    });
    expect(projectMemberManagement(s, ownerMember, adminMember)).toEqual({
      allowedRoles: ["owner", "editor", "viewer"], allowedActions: ["suspend", "remove"],
    });
    expect(projectMemberManagement(s, adminMember, ownerMember)).toEqual({
      allowedRoles: [], allowedActions: [], blockedReason: "owner-protected",
    });
    expect(projectMemberManagement(s, adminMember, editorMember)).toEqual({
      allowedRoles: ["admin", "viewer"], allowedActions: ["suspend", "remove"],
    });
    expect(projectMemberManagement(s, editorMember, adminMember)).toEqual({
      allowedRoles: [], allowedActions: [], blockedReason: "permission-denied",
    });

    editorMember.status = "suspended";
    expect(projectMemberManagement(s, ownerMember, editorMember).allowedActions).toEqual(["reactivate", "remove"]);
  });
});
