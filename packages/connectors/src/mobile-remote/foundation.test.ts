import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  RemoteCommand,
  RemoteDevice,
  RemoteDeviceTrustState,
  RemoteSession,
  ScheduledJob
} from "@fable/protocol";
import {
  activateSession,
  createSession,
  revokeSession,
  touchSession,
  isSessionLive,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_LIFETIME_MS,
  type Now
} from "./session";
import {
  authorizeCommand,
  type PendingApprovalIndex,
  type RemoteDeviceIndex,
  type ScheduledJobIndex
} from "./authorization";
import { dispatchCommand, type RemoteCommandRuntime } from "./dispatcher";
import { redactSecrets } from "../commands/redact";

const T0 = "2026-06-29T12:00:00.000Z";
function clockAt(ms: number): Now {
  return () => new Date(new Date(T0).getTime() + ms).toISOString();
}

function pendingApproval(id: string): ApprovalRequest {
  return {
    id,
    service: "browser",
    action: "click-element",
    mode: "trusted-scope",
    riskLevel: "medium",
    dataUsed: ["css-selector"],
    consequence: "Clicks a browser element.",
    requestedAt: T0,
    decisions: ["once", "deny"]
  };
}

function scheduledJob(id: string): ScheduledJob {
  return {
    id,
    schemaVersion: 1,
    name: id,
    description: "test job",
    workflowDefinitionId: `wf-${id}`,
    trigger: { kind: "once", at: T0 },
    missedRunPolicy: "skip",
    status: "active",
    nextRunAt: "",
    lastRunAt: "",
    lastRunId: "",
    createdAt: T0,
    updatedAt: T0
  };
}

function remoteDevice(id: string, trustState: RemoteDeviceTrustState): RemoteDevice {
  return {
    id,
    label: id,
    trustState,
    firstPairedAt: T0,
    lastSeenAt: T0,
    revokedAt: trustState === "revoked" ? T0 : undefined
  };
}

function pendingIndex(approvals: ApprovalRequest[]): PendingApprovalIndex {
  const map = new Map(approvals.map((a) => [a.id, a]));
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id)
  };
}

function deviceIndex(devices: RemoteDevice[]): RemoteDeviceIndex {
  const map = new Map(devices.map((device) => [device.id, device]));
  return {
    get: (id) => map.get(id)
  };
}

function jobIndex(jobs: ScheduledJob[]): ScheduledJobIndex {
  const map = new Map(jobs.map((j) => [j.id, j]));
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id)
  };
}

function liveSession(deviceId = "device-1") {
  return activateSession(createSession(deviceId, clockAt(0), "session-1"), clockAt(0));
}

