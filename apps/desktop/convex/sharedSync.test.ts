import { describe, expect, it } from "vitest";
import { canonicalProjectPayload, projectRecord, projectTombstone, replayedMutation } from "./mutations";
import { workspaceDelta } from "./viewer";

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
