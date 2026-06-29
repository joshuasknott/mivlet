import { describe, expect, it, vi } from "vitest";
import type { RemoteCommand } from "@fable/protocol";
import { activateSession, createSession, revokeSession, type Now } from "./session";
import { dispatchCommand, type RemoteCommandRuntime } from "./dispatcher";

const T0 = "2026-06-29T12:00:00.000Z";
function clockAt(ms: number): Now {
  return () => new Date(new Date(T0).getTime() + ms).toISOString();
}

function liveSession() {
  return activateSession(createSession("device-1", clockAt(0), "session-1"), clockAt(0));
}

/** A recording runtime that captures every dispatched call. */
function recordingRuntime(): RemoteCommandRuntime & {
  calls: { method: string; arg: unknown }[];
} {
  const calls: { method: string; arg: unknown }[] = [];
  return {
    calls,
    resolveApproval: vi.fn(async (input) => {
      calls.push({ method: "resolveApproval", arg: input });
    }),
    setJobStatus: vi.fn(async (input) => {
      calls.push({ method: "setJobStatus", arg: input });
    }),
    deleteJob: vi.fn(async (input) => {
      calls.push({ method: "deleteJob", arg: input });
    })
  };
}

describe("dispatchCommand — happy path", () => {
  it("routes approve to resolveApproval with the chosen decision", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = {
      type: "approve",
      approvalId: "appr-1",
      decision: "session"
    };
    const result = await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(true);
    expect(rt.calls).toEqual([
      { method: "resolveApproval", arg: { approvalId: "appr-1", decision: "session" } }
    ]);
  });

  it("routes deny to resolveApproval with decision deny", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = { type: "deny", approvalId: "appr-1" };
    await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });
    expect(rt.calls).toEqual([
      { method: "resolveApproval", arg: { approvalId: "appr-1", decision: "deny" } }
    ]);
  });

  it("routes pause-schedule to setJobStatus paused", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = { type: "pause-schedule", jobId: "job-1" };
    await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });
    expect(rt.calls).toEqual([
      { method: "setJobStatus", arg: { jobId: "job-1", status: "paused" } }
    ]);
  });

  it("routes resume-schedule to setJobStatus active", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = { type: "resume-schedule", jobId: "job-1" };
    await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });
    expect(rt.calls).toEqual([
      { method: "setJobStatus", arg: { jobId: "job-1", status: "active" } }
    ]);
  });

  it("routes delete-schedule to deleteJob", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = { type: "delete-schedule", jobId: "job-1" };
    await dispatchCommand({
      command,
      session: liveSession(),
      runtime: rt,
      now: clockAt(1_000)
    });
    expect(rt.calls).toEqual([{ method: "deleteJob", arg: { jobId: "job-1" } }]);
  });
});

describe("dispatchCommand — defense-in-depth session re-check", () => {
  it("fails closed when the session went stale between authorize and apply", async () => {
    const rt = recordingRuntime();
    const command: RemoteCommand = { type: "deny", approvalId: "appr-1" };
    const result = await dispatchCommand({
      command,
      session: revokeSession(liveSession(), clockAt(1_000)),
      runtime: rt,
      now: clockAt(2_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("session-expired");
    // Nothing should have been dispatched.
    expect(rt.calls).toEqual([]);
  });
});

describe("dispatchCommand — underlying boundary failure", () => {
  it("fails closed when the runtime throws (e.g. race resolution on desktop)", async () => {
    const rt: RemoteCommandRuntime = {
      resolveApproval: vi.fn(async () => {
        throw new Error("approval already resolved");
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
      expect(result.message).toContain("already resolved");
    }
  });
});
