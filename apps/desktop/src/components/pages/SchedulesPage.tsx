import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { useRef, useState } from "react";
import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import { RoutinePanel } from "../RoutinePanel";
import { HostedSchedulesPanel, type HostedSchedulesPageState } from "../HostedSchedulesPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and the list of saved
 * schedules. Local schedules persist through the native scheduler and execute
 * through the local AgentBackend while the desktop app is open. A separate
 * always-on section projects recurring programs from the active teammate's
 * cloud computer, including durable lifecycle, next/last run, error evidence,
 * refresh, provisioning, and approval-bound cancellation. Queue states
 * (queued, running, blocked-auth, cancelled) remain visible for local runs.
 *
 * The create form is always available — creating does not depend on hydration.
 * The list shows a brief loading indicator until persisted jobs are hydrated
 * from the Rust store, so it never flashes an empty list when schedules are
 * about to arrive. Management callbacks use the durable `ScheduledJob`
 * contract directly, so no legacy UI adapter can discard recurrence data.
 */
export function SchedulesPage({
  runtime,
  hostedComputer
}: {
  runtime: ShellRuntime;
  hostedComputer?: HostedSchedulesPageState;
}) {
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
            New local
          </button>
        }
      />
      {hostedComputer ? <HostedSchedulesPanel state={hostedComputer} /> : null}
      <div className="local-schedules-heading">
        <span>On this device</span>
        <h2>Local schedules</h2>
        <p>Prompt-based work below runs through this Fable installation and stops when the desktop runtime is unavailable.</p>
      </div>
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
        onRun={(instruction, agentId) => {
          if (agentId && agentId !== runtime.activeAgentId) runtime.selectAgent(agentId);
          runtime.submitPrompt(instruction);
        }}
        draft={runtime.pendingRoutineDraft}
        onDraftConsumed={runtime.clearRoutineDraft}
        agents={runtime.agents}
        activeAgentId={runtime.activeAgentId}
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
