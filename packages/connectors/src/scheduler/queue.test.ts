import { describe, expect, it } from "vitest";
import {
  acknowledgeAttempt,
  enqueueOccurrence,
  leaseDue,
  requeueBlockedRun
} from "./queue";

describe("scheduler queue", () => {
  it("deduplicates an occurrence and emits a lease only once", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    expect(enqueueOccurrence(queued, {
      jobId: "job-1",
      runId: "run-2",
      scheduledAt: "2026-06-28T09:00:00Z"
    })).toBe(queued);
    const first = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1");
    expect(first.leased).toHaveLength(1);
    expect(leaseDue(first.queue, new Date("2026-06-28T09:00:02Z"), "window-1").leased).toHaveLength(0);
  });

  it("recovers an expired lease and transitions attempts without duplicate success", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    const first = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1", 1_000);
    const recovered = leaseDue(first.queue, new Date("2026-06-28T09:00:03Z"), "window-2");
    expect(recovered.leased[0].leaseHolder).toBe("window-2");
    const done = acknowledgeAttempt(recovered.queue, "run-1", {
      runId: "run-1",
      status: "succeeded",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:03Z",
      finishedAt: "2026-06-28T09:00:04Z"
    });
    expect(done[0].state).toBe("done");
    expect(leaseDue(done, new Date("2026-06-28T09:01:00Z"), "window-3").leased).toHaveLength(0);
  });

  it("emits a fencing leaseToken on each newly-leased entry", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    const { leased } = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1");
    expect(leased[0].leaseToken).toBeTruthy();
  });

  it("honors availableAt backoff: does not lease before the retry time", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    // First lease + a transient failure sets availableAt into the future.
    const leased = leaseDue(queue, new Date("2026-06-28T09:00:01Z"), "window-1");
    const token = leased.leased[0].leaseToken;
    const failed = acknowledgeAttempt(leased.queue, "run-1", {
      runId: "run-1",
      status: "failed",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      finishedAt: "2026-06-28T09:00:02Z",
      leaseToken: token
    });
    expect(failed[0].state).toBe("queued");
    expect(failed[0].availableAt).toBeTruthy();
    // One second later (within backoff): not leased.
    const stillBackoff = leaseDue(failed, new Date("2026-06-28T09:00:03Z"), "window-2");
    expect(stillBackoff.leased).toHaveLength(0);
    queue = failed;
  });

  it("re-leases after the backoff window elapses", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    const leased = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1");
    const failed = acknowledgeAttempt(leased.queue, "run-1", {
      runId: "run-1",
      status: "failed",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      finishedAt: "2026-06-28T09:00:02Z",
      leaseToken: leased.leased[0].leaseToken
    });
    // Well past the 30s base backoff: leased again.
    const reLeased = leaseDue(failed, new Date("2026-06-28T09:01:00Z"), "window-2");
    expect(reLeased.leased).toHaveLength(1);
  });

  it("rejects a stale report whose leaseToken does not match", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    const leased = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1");
    // A wrong token: the report is ignored (entry stays leased, no attempt added).
    const stale = acknowledgeAttempt(leased.queue, "run-1", {
      runId: "run-1",
      status: "succeeded",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      leaseToken: "wrong-token"
    });
    expect(stale[0].state).toBe("leased");
    expect(stale[0].attempts).toHaveLength(0);
  });

  it("transitions to blocked-auth and requeues on reconnect", () => {
    const queued = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    const leased = leaseDue(queued, new Date("2026-06-28T09:00:01Z"), "window-1");
    const blocked = acknowledgeAttempt(leased.queue, "run-1", {
      runId: "run-1",
      status: "blocked-auth",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      leaseToken: leased.leased[0].leaseToken
    });
    expect(blocked[0].state).toBe("blocked-auth");
    const requeued = requeueBlockedRun(blocked, "run-1");
    expect(requeued[0].state).toBe("queued");
  });

  it("goes dead after more than MAX_JOB_RETRIES failures", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00Z"
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const leased = leaseDue(queue, new Date(`2026-06-28T09:0${attempt}:00Z`), "window");
      queue = acknowledgeAttempt(leased.queue, "run-1", {
        runId: "run-1",
        status: "failed",
        attemptNumber: attempt,
        startedAt: `2026-06-28T09:0${attempt}:00Z`,
        leaseToken: leased.leased[0]?.leaseToken
      });
    }
    expect(queue[0].state).toBe("dead");
  });

  it("honors a bounded per-occurrence retry policy and exposes backoff metadata", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-policy",
      runId: "run-policy",
      scheduledAt: "2026-06-28T09:00:00Z",
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 5_000,
        backoffMultiplier: 3,
        maxBackoffMs: 10_000
      }
    });

    const first = leaseDue(queue, new Date("2026-06-28T09:00:01Z"), "window");
    queue = acknowledgeAttempt(first.queue, "run-policy", {
      runId: "run-policy",
      status: "failed",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      leaseToken: first.leased[0].leaseToken
    });
    expect(queue[0].state).toBe("queued");
    expect(queue[0].availableAt).toBe("2026-06-28T09:00:06.000Z");

    const second = leaseDue(queue, new Date("2026-06-28T09:00:07Z"), "window");
    queue = acknowledgeAttempt(second.queue, "run-policy", {
      runId: "run-policy",
      status: "failed",
      attemptNumber: 2,
      startedAt: "2026-06-28T09:00:07Z",
      leaseToken: second.leased[0].leaseToken
    });
    expect(queue[0].state).toBe("dead");
  });

  // Matrix for retry / blocked-auth / dead-letter / cancel transitions + fencing + stale leases.
  it.each([
    ["success -> done (clears lease)", "succeeded", "done", true],
    ["cancel -> cancelled", "cancelled", "cancelled", true],
    ["blocked-auth parks (no auto run)", "blocked-auth", "blocked-auth", true],
    ["transient fail -> queued + availableAt", "failed", "queued", true],
  ])("acknowledge %s", (_desc, status, finalState, clearsLease) => {
    let q = enqueueOccurrence([], { jobId: "j", runId: "r1", scheduledAt: "2026-07-01T09:00:00Z" });
    const leased = leaseDue(q, new Date("2026-07-01T09:00:01Z"), "w1");
    const tok = leased.leased[0].leaseToken;
    q = acknowledgeAttempt(leased.queue, "r1", {
      runId: "r1",
      status: status as any,
      attemptNumber: 1,
      startedAt: "2026-07-01T09:00:01Z",
      finishedAt: "2026-07-01T09:00:02Z",
      leaseToken: tok
    });
    expect(q[0].state).toBe(finalState);
    if (clearsLease) {
      expect(q[0].leaseHolder).toBe("");
      expect(q[0].leaseToken).toBe("");
    }
  });

  it("stale leaseToken after re-lease is rejected (restart/recovery scenario)", () => {
    let q = enqueueOccurrence([], { jobId: "j", runId: "r1", scheduledAt: "2026-07-01T09:00:00Z" });
    const l1 = leaseDue(q, new Date("2026-07-01T09:00:01Z"), "w1");
    const tok1 = l1.leased[0].leaseToken;
    // Simulate lease expiry + recovery by another holder (restart)
    const recovered = leaseDue(l1.queue, new Date("2026-07-01T09:00:40Z"), "w2");
    const tok2 = recovered.leased[0].leaseToken;
    expect(tok2).not.toBe(tok1);
    // Old token report must be ignored (fencing)
    const staleReport = acknowledgeAttempt(recovered.queue, "r1", {
      runId: "r1",
      status: "succeeded",
      attemptNumber: 1,
      startedAt: "2026-07-01T09:00:41Z",
      leaseToken: tok1
    });
    expect(staleReport[0].state).toBe("leased");
    expect(staleReport[0].attempts).toHaveLength(0);
    // New token succeeds
    const good = acknowledgeAttempt(staleReport, "r1", {
      runId: "r1",
      status: "succeeded",
      attemptNumber: 1,
      startedAt: "2026-07-01T09:00:42Z",
      leaseToken: tok2
    });
    expect(good[0].state).toBe("done");
  });

  it("requeueBlocked only affects blocked-auth; duplicate enqueue identity preserved", () => {
    let q = enqueueOccurrence([], { jobId: "j", runId: "r1", scheduledAt: "2026-07-01T09:00:00Z" });
    q = enqueueOccurrence(q, { jobId: "j", runId: "r2", scheduledAt: "2026-07-01T09:00:00Z" }); // same occ
    expect(q).toHaveLength(1); // dedup by key
    // blocked path
    let leased = leaseDue(q, new Date("2026-07-01T09:00:01Z"), "w");
    q = acknowledgeAttempt(leased.queue, "r1", { runId: "r1", status: "blocked-auth", attemptNumber: 1, startedAt: "2026-07-01T09:00:01Z", leaseToken: leased.leased[0].leaseToken });
    expect(q[0].state).toBe("blocked-auth");
    q = requeueBlockedRun(q, "r1");
    expect(q[0].state).toBe("queued");
    q = requeueBlockedRun(q, "r1"); // idempotent
    expect(q[0].state).toBe("queued");
  });

  it("occurrence identity string matches between recurrence ISO and queue dedup key", () => {
    const at = new Date("2026-07-03T09:00:00.000Z");
    const key = `${"job-1"}:${at.toISOString()}`;
    const q = enqueueOccurrence([], { jobId: "job-1", runId: "r", scheduledAt: at.toISOString() });
    expect(q[0].deduplicationKey).toBe(key);
  });

  // Extra table cases for ACs: boundaries, repeated polling, ordering via scheduled, cancel respect, equal ts dedup (no twice)
  it.each([
    ["equal now leases (boundary)", "2026-07-03T09:00:00.000Z", "2026-07-03T09:00:00.000Z", 1],
    ["future does not lease", "2026-07-03T10:00:00.000Z", "2026-07-03T09:00:00.000Z", 0],
    ["past leases", "2026-07-03T08:00:00.000Z", "2026-07-03T09:00:00.000Z", 1],
  ])("leaseDue boundary %s", (_d, sched, nowStr, want) => {
    const q = enqueueOccurrence([], { jobId: "b", runId: "rb", scheduledAt: sched });
    const res = leaseDue(q, new Date(nowStr), "win");
    expect(res.leased.length).toBe(want);
  });

  it("repeated polling after lease yields zero until ack or expire (no twice)", () => {
    let q = enqueueOccurrence([], { jobId: "rp", runId: "rrp", scheduledAt: "2026-07-03T09:00:00.000Z" });
    const l1 = leaseDue(q, new Date("2026-07-03T09:00:01Z"), "w1");
    expect(l1.leased.length).toBe(1);
    q = l1.queue;
    const l2 = leaseDue(q, new Date("2026-07-03T09:00:02Z"), "w1");
    expect(l2.leased.length).toBe(0);
  });

  it("cancelled entry is never leased again; idempotent", () => {
    let q = enqueueOccurrence([], { jobId: "c", runId: "rc", scheduledAt: "2026-07-03T09:00:00.000Z" });
    const l = leaseDue(q, new Date("2026-07-03T09:00:01Z"), "w");
    q = acknowledgeAttempt(l.queue, "rc", { runId: "rc", status: "cancelled", attemptNumber: 1, startedAt: "2026-07-03T09:00:01Z", leaseToken: l.leased[0].leaseToken });
    expect(q[0].state).toBe("cancelled");
    const after = leaseDue(q, new Date("2026-07-03T09:01:00Z"), "w2");
    expect(after.leased.length).toBe(0);
  });

  it("equal timestamps different jobs get distinct keys; same job dedups", () => {
    const t = "2026-07-03T09:00:00.000Z";
    const q1 = enqueueOccurrence([], { jobId: "j1", runId: "r1", scheduledAt: t });
    const q2 = enqueueOccurrence(q1, { jobId: "j2", runId: "r2", scheduledAt: t });
    expect(q2.length).toBe(2);
    const q3 = enqueueOccurrence(q2, { jobId: "j1", runId: "r3", scheduledAt: t });
    expect(q3.length).toBe(2); // dedup j1
  });
});
