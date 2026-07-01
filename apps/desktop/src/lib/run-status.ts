/**
 * Run-status display + eligibility helpers.
 *
 * A run's truth lives in two places: the {@link WorkflowRun} record (the
 * per-step lifecycle) and its matching {@link SchedulerQueueEntry} (the durable
 * queue state, which carries attempt/retry information). This module merges them
 * into a single display vocabulary the Run History UI renders, and centralizes
 * the rules for which actions (retry / cancel) are safe to offer for a given
 * state. Keeping these rules pure + co-located means the list and the detail
 * view can never disagree about what a user is allowed to do.
 */

import type {
  JobAttempt,
  SchedulerJobState,
  SchedulerQueueEntry,
  ScheduledJob,
  WorkflowRun,
  WorkflowRunStatus
} from "@fable/protocol";

/**
 * The unified display vocabulary for run history. This maps both the workflow
 * run status and the scheduler queue state into the labels the objective calls
 * out explicitly: queued, running, succeeded, failed, retrying, cancelled,
 * interrupted.
 *
 * `interrupted` covers runs the scheduler gave up on (`dead`) or that are
 * blocked waiting for backend reconnection (`blocked-auth`) — terminal-ish
 * states that aren't a clean failure the agent produced.
 */
export type RunDisplayStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "retrying"
  | "cancelled"
  | "interrupted";

export interface RunStatusMeta {
  status: RunDisplayStatus;
  /** Short human label, e.g. "Running". */
  label: string;
  /** CSS tone modifier used for badges/rows: e.g. "running", "failed". */
  tone: string;
  /** One-line description of what the state means. */
  hint: string;
}

const META: Record<RunDisplayStatus, Omit<RunStatusMeta, "status">> = {
  queued: {
    label: "Queued",
    tone: "queued",
    hint: "Waiting for the runtime to pick up the run."
  },
  running: {
    label: "Running",
    tone: "running",
    hint: "The agent is executing this run now."
  },
  succeeded: {
    label: "Succeeded",
    tone: "succeeded",
    hint: "The run completed without errors."
  },
  failed: {
    label: "Failed",
    tone: "failed",
    hint: "The run ended with an error."
  },
  retrying: {
    label: "Retrying",
    tone: "retrying",
    hint: "A previous attempt failed and the scheduler will retry."
  },
  cancelled: {
    label: "Cancelled",
    tone: "cancelled",
    hint: "The run was cancelled before it could finish."
  },
  interrupted: {
    label: "Interrupted",
    tone: "interrupted",
    hint: "The run is blocked or the scheduler gave up after repeated failures."
  }
};

/**
 * Resolve a run's display status from the workflow run + its queue entry. The
 * queue entry is authoritative for retry/interrupt signals (a run whose record
 * is `failed` but whose queue is `queued` with availableAt in the future is
 * retrying); the run record is authoritative once it's cleanly terminal.
 */
export function resolveRunStatus(
  run: Pick<WorkflowRun, "status">,
  queueEntry?: SchedulerQueueEntry
): RunStatusMeta {
  // Retry/interrupt signals come from the durable queue when present.
  if (queueEntry) {
    if (queueEntry.state === "dead" || queueEntry.state === "blocked-auth") {
      return { status: "interrupted", ...META.interrupted };
    }
    // A queued entry with a future availableAt after a failure is mid-backoff.
    const isAwaitingRetry =
      queueEntry.state === "queued" &&
      Boolean(queueEntry.availableAt) &&
      hasFailedAttempt(queueEntry) &&
      new Date(queueEntry.availableAt!).getTime() > Date.now();
    if (isAwaitingRetry) {
      return { status: "retrying", ...META.retrying };
    }
  }

  switch (run.status) {
    case "queued":
      return { status: "queued", ...META.queued };
    case "running":
    case "awaiting-approval":
      return { status: "running", ...META.running };
    case "completed":
      return { status: "succeeded", ...META.succeeded };
    case "failed":
      return { status: "failed", ...META.failed };
    case "blocked-auth":
      return { status: "interrupted", ...META.interrupted };
    case "cancelled":
      return { status: "cancelled", ...META.cancelled };
    default:
      return { status: "queued", ...META.queued };
  }
}

function hasFailedAttempt(entry: SchedulerQueueEntry): boolean {
  return entry.attempts.some((attempt) => attempt.status === "failed");
}

/**
 * Whether the retry control should be offered for a run. Only runs that are
 * terminal-and-unhealthy qualify, and only when their owning job is active.
 */
export function canRetry(
  meta: RunStatusMeta,
  job?: Pick<ScheduledJob, "status">
): boolean {
  if (!job || job.status !== "active") return false;
  return meta.status === "failed" || meta.status === "cancelled" || meta.status === "interrupted";
}

/**
 * Whether the cancel control should be offered for a run. Only runs that are
 * still in flight (queued / running / retrying) can be cancelled.
 */
export function canCancel(meta: RunStatusMeta): boolean {
  return (
    meta.status === "queued" ||
    meta.status === "running" ||
    meta.status === "retrying"
  );
}

/**
 * The latest attempt for a run (highest attempt number), if any. Used to surface
 * "Attempt 2 of 3" in the list and detail views.
 */
export function latestAttempt(
  queueEntry?: SchedulerQueueEntry
): JobAttempt | undefined {
  if (!queueEntry || queueEntry.attempts.length === 0) return undefined;
  return queueEntry.attempts.reduce((latest, attempt) =>
    attempt.attemptNumber > latest.attemptNumber ? attempt : latest
  );
}

/**
 * Human-readable attempt summary, e.g. "Attempt 2". Returns undefined when the
 * run has no recorded attempts (a fresh queue entry).
 */
export function attemptLabel(queueEntry?: SchedulerQueueEntry): string | undefined {
  const attempt = latestAttempt(queueEntry);
  if (!attempt) return undefined;
  return `Attempt ${attempt.attemptNumber}`;
}

/**
 * Format a run's duration from its start/finish timestamps. Returns undefined
 * when the run hasn't started or hasn't finished yet.
 */
export function formatRunDuration(
  run: Pick<WorkflowRun, "startedAt" | "finishedAt">
): string | undefined {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!start || Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const ms = Math.max(0, end - start);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * A short relative-ish timestamp label for list display. Falls back to the raw
 * ISO string when the value can't be parsed (history may include legacy data).
 */
export function formatRunWhen(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso || "—";
  return new Date(parsed).toLocaleString();
}

/**
 * Find the queue entry that corresponds to a run. A run may have multiple queue
 * entries across its lifetime (retries create new occurrences); the most recent
 * by scheduledAt is the live one.
 */
export function findQueueEntryForRun(
  runId: string,
  queue: SchedulerQueueEntry[]
): SchedulerQueueEntry | undefined {
  return queue
    .filter((entry) => entry.runId === runId)
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];
}

/** Re-export the queue state type for adapters that map raw states. */
export type { SchedulerJobState, WorkflowRunStatus };
