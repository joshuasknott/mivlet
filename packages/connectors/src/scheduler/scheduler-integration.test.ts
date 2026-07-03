import { describe, expect, it } from "vitest";
import type { ScheduledJob } from "@fable/protocol";
import { enqueueOccurrence, leaseDue, acknowledgeAttempt } from "./queue";
import { calculateDueRuns } from "./recurrence";

describe("Scheduler Integration", () => {
  const sampleTrigger = {
    kind: "recurring" as const,
    rule: {
      frequency: "daily" as const,
      interval: 1,
      hour: 9,
      minute: 0,
      timezone: "UTC"
    }
  };

  const sampleJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
    workspaceId: "default",
    id: "job-test",
    schemaVersion: 1,
    name: "Test Job",
    description: "desc",
    workflowDefinitionId: "wf-1",
    trigger: sampleTrigger,
    missedRunPolicy: "skip",
    status: "active",
    nextRunAt: "",
    lastRunAt: "2026-06-28T09:00:00.000Z",
    lastRunId: "",
    createdAt: "2026-06-28T09:00:00.000Z",
    updatedAt: "2026-06-28T09:00:00.000Z",
    retryPolicy: {
      maxAttempts: 3,
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 10000
    },
    ...overrides
  });

  it("does not generate run occurrences for a paused schedule", () => {
    const job = sampleJob({ status: "paused" });
    const now = new Date("2026-06-29T10:00:00.000Z");
    const plan = calculateDueRuns(job, now);
    expect(plan.occurrences).toHaveLength(0);
    expect(plan.nextRunAt).toBe("");
  });

  it("calculates due occurrences once resumed based on lastRunAt", () => {
    const job = sampleJob({ status: "active", missedRunPolicy: "run-once" });
    const now = new Date("2026-06-30T10:00:00.000Z");
    const plan = calculateDueRuns(job, now);

    expect(plan.occurrences).toEqual(["2026-06-30T09:00:00.000Z"]);
    expect(plan.nextRunAt).toBe("2026-07-01T09:00:00.000Z");
  });

  it("ensures duplicate scheduler delivery remains idempotent using occurrence keys", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-1",
      runId: "run-1",
      scheduledAt: "2026-06-28T09:00:00.000Z"
    });

    const lengthBefore = queue.length;

    queue = enqueueOccurrence(queue, {
      jobId: "job-1",
      runId: "run-2",
      scheduledAt: "2026-06-28T09:00:00.000Z"
    });

    expect(queue.length).toBe(lengthBefore);
  });

  it("records retry attempts and flags dead state correctly when retry limit is exceeded", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-test",
      runId: "run-test",
      scheduledAt: "2026-06-28T09:00:00.000Z",
      retryPolicy: {
        maxAttempts: 2,
        initialBackoffMs: 1000,
        backoffMultiplier: 2,
        maxBackoffMs: 5000
      }
    });

    let leasedRes = leaseDue(queue, new Date("2026-06-28T09:00:01Z"), "worker-1");
    expect(leasedRes.leased).toHaveLength(1);
    queue = acknowledgeAttempt(leasedRes.queue, "run-test", {
      runId: "run-test",
      status: "failed",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      finishedAt: "2026-06-28T09:00:02Z",
      leaseToken: leasedRes.leased[0].leaseToken
    });

    expect(queue[0].state).toBe("queued");
    expect(queue[0].attempts).toHaveLength(1);

    leasedRes = leaseDue(queue, new Date("2026-06-28T09:00:05Z"), "worker-1");
    expect(leasedRes.leased).toHaveLength(1);
    queue = acknowledgeAttempt(leasedRes.queue, "run-test", {
      runId: "run-test",
      status: "failed",
      attemptNumber: 2,
      startedAt: "2026-06-28T09:00:05Z",
      finishedAt: "2026-06-28T09:00:06Z",
      leaseToken: leasedRes.leased[0].leaseToken
    });

    expect(queue[0].state).toBe("dead");
    expect(queue[0].attempts).toHaveLength(2);
  });

  it("transitions leased queue entry to cancelled when a cancel request is reported", () => {
    let queue = enqueueOccurrence([], {
      jobId: "job-test",
      runId: "run-cancel",
      scheduledAt: "2026-06-28T09:00:00.000Z"
    });

    const leasedRes = leaseDue(queue, new Date("2026-06-28T09:00:01Z"), "worker-1");
    queue = acknowledgeAttempt(leasedRes.queue, "run-cancel", {
      runId: "run-cancel",
      status: "cancelled",
      attemptNumber: 1,
      startedAt: "2026-06-28T09:00:01Z",
      finishedAt: "2026-06-28T09:00:02Z",
      leaseToken: leasedRes.leased[0].leaseToken
    });

    expect(queue[0].state).toBe("cancelled");
  });

  // Additional matrix: one-time, duplicate identity, pause/resume edge, restart recovery simulation via lease.
  it.each([
    ["paused blocks due", "paused", 0],
    ["active produces from last", "active", 1],
  ])("calculateDueRuns status=%s", (name, st, len) => {
    const job = sampleJob({ status: st as any, lastRunAt: "2026-06-29T09:00:00.000Z", missedRunPolicy: "run-once" });
    const plan = calculateDueRuns(job, new Date("2026-06-30T10:00:00.000Z"));
    expect(plan.occurrences.length).toBe(len);
  });

  it("one-time enqueue identity dedups correctly", () => {
    const at = "2026-07-10T12:00:00.000Z";
    let q = enqueueOccurrence([], { jobId: "ot", runId: "r1", scheduledAt: at });
    q = enqueueOccurrence(q, { jobId: "ot", runId: "r2", scheduledAt: at });
    expect(q).toHaveLength(1);
    expect(q[0].deduplicationKey).toContain(at);
  });

  it("lease recovery + stale after restart does not double-execute (sim via queue fns)", () => {
    let q = enqueueOccurrence([], { jobId: "rec", runId: "rr", scheduledAt: "2026-07-01T09:00:00.000Z" });
    const l = leaseDue(q, new Date("2026-07-01T09:00:01Z"), "inst1");
    // crash before ack; new tick recovers
    const recovered = leaseDue(l.queue, new Date("2026-07-01T09:00:35Z"), "inst2");
    expect(recovered.leased[0].leaseHolder).toBe("inst2");
    // old lease token ignored
    const ignored = acknowledgeAttempt(recovered.queue, "rr", { runId: "rr", status: "succeeded", attemptNumber: 1, startedAt: "2026-07-01T09:00:10Z", leaseToken: l.leased[0].leaseToken });
    expect(ignored[0].state).not.toBe("done");
  });
});
