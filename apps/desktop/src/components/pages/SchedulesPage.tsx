import { Lightning } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and the list of saved
 * schedules. Schedules persist locally as definitions; no background scheduler
 * or automatic execution path exists yet.
 */
export function SchedulesPage({ runtime }: { runtime: ShellRuntime }) {
  return (
    <>
      <PageHeader
        icon={Lightning}
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
        onRunNow={runtime.runScheduleNow}
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
