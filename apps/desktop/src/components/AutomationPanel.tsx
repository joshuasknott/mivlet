import { Clock } from "@phosphor-icons/react";
import { SectionHeading, StatusDot } from "./primitives";
import type { AutomationRuleView } from "../lib/types";

/**
 * Automations context panel: scheduled rules with draft/active/paused status
 * and enable/pause toggles. Rules that need approval route to the composer.
 */

export function AutomationPanel({
  rules,
  onToggle
}: {
  rules: AutomationRuleView[];
  onToggle: (rule: AutomationRuleView) => void;
}) {
  return (
    <section className="context-panel" aria-label="Automations">
      <SectionHeading title="Automations" meta="quiet by default" />
      <div className="automation-list">
        {rules.map((rule) => (
          <article className="automation-row" key={rule.id}>
            <Clock size={19} />
            <span>
              <strong>{rule.title}</strong>
              <small>{rule.trigger} - {rule.destination}</small>
            </span>
            <span className="automation-status">
              <StatusDot tone={rule.status === "active" ? "ready" : rule.status === "paused" ? "paused" : "draft"} />
              {rule.status}
            </span>
            <button type="button" onClick={() => onToggle(rule)}>
              {rule.status === "active" ? "Pause" : "Enable"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