describe("Mobile Remote Control Foundation Integration Tests", () => {
  // 1. Unavailable behavior
  it("fails closed with transport-unavailable or invalid-command when dispatcher runtime fails", async () => {
    const rt: RemoteCommandRuntime = {
      resolveApproval: vi.fn(async () => {
        throw new Error("Transport connection is not available in this build.");
      }),
      setJobStatus: vi.fn(async () => {}),
      deleteJob: vi.fn(async () => {})
    };
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "once"
    };

    const result = await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-command");
      expect(result.message).toContain("Transport connection is not available");
    }
  });

  // 2. Denied behavior
  it("fails closed and rejects unauthorized commands without executing them", async () => {
    const rt = {
      resolveApproval: vi.fn(),
      setJobStatus: vi.fn(),
      deleteJob: vi.fn()
    };

    // Command is for an approval that does not exist in the pending approvals index (denied/not found)
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-missing",
      decision: "once"
    };

    const authResult = authorizeCommand({
      command,
      session: liveSession(),
      devices: deviceIndex([remoteDevice("device-1", "trusted")]),
      pendingApprovals: pendingIndex([]), // Empty -> missing
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });

    expect(authResult.ok).toBe(false);
    if (!authResult.ok) {
      expect(authResult.code).toBe("approval-not-found");
    }

    // Attempting to dispatch an unauthorized command with a stale session directly will fail closed
    const dispatchResult = await dispatchCommand({
      command,
      session: touchSession(revokeSession(liveSession(), clockAt(0)), clockAt(500)), // Revoked session
      runtime: rt,
      now: clockAt(1_000)
    });

    expect(dispatchResult.ok).toBe(false);
    expect(rt.resolveApproval).not.toHaveBeenCalled();
  });

  // 3. Approved-through-existing-boundary
  it("routes successful remote approvals through the existing desktop approval boundary and does not mint hidden permits", async () => {
    const resolveApprovalSpy = vi.fn();
    const rt: RemoteCommandRuntime = {
      resolveApproval: resolveApprovalSpy,
      setJobStatus: vi.fn(),
      deleteJob: vi.fn()
    };

    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "once"
    };

    const authResult = authorizeCommand({
      command,
      session: liveSession(),
      devices: deviceIndex([remoteDevice("device-1", "trusted")]),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });

    expect(authResult.ok).toBe(true);

    const dispatchResult = await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });

    expect(dispatchResult.ok).toBe(true);
    expect(resolveApprovalSpy).toHaveBeenCalledTimes(1);
    expect(resolveApprovalSpy).toHaveBeenCalledWith({
      approvalId: "appr-1",
      decision: "once"
    });

    // Remote approval only resolves the request in the queue; it does not directly invoke
    // the native permit-storage execution API, ensuring the desktop remains the only authority.
  });

  // 4. Expired/revoked/unpaired sessions
  it("fails closed when the session is expired, revoked, or unpaired", () => {
    const command: RemoteCommand = {
      type: "deny",
      approvalId: "appr-1"
    };
    const approvals = pendingIndex([pendingApproval("appr-1")]);

    // Unpaired device
    const unpairedResult = authorizeCommand({
      command,
      session: liveSession("unpaired-device"),
      devices: deviceIndex([remoteDevice("device-1", "trusted")]), // device-1 trusted, device-unpaired absent
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(unpairedResult.ok).toBe(false);
    if (!unpairedResult.ok) {
      expect(unpairedResult.code).toBe("device-unpaired");
    }

    // Revoked device
    const revokedDeviceResult = authorizeCommand({
      command,
      session: liveSession(),
      devices: deviceIndex([remoteDevice("device-1", "revoked")]),
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(revokedDeviceResult.ok).toBe(false);
    if (!revokedDeviceResult.ok) {
      expect(revokedDeviceResult.code).toBe("device-revoked");
    }

    // Expired session (absolute lifetime exceeded)
    const expiredSession = activateSession(createSession("device-1", clockAt(0), "s-1"), clockAt(0));
    // Set current time past the 4 hour session limit
    const pastExpiryClock = clockAt(SESSION_LIFETIME_MS + 1000);
    const expiredResult = authorizeCommand({
      command,
      session: expiredSession,
      devices: deviceIndex([remoteDevice("device-1", "trusted")]),
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: pastExpiryClock
    });
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) {
      expect(expiredResult.code).toBe("session-expired");
    }

    // Revoked session
    const revokedSessionObj = revokeSession(liveSession(), clockAt(500));
    const revokedSessionResult = authorizeCommand({
      command,
      session: revokedSessionObj,
      devices: deviceIndex([remoteDevice("device-1", "trusted")]),
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(revokedSessionResult.ok).toBe(false);
    if (!revokedSessionResult.ok) {
      expect(revokedSessionResult.code).toBe("session-expired");
    }
  });

  // 5. Replay/wrong-session rejection
  it("rejects replayed approvals and wrong-session attempts", () => {
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "once"
    };

    const sessionA = liveSession();
    const approvalsIndex = pendingIndex([pendingApproval("appr-1")]);
    const devicesIndex = deviceIndex([remoteDevice("device-1", "trusted")]);

    // Initial authorization succeeds
    const initialResult = authorizeCommand({
      command,
      session: sessionA,
      devices: devicesIndex,
      pendingApprovals: approvalsIndex,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(initialResult.ok).toBe(true);

    // Replay attack: The approval request is now resolved (removed from the pending index)
    const replayedResult = authorizeCommand({
      command,
      session: sessionA,
      devices: devicesIndex,
      pendingApprovals: pendingIndex([]), // now resolved/absent
      scheduledJobs: jobIndex([]),
      now: clockAt(2_000)
    });
    expect(replayedResult.ok).toBe(false);
    if (!replayedResult.ok) {
      expect(replayedResult.code).toBe("approval-not-found");
    }

    // Wrong session ID mapping for the device
    const wrongSession = { ...sessionA, deviceId: "wrong-device" };
    const wrongSessionResult = authorizeCommand({
      command,
      session: wrongSession,
      devices: devicesIndex,
      pendingApprovals: approvalsIndex,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(wrongSessionResult.ok).toBe(false);
    if (!wrongSessionResult.ok) {
      expect(wrongSessionResult.code).toBe("device-unpaired");
    }
  });

  // 6. Redacted audit behavior
  it("ensures that credentials and secrets do not enter remote protocol payloads or audit paths", () => {
    // Verify that any secret value is detected and refused/redacted
    const tokenPayload = "ghp_secretTokenHereAndNow123456";
    const passwordPayload = "password=super-secret-pass";
    const jwtPayload = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4f";

    expect(redactSecrets(tokenPayload).refused).toBe(true);
    expect(redactSecrets(passwordPayload).refused).toBe(true);
    expect(redactSecrets(jwtPayload).refused).toBe(true);

    // Normal non-secret payload is permitted
    const normalPayload = "Clicks the 'Submit' button on google.com";
    const normalResult = redactSecrets(normalPayload);
    expect(normalResult.refused).toBe(false);
    expect(normalResult.safe).toBe(normalPayload);
  });

  // 7. Remote-control browser/action rejection when session/device/permission is invalid
  it("rejects remote control actions when the command decision is invalid", () => {
    const commandInvalidDecision: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "always" as any // invalid decision
    };

    const authResult = authorizeCommand({
      command: commandInvalidDecision,
      session: liveSession(),
      devices: deviceIndex([remoteDevice("device-1", "trusted")]),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });

    expect(authResult.ok).toBe(false);
    if (!authResult.ok) {
      expect(authResult.code).toBe("invalid-command");
    }
  });
});
