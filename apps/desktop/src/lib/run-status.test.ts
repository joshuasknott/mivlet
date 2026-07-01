import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  JobAttempt,
  SchedulerQueueEntry,
  ScheduledJob,
  WorkflowRun
} from "@fable/protocol";
import {
  attemptLabel,
  canCancel,
  canRetry,
  findQueueEntryForRun,
  formatRunDuration,
  latestAttempt,
  resolveRunStatus
} from "./run-status";

/**
 * Status resolution + action eligibility. These are the rules that keep the
 * list and detail view consistent about what a user may do for each run state.
 */

function makeAttempt(overrides: Partial<JobAttempt> = {}): JobAttempt {
  return {
    runId: "run-1",
    status: "succeeded",
    attemptNumber: 1,
    startedAt: "2026-07-01T09:00:00.000Z",
    finishedAt: "2026-07-01T09:00:10.000Z",
    ...overrides
  };
}

function makeQueue(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
  return {
    jobId: "job-1",
    runId: "run-1",
    scheduledAt: "2026-07-01T09:00:00.000Z",
    state: "done",
    leaseHolder: "",
    leaseExpiresAt: "",
    attempts: [makeAttempt()],
    deduplicationKey: "job-1:2026-07-01T09:00:00.000Z",
    ...overrides
  };
}

const activeJob: Pick<ScheduledJob, "status"> = { status: "active" };
const pausedJob: Pick<ScheduledJob, "status"> = { status: "paused" };

describe("resolveRunStatus", () => {
  it("maps a completed run to succeeded", () => {
    const meta = resolveRunStatus({ status: "completed" } as WorkflowRun);
    expect(meta.status).toBe("succeeded");
    expect(meta.label).toBe("Succeeded");
  });

  it("maps a failed run to failed", () => {
    expect(resolveRunStatus({ status: "failed" } as WorkflowRun).status).toBe("failed");
  });

  it("maps cancelled to cancelled", () => {
    expect(resolveRunStatus({ status: "cancelled" } as WorkflowRun).status).toBe("cancelled");
  });

  it("maps running + awaiting-approval to running", () => {
    expect(resolveRunStatus({ status: "running" } as WorkflowRun).status).toBe("running");
    expect(
      resolveRunStatus({ status: "awaiting-approval" } as WorkflowRun).status
    ).toBe("running");
  });

  it("maps blocked-auth to interrupted", () => {
    expect(resolveRunStatus({ status: "blocked-auth" } as WorkflowRun).status).toBe(
      "interrupted"
    );
  });

  it("surfaces a dead queue entry as interrupted even when the run record says failed", () => {
    const meta = resolveRunStatus(
      { status: "failed" } as WorkflowRun,
      makeQueue({ state: "dead" })
    );
    expect(meta.status).toBe("interrupted");
  });

  it("surfaces a retrying run when a failed attempt is queued with a future backoff", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const meta = resolveRunStatus(
      { status: "failed" } as WorkflowRun,
      makeQueue({
        state: "queued",
        availableAt: future,
        attempts: [makeAttempt({ status: "failed" })]
      })
    );
    expect(meta.status).toBe("retrying");
  });

  it("does not mark a queued entry with no past failure as retrying", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const meta = resolveRunStatus(
      { status: "queued" } as WorkflowRun,
      makeQueue({ state: "queued", availableAt: future, attempts: [] })
    );
    expect(meta.status).toBe("queued");
  });
});

describe("canRetry", () => {
  it("allows retry for failed runs on an active job", () => {
    expect(canRetry({ status: "failed" } as never, activeJob)).toBe(true);
  });

  it("allows retry for cancelled and interrupted runs", () => {
    expect(canRetry({ status: "cancelled" } as never, activeJob)).toBe(true);
    expect(canRetry({ status: "interrupted" } as never, activeJob)).toBe(true);
  });

  it("blocks retry for succeeded/running/queued runs", () => {
    expect(canRetry({ status: "succeeded" } as never, activeJob)).toBe(false);
    expect(canRetry({ status: "running" } as never, activeJob)).toBe(false);
    expect(canRetry({ status: "queued" } as never, activeJob)).toBe(false);
  });

  it("blocks retry when the owning job is paused or missing", () => {
    expect(canRetry({ status: "failed" } as never, pausedJob)).toBe(false);
    expect(canRetry({ status: "failed" } as never, undefined)).toBe(false);
  });
});

describe("canCancel", () => {
  it("allows cancel for in-flight states", () => {
    expect(canCancel({ status: "queued" } as never)).toBe(true);
    expect(canCancel({ status: "running" } as never)).toBe(true);
    expect(canCancel({ status: "retrying" } as never)).toBe(true);
  });

  it("blocks cancel for terminal states", () => {
    expect(canCancel({ status: "succeeded" } as never)).toBe(false);
    expect(canCancel({ status: "failed" } as never)).toBe(false);
    expect(canCancel({ status: "cancelled" } as never)).toBe(false);
    expect(canCancel({ status: "interrupted" } as never)).toBe(false);
  });
});

describe("attempt + duration helpers", () => {
  it("finds the highest-numbered attempt", () => {
    const queue = makeQueue({
      attempts: [
        makeAttempt({ attemptNumber: 1, status: "failed" }),
        makeAttempt({ attemptNumber: 2, status: "succeeded" })
      ]
    });
    expect(latestAttempt(queue)?.attemptNumber).toBe(2);
    expect(attemptLabel(queue)).toBe("Attempt 2");
  });

  it("returns undefined attempt label when there are no attempts", () => {
    expect(attemptLabel(makeQueue({ attempts: [] }))).toBeUndefined();
    expect(attemptLabel(undefined)).toBeUndefined();
  });

  it("formats duration from start to finish", () => {
    expect(
      formatRunDuration({
        startedAt: "2026-07-01T09:00:00.000Z",
        finishedAt: "2026-07-01T09:00:45.000Z"
      } as WorkflowRun)
    ).toBe("45.0s");

    expect(
      formatRunDuration({
        startedAt: "2026-07-01T09:00:00.000Z",
        finishedAt: "2026-07-01T09:02:00.000Z"
      } as WorkflowRun)
    ).toBe("2m");
  });

  it("returns undefined duration when not finished", () => {
    expect(
      formatRunDuration({ startedAt: "2026-07-01T09:00:00.000Z" } as WorkflowRun)
    ).toBeUndefined();
  });
});

describe("findQueueEntryForRun", () => {
  it("returns the most recent entry by scheduledAt", () => {
    const queue = [
      makeQueue({ runId: "run-1", scheduledAt: "2026-07-01T09:00:00.000Z" }),
      makeQueue({ runId: "run-1", scheduledAt: "2026-07-01T10:00:00.000Z" })
    ];
    expect(findQueueEntryForRun("run-1", queue)?.scheduledAt).toBe(
      "2026-07-01T10:00:00.000Z"
    );
  });
});

describe("resolveRunStatus — time-dependent retry window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T09:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("treats a past availableAt as no longer retrying (backoff elapsed)", () => {
    const meta = resolveRunStatus(
      { status: "failed" } as WorkflowRun,
      makeQueue({
        state: "queued",
        availableAt: "2026-07-01T08:00:00.000Z",
        attempts: [makeAttempt({ status: "failed" })]
      })
    );
    // Backoff elapsed → no longer "retrying", falls back to the run record.
    expect(meta.status).toBe("failed");
  });
});
