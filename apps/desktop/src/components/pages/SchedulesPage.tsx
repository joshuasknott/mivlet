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
        description="Create saved schedule definitions for future agent runs. They do not execute automatically yet."
      />
      <SchedulePanel
        schedules={runtime.schedules}
        onCreate={runtime.createSchedule}
        onToggle={runtime.toggleSchedule}
        onDelete={runtime.deleteSchedule}
      />
    </>
  );
}
