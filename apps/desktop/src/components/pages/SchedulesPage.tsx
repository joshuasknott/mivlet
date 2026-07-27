import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { useRef, useState } from "react";
import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import { RoutinePanel } from "../RoutinePanel";
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
 * about to arrive. Management callbacks use the durable `ScheduledJob`
 * contract directly, so no legacy UI adapter can discard recurrence data.
 */
export function SchedulesPage({ runtime }: { runtime: ShellRuntime }) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const isPreview = runtime.browserSession?.source === "fixture-preview";

  const handleCloseCreateModal = () => {
    setIsCreateModalOpen(false);
    newButtonRef.current?.focus();
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        description={
          isPreview
            ? "Synthetic preview schedules stay in this browser and cannot run provider work."
            : undefined
        }
        meta={isPreview ? "Preview only" : undefined}
        actions={
          <button
            ref={newButtonRef}
            type="button"
            className="schedule-new-button"
            onClick={() => setIsCreateModalOpen(true)}
            id="new-schedule-btn"
            disabled={!runtime.schedulesReady}
          >
            <Plus size={15} weight="bold" aria-hidden="true" />
            New
          </button>
        }
      />
      <SchedulePanel
        jobs={runtime.scheduledJobs}
        runs={runtime.workflowRuns}
        queue={runtime.schedulerQueue}
        connectors={runtime.connectorManifests}
        definitions={runtime.workflowDefinitions}
        loading={!runtime.schedulesReady && runtime.scheduledJobs.length === 0}
        loadError={runtime.scheduleLoadError}
        onRetryLoad={runtime.retryScheduleLoad}
        onCreate={runtime.createScheduledWork}
        onEdit={runtime.editScheduleFromTrigger}
        onToggle={runtime.toggleSchedule}
        onDelete={runtime.deleteSchedule}
        onRunNow={runtime.runScheduleNow}
        onCancelRun={runtime.cancelScheduledRun}
        onViewRuns={(job) => runtime.openRunHistoryForJob(job.id)}
        isCreateModalOpen={isCreateModalOpen}
        onRequestCloseCreateModal={handleCloseCreateModal}
      />
      <RoutinePanel
        onRun={(instruction) => runtime.submitPrompt(instruction)}
        draft={runtime.pendingRoutineDraft}
        onDraftConsumed={runtime.clearRoutineDraft}
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
