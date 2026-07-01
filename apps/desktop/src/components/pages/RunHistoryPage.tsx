import { useEffect, useMemo, useRef, useState } from "react";
import type {
  NotificationRecord,
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import { PageHeader } from "../PageHeader";
import { RunStatusBadge } from "../RunStatusBadge";
import { RunDetail } from "../RunDetail";
import {
  attemptLabel,
  canCancel,
  canRetry,
  findQueueEntryForRun,
  formatRunDuration,
  formatRunWhen,
  resolveRunStatus,
  type RunDisplayStatus
} from "../../lib/run-status";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Run History page.
 *
 * Master/detail over a recurring task's executions. The list surfaces useful
 * status, schedule/workflow, timing, attempt, and duration information with
 * status filtering consistent with the rest of the app; selecting a run opens a
 * detail view with its full lifecycle, attempts, audit events, structured
 * outputs, and errors. Loading/empty/error states are all accessible, and the
 * list refreshes durable history from the Rust authority on mount.
 *
 * The page never owns retry/cancel authority — it forwards to the runtime, which
 * guards eligibility. Controls are only rendered when the resolved status + job
 * state permit them, so an unsupported action can never be offered.
 */

/** Filter chips shown above the list. `all` plus one per display status. */
const STATUS_FILTERS: Array<{ value: "all" | RunDisplayStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "retrying", label: "Retrying" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "interrupted", label: "Interrupted" },
  { value: "cancelled", label: "Cancelled" }
];

export interface RunHistoryPageProps {
  runtime: ShellRuntime;
  /** Pre-select a run when navigating from a deep link (e.g. a notification). */
  initialRunId?: string;
}

