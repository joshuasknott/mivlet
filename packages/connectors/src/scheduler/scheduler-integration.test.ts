import { describe, expect, it } from "vitest";
import type { ScheduledJob } from "@fable/protocol";
import { enqueueOccurrence, leaseDue, acknowledgeAttempt } from "./queue";

// NOTE: calculateDueRuns is introduced in the core branch recurrence.ts.
// We import it dynamically or cast it if we want, but since it doesn't exist on main,
// we will skip tests that use it until synthesis.
import * as RecurrenceModule from "./recurrence";

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
    workspace_id: "default",
    workspaceId: "default",
    project_id: undefined,
    id: "job-test",
    schemaVersion: 1,
    name: "Test Job",
    description: "desc",
    workflowDefinitionId: "wf-1",
    trigger: sampleTrigger as any,
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
  } as any as ScheduledJob);

  // NOTE: Requires calculateDueRuns from core branch.
  it.skip("does not generate run occurrences for a paused schedule", () => {
    const job = sampleJob({ status: "paused" });
    const now = new Date("2026-06-29T10:00:00.000Z");
    const plan = (RecurrenceModule as any).calculateDueRuns(job, now);
    expect(plan.occurrences).toHaveLength(0);
    expect(plan.nextRunAt).toBe("");
  });

  // NOTE: Requires calculateDueRuns from core branch.
  it.skip("calculates due occurrences once resumed based on lastRunAt", () => {
    const job = sampleJob({ status: "active", missedRunPolicy: "run-once" });
    const now = new Date("2026-06-30T10:00:00.000Z");
    const plan = (RecurrenceModule as any).calculateDueRuns(job, now);

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

  // NOTE: Requires custom retryPolicy support in queue.ts from core branch.
  it.skip("records retry attempts and flags dead state correctly when retry limit is exceeded", () => {
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
    } as any);

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
});
