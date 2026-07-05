import { describe, expect, it } from "vitest";
import {
  applyOutboxMutationToState,
  CloudPolicyError,
  requireCanManageMembers,
  requireCanRead,
  type CloudState,
  type OutboxMutationArgs
} from "./cloudPolicy";

function state(): CloudState {
  return {
    workspaces: [
      { workspaceId: "ws-a", clerkOrgId: "org-a", name: "A", status: "active", revision: 0 },
      { workspaceId: "ws-b", clerkOrgId: "org-b", name: "B", status: "active", revision: 0 }
    ],
    memberships: [
      { workspaceId: "ws-a", clerkUserId: "user-owner", clerkOrgId: "org-a", role: "owner", status: "active" },
      { workspaceId: "ws-a", clerkUserId: "user-editor", clerkOrgId: "org-a", role: "editor", status: "active" },
      { workspaceId: "ws-a", clerkUserId: "user-viewer", clerkOrgId: "org-a", role: "viewer", status: "active" },
      { workspaceId: "ws-b", clerkUserId: "user-owner", clerkOrgId: "org-b", role: "owner", status: "active" }
    ],
    devices: [
      { workspaceId: "ws-a", deviceId: "device-owner", clerkUserId: "user-owner", status: "active" },
      { workspaceId: "ws-a", deviceId: "device-editor", clerkUserId: "user-editor", status: "active" },
      { workspaceId: "ws-a", deviceId: "device-viewer", clerkUserId: "user-viewer", status: "active" },
      { workspaceId: "ws-a", deviceId: "device-revoked", clerkUserId: "user-editor", status: "revoked" }
    ],
    projects: [],
    tombstones: [],
    idempotencyKeys: []
  };
}

function mutation(overrides: Partial<OutboxMutationArgs> = {}): OutboxMutationArgs {
  const base = {
    workspaceId: "ws-a",
    deviceId: "device-editor",
    clientMutationId: "cm-1",
    idempotencyKey: "ws-a:device-editor:cm-1",
    baseRevision: 0,
    recordType: "project",
    recordId: "project-1",
    operation: "create",
    payload: { name: "Launch" }
  } satisfies OutboxMutationArgs;
  return { ...base, ...overrides } as OutboxMutationArgs;
}

describe("Convex cloud sync policy", () => {
  it("fails closed without a Clerk identity", () => {
    expect(() => requireCanRead(state(), null, "ws-a")).toThrow(CloudPolicyError);
  });

  it("fails cross-workspace reads before returning data", () => {
    const s = state();
    expect(() => requireCanRead(s, { subject: "user-editor", orgId: "org-a" }, "ws-b")).toThrow(
      /organization|membership/i
    );
  });

  it("blocks cross-workspace mutations before changing records", () => {
    const s = state();
    const result = applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({
        workspaceId: "ws-b",
        idempotencyKey: "ws-b:device-editor:cm-1"
      })
    );
    expect(result.status).toBe("rejected");
    expect(s.projects).toHaveLength(0);
    expect(s.workspaces.find((workspace) => workspace.workspaceId === "ws-b")?.revision).toBe(0);
  });

  it("viewer cannot write and editor cannot manage membership", () => {
    const s = state();
    const write = applyOutboxMutationToState(
      s,
      { subject: "user-viewer", orgId: "org-a" },
      mutation({ deviceId: "device-viewer", idempotencyKey: "ws-a:device-viewer:cm-1" })
    );
    expect(write).toMatchObject({ status: "rejected", code: "role-denied" });
    expect(() => requireCanManageMembers(s, { subject: "user-editor", orgId: "org-a" }, "ws-a")).toThrow(
      /cannot manage/i
    );
  });

  it("revoked devices cannot flush outbox mutations", () => {
    const s = state();
    const result = applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({ deviceId: "device-revoked", idempotencyKey: "ws-a:device-revoked:cm-1" })
    );
    expect(result).toMatchObject({ status: "rejected", code: "device-revoked" });
    expect(s.projects).toHaveLength(0);
  });

  it("idempotency replay returns the same result without duplicate records", () => {
    const s = state();
    const first = applyOutboxMutationToState(s, { subject: "user-editor", orgId: "org-a" }, mutation());
    const replay = applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({ payload: { name: "Changed on retry" } })
    );
    expect(first).toEqual(replay);
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].name).toBe("Launch");
  });

  it("uses monotonic workspace-scoped revisions", () => {
    const s = state();
    const created = applyOutboxMutationToState(s, { subject: "user-editor", orgId: "org-a" }, mutation());
    expect(created).toMatchObject({ status: "accepted", revision: 1 });
    const updated = applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({
        clientMutationId: "cm-2",
        idempotencyKey: "ws-a:device-editor:cm-2",
        operation: "update",
        baseRevision: 1,
        payload: { name: "Launch v2" }
      })
    );
    expect(updated).toMatchObject({ status: "accepted", revision: 2 });
    expect(s.workspaces.find((workspace) => workspace.workspaceId === "ws-b")?.revision).toBe(0);
  });

  it("tombstones prevent stale update resurrection", () => {
    const s = state();
    applyOutboxMutationToState(s, { subject: "user-editor", orgId: "org-a" }, mutation());
    applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({
        clientMutationId: "cm-delete",
        idempotencyKey: "ws-a:device-editor:cm-delete",
        operation: "delete",
        baseRevision: 1
      }),
      100
    );
    const stale = applyOutboxMutationToState(
      s,
      { subject: "user-editor", orgId: "org-a" },
      mutation({
        clientMutationId: "cm-stale",
        idempotencyKey: "ws-a:device-editor:cm-stale",
        operation: "update",
        baseRevision: 1,
        payload: { name: "Resurrect" }
      })
    );
    expect(stale).toMatchObject({ status: "rejected", code: "tombstoned" });
    expect(s.projects[0].deletedAt).toBe(100);
  });
});
