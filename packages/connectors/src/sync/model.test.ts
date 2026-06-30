import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CACHE_POLICIES,
  classifyConnectorSyncError,
  completeConnectorSync,
  failConnectorSync,
  initialConnectorSyncState,
  startConnectorSync
} from "./model";

describe("connector sync state", () => {
  it("moves through manual sync success without crossing workspaces", () => {
    const idle = initialConnectorSyncState("github", "workspace-1");
    const syncing = startConnectorSync(idle, "manual", "2026-06-30T10:00:00.000Z");
    const complete = completeConnectorSync(syncing, "2026-06-30T10:00:02.000Z", {
      itemsProcessed: 12,
      cursor: "opaque-cursor"
    });

    expect(syncing).toMatchObject({ phase: "syncing", attempt: 1, workspaceId: "workspace-1" });
    expect(complete).toMatchObject({
      phase: "succeeded",
      itemsProcessed: 12,
      cursor: "opaque-cursor",
      lastSuccessfulAt: "2026-06-30T10:00:02.000Z",
      workspaceId: "workspace-1"
    });
  });

  it("tracks retries and preserves the last successful sync on partial results", () => {
    const syncing = startConnectorSync(
      { ...initialConnectorSyncState("gmail", "workspace-1"), attempt: 1 },
      "retry",
      "2026-06-30T10:01:00.000Z"
    );
    const partial = completeConnectorSync(syncing, "2026-06-30T10:01:02.000Z", {
      itemsProcessed: 3,
      partialMessage: "One page could not be read."
    });

    expect(syncing.attempt).toBe(2);
    expect(partial).toMatchObject({
      phase: "partial",
      failure: { kind: "partial-sync", retryable: true }
    });
    expect(partial.lastSuccessfulAt).toBeUndefined();
  });

  it.each([
    ["needs-auth", "auth-required", false],
    ["refresh-rejected", "auth-required", false],
    ["permission-denied", "permission-denied", false],
    ["provider-unavailable", "provider-unavailable", true],
    ["rate-limited", "rate-limited", true],
    ["cancelled", "cancelled", false]
  ] as const)("normalizes %s as %s", (code, kind, retryable) => {
    expect(classifyConnectorSyncError({ code, message: "safe", retryable: true })).toEqual({
      kind,
      message: "safe",
      retryable,
      retryAfter: undefined
    });
  });

  it("schedules only retryable failures", () => {
    const syncing = startConnectorSync(
      initialConnectorSyncState("slack", "workspace-1"),
      "background",
      "2026-06-30T10:00:00.000Z"
    );
    const failed = failConnectorSync(
      syncing,
      { code: "provider-unavailable", message: "Unavailable", retryable: true },
      "2026-06-30T10:00:01.000Z",
      "2026-06-30T10:05:01.000Z"
    );
    expect(failed.nextRetryAt).toBe("2026-06-30T10:05:01.000Z");
  });

  it("rejects invalid workspace boundaries", () => {
    expect(() => initialConnectorSyncState("github", "../other-workspace")).toThrow(
      /valid local workspace id/
    );
  });

  it("makes export and deletion behavior explicit for every cache class", () => {
    expect(CONNECTOR_CACHE_POLICIES.metadata).toMatchObject({
      persistence: "encrypted-local",
      exportedWithWorkspace: true,
      deletedWithWorkspace: true
    });
    expect(CONNECTOR_CACHE_POLICIES["user-owned-data"]).toMatchObject({
      persistence: "prohibited",
      exportedWithWorkspace: false,
      deletedWithWorkspace: true
    });
  });
});
