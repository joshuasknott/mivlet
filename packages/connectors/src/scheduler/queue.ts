import type { JobAttempt, SchedulerQueueEntry } from "@fable/protocol";

export const DEFAULT_LEASE_MS = 30_000;
export const MAX_JOB_RETRIES = 3;

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
      deduplicationKey
    }
  ];
}

export function leaseDue(
  queue: SchedulerQueueEntry[],
  now: Date,
  holder: string,
  leaseMs = DEFAULT_LEASE_MS
): { queue: SchedulerQueueEntry[]; leased: SchedulerQueueEntry[] } {
  const leased: SchedulerQueueEntry[] = [];
  const next = queue.map((entry) => {
    const expired =
      entry.state === "leased" && Date.parse(entry.leaseExpiresAt) <= now.getTime();
    const candidate = expired
      ? { ...entry, state: "queued" as const, leaseHolder: "", leaseExpiresAt: "" }
      : entry;
    if (candidate.state !== "queued" || Date.parse(candidate.scheduledAt) > now.getTime()) {
      return candidate;
    }
    const updated: SchedulerQueueEntry = {
      ...candidate,
      state: "leased",
      leaseHolder: holder,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString()
    };
    leased.push(updated);
    return updated;
  });
  return { queue: next, leased };
}

export function acknowledgeAttempt(
  queue: SchedulerQueueEntry[],
  runId: string,
  attempt: JobAttempt
): SchedulerQueueEntry[] {
  return queue.map((entry) => {
    if (entry.runId !== runId || entry.state !== "leased") return entry;
    const attempts = [...entry.attempts, attempt];
    const failures = attempts.filter((candidate) => candidate.status === "failed").length;
    const state =
      attempt.status === "succeeded" || attempt.status === "cancelled"
        ? "done"
        : attempt.status === "failed" && failures > MAX_JOB_RETRIES
          ? "dead"
          : attempt.status === "failed"
            ? "queued"
            : "leased";
    return {
      ...entry,
      attempts,
      state,
      leaseHolder: state === "leased" ? entry.leaseHolder : "",
      leaseExpiresAt: state === "leased" ? entry.leaseExpiresAt : ""
    };
  });
}
