import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import type { ScheduledJob } from "@fable/protocol";
import type { Schedule } from "../../lib/types";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and the list of saved
 * schedules. Schedules persist locally and execute through the local
 * AgentBackend runtime while the desktop app is open; no hosted runner is
 * configured. Queue states (queued, running, blocked-auth, cancelled) are
 * surfaced so the user can see and cancel live runs.
 *
 * The create form is always available — creating does not depend on hydration.
 * The list shows a brief loading indicator until persisted jobs are hydrated
 * from the Rust store, so it never flashes an empty list when schedules are
 * about to arrive. Toggle/delete adapt the durable `ScheduledJob` to the legacy
 * `Schedule` shape the runtime boundary already owns (they share the job id),
 * so no new mutation surface is added.
 */
export function SchedulesPage({ runtime }: { runtime: ShellRuntime }) {
  /** Map a durable job to the legacy Schedule shape toggle/delete expect. */
  const jobToSchedule = (job: ScheduledJob): Schedule => {
    const match = runtime.schedules.find((entry) => entry.id === job.id);
    return {
      id: job.id,
      name: job.name,
      description: job.description,
      day: match?.day ?? "Mon",
      time: match?.time ?? "09:00",
      enabled: job.status !== "paused",
      createdAt: job.createdAt
    };
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Run local workflows while the Fable desktop runtime is open."
        meta={
          runtime.scheduledJobs.length === 0
            ? undefined
            : `${runtime.scheduledJobs.length} schedule${runtime.scheduledJobs.length === 1 ? "" : "s"}`
        }
      />
      <SchedulePanel
        jobs={runtime.scheduledJobs}
        runs={runtime.workflowRuns}
        queue={runtime.schedulerQueue}
        connectors={runtime.connectorManifests}
        loading={!runtime.schedulesReady && runtime.scheduledJobs.length === 0}
        onCreate={runtime.createScheduleFromTrigger}
        onEdit={runtime.editScheduleFromTrigger}
        onToggle={(job) => runtime.toggleSchedule(jobToSchedule(job))}
        onDelete={(job) => runtime.deleteSchedule(jobToSchedule(job))}
        onRunNow={runtime.runScheduleNow}
        onCancelRun={runtime.cancelScheduledRun}
        onViewRuns={(job) => runtime.openRunHistoryForJob(job.id)}
      />
      {runtime.notificationHistory.length > 0 ? (
        <details className="notification-history">
          <summary>Notification history</summary>
          <ul>
            {runtime.notificationHistory.map((notification) => (
              <li key={notification.id}>
                <strong>{notification.title}</strong>
                <span>{notification.body}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
