import { describe, expect, it } from "vitest";
import { acknowledgeAttempt, enqueueOccurrence, leaseDue } from "./queue";

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
});
