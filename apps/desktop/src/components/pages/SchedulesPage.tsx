import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and the list of saved
 * schedules. Schedules persist locally and execute through the local
 * AgentBackend runtime while the desktop app is open; no hosted runner is
 * configured. Queue states (queued, running, blocked-auth, cancelled) are
 * surfaced so the user can see and cancel live runs.
 */
export function SchedulesPage({ runtime }: { runtime: ShellRuntime }) {
  return (
    <>
      <PageHeader
        title="Schedules"
        description="Run local workflows while the Fable desktop runtime is open."
      />
      <SchedulePanel
        schedules={runtime.schedules}
        onCreate={runtime.createSchedule}
        onEdit={runtime.editSchedule}
        onToggle={runtime.toggleSchedule}
        onDelete={runtime.deleteSchedule}
        jobs={runtime.scheduledJobs}
        runs={runtime.workflowRuns}
        queue={runtime.schedulerQueue}
        onRunNow={runtime.runScheduleNow}
        onCancelRun={runtime.cancelScheduledRun}
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
