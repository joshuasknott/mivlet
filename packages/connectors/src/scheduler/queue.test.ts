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
});