export function RunHistoryPage({ runtime, initialRunId }: RunHistoryPageProps) {
  const runs = runtime.workflowRuns;
  const queue = runtime.schedulerQueue;
  const jobs = runtime.scheduledJobs;
  const definitions = runtime.workflowDefinitions;
  const notifications = runtime.notificationHistory;

  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [statusFilter, setStatusFilter] = useState<"all" | RunDisplayStatus>("all");
  // Seed the schedule filter from a deep link (schedule → executions), then
  // clear the one-shot so a later manual visit isn't pre-filtered.
  const [jobFilter, setJobFilter] = useState<string>(runtime.runHistoryJobId ?? "all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(runs.length === 0);
  const mountRuntime = useRef(runtime);

  // Pull durable history from the Rust authority on mount so the list reflects
  // runs from prior sessions, not just the current one. In preview this is a
  // no-op resolve. Also consume + clear the one-shot deep-link filter.
  useEffect(() => {
    const initialRuntime = mountRuntime.current;
    initialRuntime.clearRunHistoryJobId();
    let active = true;
    initialRuntime
      .refreshWorkflowRuns()
      .then(() => {
        if (active) {
          setLoadError(null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("Fable could not load run history.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const resolvedRuns = useMemo(
    () =>
      [...runs].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")),
    [runs]
  );

  const filteredRuns = useMemo(() => {
    return resolvedRuns.filter((run) => {
      if (jobFilter !== "all" && run.scheduledJobId !== jobFilter) return false;
      if (statusFilter === "all") return true;
      const meta = resolveRunStatus(run, findQueueEntryForRun(run.id, queue));
      return meta.status === statusFilter;
    });
  }, [resolvedRuns, queue, statusFilter, jobFilter]);

  const selectedRun = selectedRunId
    ? resolvedRuns.find((run) => run.id === selectedRunId) ?? null
    : null;

  if (selectedRun) {
    return (
      <RunDetail
        run={selectedRun}
        job={jobs.find((job) => job.id === selectedRun.scheduledJobId)}
        definition={definitions.find((def) => def.id === selectedRun.definitionId)}
        queue={queue}
        notifications={notifications}
        retrying={runtime.retryingRunIds.includes(selectedRun.id)}
        onRetry={(runId) => runtime.retryWorkflowRun(runId)}
        onCancel={(runId) => runtime.cancelScheduledRun(runId)}
        onBack={() => setSelectedRunId(null)}
        onOpenSchedule={(jobId) => {
          setSelectedRunId(null);
          setJobFilter(jobId);
          setStatusFilter("all");
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Run History"
        description="Execution history and results for your scheduled workflows."
        meta={`${filteredRuns.length} run${filteredRuns.length === 1 ? "" : "s"}`}
      />

      <FilterBar
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        jobFilter={jobFilter}
        onJobFilter={setJobFilter}
        jobs={jobs}
        runs={resolvedRuns}
        queue={queue}
      />

      {loadError ? <p className="run-error" role="alert">{loadError}</p> : null}

      {/* Cold-load blocker: only while we have no data yet. Once any runs are in
          memory we render them immediately and let the durable refresh settle. */}
      {loading && runs.length === 0 ? (
        <p className="run-loading" role="status" aria-live="polite">
          Loading run history…
        </p>
      ) : filteredRuns.length === 0 ? (
        runs.length === 0 ? (
          <EmptyState hasRuns={false} />
        ) : (
          <EmptyState hasRuns={true} />
        )
      ) : (
        <ul className="run-list" aria-label="Workflow runs">
          {filteredRuns.map((run) => {
            const queueEntry = findQueueEntryForRun(run.id, queue);
            const meta = resolveRunStatus(run, queueEntry);
            const job = jobs.find((candidate) => candidate.id === run.scheduledJobId);
            const definition = definitions.find((def) => def.id === run.definitionId);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className={`run-list__row run-list__row--${meta.tone}`}
                  onClick={() => setSelectedRunId(run.id)}
                  aria-label={`Open run ${definition?.name ?? job?.name ?? run.id}`}
                >
                  <span className="run-list__main">
                    <span className="run-list__name">
                      {definition?.name ?? job?.name ?? "Workflow run"}
                    </span>
                    <RunStatusBadge meta={meta} />
                    {run.trigger !== "schedule" ? (
                      <span className="run-list__trigger">{run.trigger}</span>
                    ) : null}
                  </span>
                  <span className="run-list__meta">
                    {attemptLabel(queueEntry) ? (
                      <span className="run-list__attempt">{attemptLabel(queueEntry)}</span>
                    ) : null}
                    {formatRunDuration(run) ? (
                      <span className="run-list__duration">{formatRunDuration(run)}</span>
                    ) : null}
                    <span className="run-list__when">
                      {run.startedAt ? formatRunWhen(run.startedAt) : "—"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Filter bar: a status chip group + a schedule selector. The schedule selector
 * is the recurring-definition → executions link (and the back-link target from
 * the detail view).
 */
function FilterBar({
  statusFilter,
  onStatusFilter,
  jobFilter,
  onJobFilter,
  jobs,
  runs,
  queue
}: {
  statusFilter: "all" | RunDisplayStatus;
  onStatusFilter: (value: "all" | RunDisplayStatus) => void;
  jobFilter: string;
  onJobFilter: (value: string) => void;
  jobs: ScheduledJob[];
  runs: WorkflowRun[];
  queue: SchedulerQueueEntry[];
}) {
  // Only offer the schedule filter when there are scheduled runs; manual/voice
  // runs have no job and would be hidden, so the control is pointless otherwise.
  const scheduledJobs = jobs.filter((job) =>
    runs.some((run) => run.scheduledJobId === job.id)
  );
  if (scheduledJobs.length === 0 && statusFilter === "all") {
    return null;
  }
  return (
    <div className="run-filters" role="toolbar" aria-label="Filter runs">
      <div className="run-filters__status" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((filter) => {
          const active = statusFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              className={`run-filter-chip${active ? " run-filter-chip--active" : ""}`}
              aria-pressed={active}
              onClick={() => onStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
      {scheduledJobs.length > 0 ? (
        <label className="run-filters__job">
          <span className="run-filters__job-label">Schedule</span>
          <select
            value={jobFilter}
            onChange={(event) => onJobFilter(event.target.value)}
            aria-label="Filter by schedule"
          >
            <option value="all">All schedules</option>
            {scheduledJobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function EmptyState({ hasRuns }: { hasRuns: boolean }) {
  return (
    <div className="run-empty" role="status">
      <p className="run-empty__title">
        {hasRuns ? "No runs match these filters." : "No runs yet."}
      </p>
      <p className="run-empty__hint">
        {hasRuns
          ? "Try a different status or schedule filter."
          : "Scheduled workflows will appear here once they run."}
      </p>
    </div>
  );
}

// Re-exported so eligibility checks stay reachable from tests that build rows.
export { canRetry, canCancel };
