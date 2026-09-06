import type { ToolExecutor } from "@fable/connectors";
import { isLocalComputerTool } from "./computer-tools";

const OBSERVATIONS = new Set(["local-browser-observe", "local-desktop-observe"]);
const MUTATIONS = new Set(["local-browser", "local-browser-action", "local-browser-tab", "local-desktop-action", "write-file", "run-shell"]);

/** A fresh guard belongs to one provider turn. It never retries an action. */
export function createComputerTaskExecutor(execute: ToolExecutor, activity: (message: string) => void = () => {}): ToolExecutor {
  let calls = 0;
  let failedActions = 0;
  let unchangedActions = 0;
  let mutationSinceObservation = false;
  let observation = "";
  let blocked = "";
  const failures = new Map<string, number>();
  return async (approval, argumentsJson) => {
    const name = approval.action.split(/\s+/)[0];
    if (!isLocalComputerTool(name, argumentsJson)) return execute(approval, argumentsJson);
    const mutation = MUTATIONS.has(name);
    const fingerprint = `${name}:${stableArguments(argumentsJson)}`;
    if (++calls > 80) blocked = "This computer turn reached its action limit. Explain the current state and ask the user to continue.";
    if (mutation && (blocked || (failures.get(fingerprint) ?? 0) >= 2)) {
      const message = blocked || "This step failed twice. Stop retrying it and explain what needs attention.";
      activity("Computer needs attention");
      throw new Error(message);
    }
    if (calls > 84) throw new Error("Computer work stopped at its turn limit. Report the current state to the user.");
    try {
      const result = await execute(approval, argumentsJson);
      if (OBSERVATIONS.has(name)) {
        const next = stableArguments(result);
        if (mutationSinceObservation) unchangedActions = next === observation ? unchangedActions + 1 : 0;
        mutationSinceObservation = false;
        observation = next;
        if (unchangedActions >= 3) blocked = "Three actions left the observed application unchanged. Stop acting and explain the obstacle.";
        activity(blocked ? "Computer needs attention" : "Checking the current computer state");
      } else if (mutation) {
        mutationSinceObservation = true;
        activity("Verifying computer work");
      }
      return result;
    } catch (error) {
      if (mutation) {
        failures.set(fingerprint, (failures.get(fingerprint) ?? 0) + 1);
        if (++failedActions >= 4) blocked = "Several computer actions failed. Stop making changes and explain the current obstacle.";
      }
      const message = error instanceof Error ? error.message : String(error);
      activity(/control changed|paused|return control|user has control/i.test(message)
        ? "Waiting for computer control" : "Recovering: checking the current state");
      throw error;
    }
  };
}

/** Remove freshness-only fields, preserving the actual observed state/arguments. */
function stableArguments(value: string): string {
  try {
    const visit = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(visit);
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(Object.entries(item).filter(([key]) => !["observationId", "elementRef", "tabRef", "ref", "activeTabRef", "updatedAt", "observedAt", "expiresAt"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, visit(nested)]));
    };
    return JSON.stringify(visit(JSON.parse(value)));
  } catch { return value; }
}
