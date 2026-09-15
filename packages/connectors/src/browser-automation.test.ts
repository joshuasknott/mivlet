import { describe, expect, it } from "vitest";
import {
  BrowserAutomationBoundary,
  createBrowserAutomationSession
} from "./browser-automation";
import type { BrowserAutomationActionRequest } from "@mivlet/protocol";

const session = createBrowserAutomationSession({
  id: "browser-session-1",
  runId: "run-1",
  createdAt: "2026-07-02T10:00:00.000Z",
  expiresAt: "2026-07-02T10:15:00.000Z",
  permissionMode: "trusted-scope",
  permissionProfile: "trusted"
});

function request(
  overrides: Partial<BrowserAutomationActionRequest> = {}
): BrowserAutomationActionRequest {
  return {
    id: "action-1",
    runId: "run-1",
    sessionId: "browser-session-1",
    action: "browser.click",
    requestedAt: "2026-07-02T10:01:00.000Z",
    targetLabel: "Save",
    pageOrigin: "https://example.test",
    arguments: { selector: "#save" },
    ...overrides
  };
}

describe("BrowserAutomationBoundary", () => {
  it("fails closed when browser automation transport is unavailable", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: false,
      now: new Date("2026-07-02T10:02:00.000Z")
    });
    const result = guard.prepare(request());

    expect(result.decision).toMatchObject({
      status: "unavailable",
      failureCode: "transport-unavailable"
    });
    expect(result.audit.map((event) => event.status)).toEqual(["attempted", "unavailable"]);
  });

  it("denies unsupported actions and read-only consequential actions", () => {
    const unsupported = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    }).prepare(request({ action: "browser.dom-dump" }));
    expect(unsupported.decision).toMatchObject({
      status: "denied",
      failureCode: "unsupported-action"
    });

    const readOnly = createBrowserAutomationSession({
      ...session,
      permissionMode: "read-only",
      permissionProfile: "read-only"
    });
    const denied = new BrowserAutomationBoundary(readOnly, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    }).prepare(request());
    expect(denied.decision).toMatchObject({
      status: "denied",
      failureCode: "permission-denied"
    });
  });

  it("allows safe browser reads without approval", () => {
    const guard = new BrowserAutomationBoundary(
      createBrowserAutomationSession({
        ...session,
        permissionMode: "read-only",
        permissionProfile: "read-only"
      }),
      { transportAvailable: true, now: new Date("2026-07-02T10:02:00.000Z") }
    );
    const result = guard.prepare(request({ action: "browser.read-url" }));

    expect(result.decision).toMatchObject({
      status: "safe/read-only",
      riskLevel: "low"
    });
    expect(result.decision.approval).toBeUndefined();
  });

  it("requires and records explicit approval before consequential completion", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });

    const prepared = guard.prepare(request());
    expect(prepared.decision.status).toBe("approval-required");
    expect(prepared.decision.approval).toMatchObject({
      service: "browser-automation",
      action: "browser.click",
      decisions: ["once", "deny"]
    });

    const approved = guard.resolveApproval(request(), "once");
    expect(approved.decision.status).toBe("approved");
    expect(approved.audit.at(-1)?.status).toBe("approved");

    const completed = guard.complete(request(), { ok: true });
    expect(completed.decision.status).toBe("completed");
    expect(completed.audit.at(-1)?.status).toBe("completed");
  });

  it("records denied and failed browser outcomes without executing silently", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });

    guard.prepare(request({ id: "denied-action" }));
    const denied = guard.resolveApproval(request({ id: "denied-action" }), "deny");
    expect(denied.decision).toMatchObject({
      status: "denied",
      failureCode: "approval-denied"
    });
    expect(denied.audit.at(-1)?.status).toBe("denied");

    guard.prepare(request({ id: "failed-action" }));
    guard.resolveApproval(request({ id: "failed-action" }), "once");
    const failed = guard.complete(request({ id: "failed-action" }), {
      ok: false,
      message: "Browser command failed."
    });
    expect(failed.decision).toMatchObject({
      status: "failed",
      failureCode: "execution-failed"
    });
    expect(failed.audit.at(-1)?.status).toBe("failed");
  });

  it("rejects stale, replayed, cross-session, and cross-run actions", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });

    expect(
      guard.prepare(request({ requestedAt: "2026-07-02T09:59:59.000Z" })).decision
    ).toMatchObject({ status: "denied", failureCode: "stale-action" });
    expect(guard.prepare(request({ id: "replay-me" })).decision.status).toBe(
      "approval-required"
    );
    expect(guard.prepare(request({ id: "replay-me" })).decision).toMatchObject({
      status: "denied",
      failureCode: "replayed-action"
    });
    expect(guard.prepare(request({ id: "cross-session", sessionId: "other" })).decision).toMatchObject({
      status: "denied",
      failureCode: "cross-session"
    });
    expect(guard.prepare(request({ id: "cross-run", runId: "other" })).decision).toMatchObject({
      status: "denied",
      failureCode: "cross-run"
    });
  });

  it("rejects resolveApproval and complete for stale, cross-session, or cross-run actions", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });

    // Prepare a valid action first
    guard.prepare(request({ id: "stale-test" }));

    // resolveApproval rejects stale/cross-session/cross-run
    expect(
      guard.resolveApproval(request({ id: "stale-test", requestedAt: "2026-07-02T09:59:59.000Z" }), "once").decision
    ).toMatchObject({ status: "denied", failureCode: "stale-action" });

    expect(
      guard.resolveApproval(request({ id: "stale-test", sessionId: "other" }), "once").decision
    ).toMatchObject({ status: "denied", failureCode: "cross-session" });

    expect(
      guard.resolveApproval(request({ id: "stale-test", runId: "other" }), "once").decision
    ).toMatchObject({ status: "denied", failureCode: "cross-run" });

    // complete rejects stale/cross-session/cross-run
    expect(
      guard.complete(request({ id: "stale-test", requestedAt: "2026-07-02T09:59:59.000Z" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "stale-action" });

    expect(
      guard.complete(request({ id: "stale-test", sessionId: "other" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "cross-session" });

    expect(
      guard.complete(request({ id: "stale-test", runId: "other" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "cross-run" });
  });

  it("fails closed on resolveApproval and complete when approval is missing, replayed, or never prepared", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });

    // Never prepared
    expect(
      guard.resolveApproval(request({ id: "never-prepared" }), "once").decision
    ).toMatchObject({ status: "denied", failureCode: "approval-missing" });

    expect(
      guard.complete(request({ id: "never-prepared" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "approval-missing" });

    // Prepared but not approved yet when completing
    guard.prepare(request({ id: "prepared-only" }));
    expect(
      guard.complete(request({ id: "prepared-only" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "approval-missing" });

    // Replayed complete
    guard.prepare(request({ id: "replay-complete" }));
    guard.resolveApproval(request({ id: "replay-complete" }), "once");
    guard.complete(request({ id: "replay-complete" }), { ok: true });
    expect(
      guard.complete(request({ id: "replay-complete" }), { ok: true }).decision
    ).toMatchObject({ status: "denied", failureCode: "replayed-action" });
  });

  it("redacts audit records and never persists browser contents or argument values", () => {
    const guard = new BrowserAutomationBoundary(session, {
      transportAvailable: true,
      now: new Date("2026-07-02T10:02:00.000Z")
    });
    const result = guard.prepare(
      request({
        id: "redaction",
        action: "browser.type",
        targetLabel: "clipboard secret body: ghp_supersecret",
        pageOrigin: "https://example.test?access_token=secret",
        arguments: {
          selector: "#password",
          text: "this should never be logged",
          cookies: "session=secret"
        }
      })
    );

    const serialized = JSON.stringify(result.audit);
    expect(serialized).not.toContain("this should never be logged");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain("ghp_supersecret");
    expect(serialized).not.toContain("access_token=secret");
    expect(serialized).toContain("[redacted]");
    expect(result.audit.at(-1)?.detail).toMatchObject({
      hasArguments: true
    });
  });
});
