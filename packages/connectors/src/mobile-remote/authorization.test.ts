import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RemoteCommand, ScheduledJob } from "@fable/protocol";
import { activateSession, createSession, revokeSession, SESSION_IDLE_TIMEOUT_MS, type Now } from "./session";
import {
  authorizeCommand,
  type PendingApprovalIndex,
  type ScheduledJobIndex
} from "./authorization";

const T0 = "2026-06-29T12:00:00.000Z";
function clockAt(ms: number): Now {
  return () => new Date(new Date(T0).getTime() + ms).toISOString();
}

/** A pending approval surfaced to the mobile device. */
function pendingApproval(id: string): ApprovalRequest {
  return {
    id,
    service: "shell",
    action: "run-shell",
    mode: "trusted-scope",
    riskLevel: "medium",
    dataUsed: ["./script.sh"],
    consequence: "Runs a shell command.",
    requestedAt: T0,
    decisions: []
  };
}

/** A scheduled job the mobile device may control. */
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

/** Build an index from an explicit set of pending approvals. */
function pendingIndex(approvals: ApprovalRequest[]): PendingApprovalIndex {
  const map = new Map(approvals.map((a) => [a.id, a]));
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id)
  };
}

/** Build an index from an explicit set of scheduled jobs. */
function jobIndex(jobs: ScheduledJob[]): ScheduledJobIndex {
  const map = new Map(jobs.map((j) => [j.id, j]));
  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id)
  };
}

/** A live session for the happy path. */
function liveSession() {
  return activateSession(createSession("device-1", clockAt(0), "session-1"), clockAt(0));
}

describe("authorizeCommand — happy path", () => {
  it("authorizes approve against a pending approval", () => {
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "once"
    };
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.appliedAt).toBe(clockAt(1_000)());
  });

  it("authorizes deny against a pending approval", () => {
    const command: RemoteCommand = { type: "deny", approvalId: "appr-1" };
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(true);
  });

  it.each(["once", "session", "rule"] as const)(
    "authorizes approve with decision %s",
    (decision) => {
      const command: RemoteCommand = {
        type: "approve",
        approvalId: "appr-1",
        decision
      };
      const result = authorizeCommand({
        command,
        session: liveSession(),
        pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
        scheduledJobs: jobIndex([]),
        now: clockAt(1_000)
      });
      expect(result.ok).toBe(true);
    }
  );

  it.each(["pause-schedule", "resume-schedule", "delete-schedule"] as const)(
    "authorizes %s against an existing job",
    (type) => {
      const command = { type, jobId: "job-1" } as RemoteCommand;
      const result = authorizeCommand({
        command,
        session: liveSession(),
        pendingApprovals: pendingIndex([]),
        scheduledJobs: jobIndex([scheduledJob("job-1")]),
        now: clockAt(1_000)
      });
      expect(result.ok).toBe(true);
    }
  );
});

describe("authorizeCommand — fail-closed on session state", () => {
  const command: RemoteCommand = { type: "deny", approvalId: "appr-1" };
  const approvals = pendingIndex([pendingApproval("appr-1")]);

  it("fails closed for a pairing session", () => {
    const pairing = createSession("device-1", clockAt(0), "s");
    const result = authorizeCommand({
      command,
      session: pairing,
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("session-expired");
  });

  it("fails closed for an idle-expired session", () => {
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(SESSION_IDLE_TIMEOUT_MS) // idle window elapsed
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("session-expired");
  });

  it("fails closed for a revoked session", () => {
    const revoked = revokeSession(liveSession(), clockAt(1_000));
    const result = authorizeCommand({
      command,
      session: revoked,
      pendingApprovals: approvals,
      scheduledJobs: jobIndex([]),
      now: clockAt(2_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("session-expired");
  });
});

describe("authorizeCommand — fail-closed on approval state", () => {
  it("fails closed on a non-existent approval", () => {
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "missing",
      decision: "once"
    };
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("approval-not-found");
  });

  it("fails closed on an already-resolved approval (no longer pending)", () => {
    // An already-resolved approval is simply absent from the pending index.
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-resolved",
      decision: "once"
    };
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]), // appr-resolved absent
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("approval-not-found");
  });

  it("fails closed on a replayed approval id (same id after resolution)", () => {
    // First call authorizes; the approval is then resolved and removed from the
    // pending index. A replayed command with the same id must fail closed.
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "once"
    };
    const before = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(before.ok).toBe(true);
    // After resolution, the approval is gone from the pending index.
    const replayed = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([]), // resolved -> absent
      scheduledJobs: jobIndex([]),
      now: clockAt(2_000)
    });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.code).toBe("approval-not-found");
  });

  it("fails closed on an approve with an invalid grant decision", () => {
    const command = {
      type: "approve",
      approvalId: "appr-1",
      decision: "always" // invalid
    } as unknown as RemoteCommand;
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([pendingApproval("appr-1")]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-command");
  });
});

describe("authorizeCommand — fail-closed on schedule state", () => {
  it.each(["pause-schedule", "resume-schedule", "delete-schedule"] as const)(
    "fails closed for %s on an unknown job id",
    (type) => {
      const command = { type, jobId: "missing" } as RemoteCommand;
      const result = authorizeCommand({
        command,
        session: liveSession(),
        pendingApprovals: pendingIndex([]),
        scheduledJobs: jobIndex([scheduledJob("job-1")]),
        now: clockAt(1_000)
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("schedule-not-found");
    }
  );
});

describe("authorizeCommand — fail-closed on unknown command type", () => {
  it("fails closed for an unrecognized command", () => {
    const command = { type: "submit-prompt", prompt: "hi" } as unknown as RemoteCommand;
    const result = authorizeCommand({
      command,
      session: liveSession(),
      pendingApprovals: pendingIndex([]),
      scheduledJobs: jobIndex([]),
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-command");
  });
});
