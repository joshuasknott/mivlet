import { Lightning } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { AutomationPanel } from "../AutomationPanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Lists scheduled rules with status and
 * enable/pause controls. Draft rules that need approval route to the composer.
 */
export function AutomationsPage({ runtime }: { runtime: ShellRuntime }) {
  const activeCount = runtime.automationRules.filter((rule) => rule.status === "active").length;
  return (
    <>
    <PageHeader
      icon={Lightning}
      title="Schedules"
      description="Quiet by default. Schedule summaries, nudges, and health checks that run with your explicit approval."
      meta={`${activeCount} active · ${runtime.automationRules.length} total`}
    />
    <AutomationPanel rules={runtime.automationRules} onToggle={runtime.toggleAutomation} />
    </>
  );
}
