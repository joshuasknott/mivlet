import type { JobAttempt, SchedulerQueueEntry } from "@fable/protocol";

export const DEFAULT_LEASE_MS = 30_000;
/** Running-run acknowledgement lease extension (mirrors Rust RUNNING_LEASE_MS). */
export const RUNNING_LEASE_MS = 15 * 60 * 1_000;
/** Base backoff for transient retry. Mirrors Rust RETRY_BASE_MS. */
export const RETRY_BASE_MS = 30_000;
/** Mirrors Rust SCHEDULER_MAX_RETRIES (fails > N => dead). */
export const MAX_JOB_RETRIES = 2;

export function occurrenceKey(jobId: string, scheduledAt: string): string {
  return `${jobId}:${new Date(scheduledAt).toISOString()}`;
}

export function enqueueOccurrence(
  queue: SchedulerQueueEntry[],
  input: { jobId: string; runId: string; scheduledAt: string }
): SchedulerQueueEntry[] {
  const scheduledAt = new Date(input.scheduledAt).toISOString();
  const deduplicationKey = occurrenceKey(input.jobId, scheduledAt);
  if (queue.some((entry) => entry.deduplicationKey === deduplicationKey)) return queue;
  return [
    ...queue,
    {
      ...input,
      scheduledAt,
      state: "queued",
      leaseHolder: "",
      leaseExpiresAt: "",
      attempts: [],
      deduplicationKey,
      leaseToken: "",
      availableAt: "",
      lastError: ""
    }
  ];
}

/**
 * Lease due queued entries for `holder`. Expired leases are recovered first.
 * Honors `availableAt` (retry backoff): an entry is not leased before its
 * earliest-retry time. Emits a fencing `leaseToken` on each newly-leased entry.
 */
export function leaseDue(
  queue: SchedulerQueueEntry[],
  now: Date,
  holder: string,
  leaseMs = DEFAULT_LEASE_MS
): { queue: SchedulerQueueEntry[]; leased: SchedulerQueueEntry[] } {
  const nowMs = now.getTime();
  const leased: SchedulerQueueEntry[] = [];
  const next = queue.map((entry) => {
    const expired =
      entry.state === "leased" && Date.parse(entry.leaseExpiresAt) <= nowMs;
    const candidate = expired
      ? { ...entry, state: "queued" as const, leaseHolder: "", leaseExpiresAt: "", leaseToken: "" }
      : entry;
    if (candidate.state !== "queued" || Date.parse(candidate.scheduledAt) > nowMs) {
      return candidate;
    }
    // Honor retry backoff: do not lease before availableAt.
    if (candidate.availableAt && Date.parse(candidate.availableAt) > nowMs) {
      return candidate;
    }
    const leaseToken = `lease-${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
    const updated: SchedulerQueueEntry = {
      ...candidate,
      state: "leased",
      leaseHolder: holder,
      leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
      leaseToken
    };
    leased.push(updated);
    return updated;
  });
  return { queue: next, leased };
}

/**
 * Apply an attempt outcome to the leased entry for `runId`. The optional
 * `leaseToken` is a fencing token: when present and non-empty it must match the
 * entry's current lease, else the call is a no-op (stale report from a
 * superseded run). Mirrors the Rust `report_job_attempt` transitions.
 */
export function acknowledgeAttempt(
  queue: SchedulerQueueEntry[],
  runId: string,
  attempt: JobAttempt
): SchedulerQueueEntry[] {
  return queue.map((entry) => {
    if (entry.runId !== runId || entry.state !== "leased") return entry;
    // Fencing: a non-empty token on the attempt must match the entry's lease.
    if (attempt.leaseToken && entry.leaseToken && attempt.leaseToken !== entry.leaseToken) {
      return entry;
    }
    const attempts = [...entry.attempts, attempt];
    const failures = attempts.filter((candidate) => candidate.status === "failed").length;
    const state =
      attempt.status === "succeeded" || attempt.status === "cancelled"
        ? (attempt.status === "succeeded" ? "done" : "cancelled")
        : attempt.status === "blocked-auth"
          ? "blocked-auth"
          : attempt.status === "failed" && failures > MAX_JOB_RETRIES
            ? "dead"
            : attempt.status === "failed"
              ? "queued"
              : "leased";
    const finished = state === "leased";
    // Transient failure sets exponential backoff (RETRY_BASE_MS * 2^(fails-1)).
    const availableAt =
      attempt.status === "failed" && state === "queued"
        ? new Date(Date.parse(attempt.startedAt) + RETRY_BASE_MS * 2 ** (failures - 1)).toISOString()
        : entry.availableAt;
    return {
      ...entry,
      attempts,
      state,
      lastError: attempt.error ?? entry.lastError,
      leaseHolder: finished ? entry.leaseHolder : "",
      leaseExpiresAt: finished ? entry.leaseExpiresAt : "",
      leaseToken: finished ? entry.leaseToken : "",
      availableAt: state === "queued" ? availableAt : ""
    };
  });
}

/**
 * Re-queue a `blocked-auth` entry (provider reconnected). No-op for other states.
 */
export function requeueBlockedRun(
  queue: SchedulerQueueEntry[],
  runId: string
): SchedulerQueueEntry[] {
  return queue.map((entry) =>
    entry.runId === runId && entry.state === "blocked-auth"
      ? { ...entry, state: "queued" as const, availableAt: "", lastError: "" }
      : entry
  );
}
