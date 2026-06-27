import { Lightning } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and the list of saved
 * schedules. Schedules persist locally and are linked to the agent runtime so
 * a connected model can run them when their day/time arrives.
 */
export function AutomationsPage({ runtime }: { runtime: ShellRuntime }) {
  return (
    <>
      <PageHeader
        icon={Lightning}
        title="Schedules"
        description="Create tasks the agent runs on a day and time you choose. Nothing runs until a model is connected."
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
