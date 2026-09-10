import type { ToolExecutor } from "@fable/connectors";
import { isLocalComputerTool } from "./computer-tools";

const OBSERVATIONS = new Set(["local-app-observe", "local-desktop-observe"]);
const MUTATIONS = new Set(["local-app-action", "local-desktop-action", "write-file"]);
type RecoveryClass = "stale-observation" | "loading" | "human-control" | "uncertain-effect" | "foreground-required";
type PendingRecovery = { kind: RecoveryClass; tools: ReadonlySet<string>; target?: string };

const RECOVERY_LIMIT = 3;
const RECOVERY_ACTIVITY: Record<RecoveryClass, string> = {
  "stale-observation": "Recovering: checking the current state",
  loading: "Waiting for the application to finish loading",
  "human-control": "Waiting for computer control",
  "uncertain-effect": "Checking whether the last action completed",
  "foreground-required": "This action needs the foreground window"
};
const RECOVERY_GUIDANCE: Record<RecoveryClass, string> = {
  "stale-observation": "Observe the current application before making another change.",
  loading: "Wait briefly, then observe the application again before making another change.",
  "human-control": "Wait for the user to return control, then observe the current state before acting.",
  "uncertain-effect": "The previous action has an uncertain outcome. Reconcile its result before making another change; do not replay it.",
  "foreground-required": "Request an approved foreground window selection, then observe it before choosing the next action. No input was sent."
};

/** A fresh guard belongs to one provider turn. It never retries an action. */
export function createComputerTaskExecutor(execute: ToolExecutor, activity: (message: string) => void = () => {}): ToolExecutor {
  let calls = 0;
  let failedActions = 0;
  let unchangedActions = 0;
  let mutationSinceObservation = false;
  let observation = "";
  let blocked = "";
  let pendingRecovery: PendingRecovery | null = null;
  const recoveryFailures = new Map<RecoveryClass, number>();
  const preflightFailures = new Map<string, number>();
  const uncertainActions = new Set<string>();
  return async (approval, argumentsJson) => {
    const name = approval.action.split(/\s+/)[0];
    if (!isLocalComputerTool(name, argumentsJson)) return execute(approval, argumentsJson);
    const mutation = MUTATIONS.has(name);
    const fingerprint = `${name}:${stableArguments(argumentsJson)}`;
    if (++calls > 80) blocked = "This computer turn reached its action limit. Explain the current state and ask the user to continue.";
    if (mutation && (blocked || pendingRecovery)) {
      const message = blocked || RECOVERY_GUIDANCE[pendingRecovery!.kind];
      activity("Computer needs attention");
      throw new Error(message);
    }
    if (mutation && uncertainActions.has(fingerprint)) {
      activity("Computer needs attention");
      throw new Error("This exact action already has an uncertain outcome. Do not replay it; use the reconciled state to choose a different next step.");
    }
    if (mutation && (preflightFailures.get(fingerprint) ?? 0) >= 2) {
      activity("Computer needs attention");
      throw new Error("This action failed twice before execution. Stop repeating it and explain what prerequisite needs attention.");
    }
    if (calls > 84) throw new Error("Computer work stopped at its turn limit. Report the current state to the user.");
    try {
      const result = await execute(approval, argumentsJson);
      if (mutation && stringArgument(result, "status") === "foreground-required") {
        mutationSinceObservation = false;
        preflightFailures.set(fingerprint, (preflightFailures.get(fingerprint) ?? 0) + 1);
        pendingRecovery = { kind: "foreground-required", tools: new Set(["local-app-select"]) };
        activity(RECOVERY_ACTIVITY["foreground-required"]);
        return result;
      }
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
      if (pendingRecovery && recoverySatisfied(pendingRecovery, name, argumentsJson)) {
        if (pendingRecovery.kind === "foreground-required") {
          if (stringArgument(argumentsJson, "deliveryMode") === "foreground"
            && stringArgument(result, "status") === "active"
            && stringArgument(result, "deliveryMode") === "foreground") {
            pendingRecovery = { kind: "stale-observation", tools: OBSERVATIONS };
          }
        } else pendingRecovery = null;
      }
      return result;
    } catch (error) {
      if (mutation) {
        if (++failedActions >= 4) blocked = "Several computer actions failed. Stop making changes and explain the current obstacle.";
      }
      const classified = classifyRecovery(error, name, argumentsJson);
      const recovery = pendingRecovery?.kind === "uncertain-effect"
        ? pendingRecovery
        : classified;
      if (classified?.kind === "uncertain-effect" && mutation) {
        uncertainActions.add(fingerprint);
      } else if (!classified && mutation && provesNoEffect(error)) {
        preflightFailures.set(fingerprint, (preflightFailures.get(fingerprint) ?? 0) + 1);
      }
      if (recovery && recovery !== pendingRecovery) {
        const failures = (recoveryFailures.get(recovery.kind) ?? 0) + 1;
        recoveryFailures.set(recovery.kind, failures);
        pendingRecovery = recovery;
        if (failures >= RECOVERY_LIMIT) {
          blocked = `Computer recovery stopped after ${RECOVERY_LIMIT} ${recovery.kind.replaceAll("-", " ")} failures. Explain the current evidence and what needs attention.`;
        }
      }
      if (recovery) {
        activity(RECOVERY_ACTIVITY[recovery.kind]);
      } else {
        activity("Recovering: checking the current state");
      }
      throw error;
    }
  };
}

function classifyRecovery(error: unknown, tool: string, argumentsJson: string): PendingRecovery | null {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : String(error).toLowerCase();
  if (code === "uncertain-effect" || code === "ambiguous-effect"
    || message.includes("outcome is uncertain") || message.includes("result is uncertain")
    || message.includes("may still be running") || message.includes("could not confirm whether")) {
    return uncertainRecovery(tool, argumentsJson);
  }
  if (message.includes("private sign-in or dialog") || message.includes("private browser or sign-in surface")
    || message.includes("return control") || message.includes("user has control")
    || message.includes("actions and agent observation are paused") || message.includes("control changed or is paused") || message.includes("fresh permission") || message.includes("select a window and allow")) {
    return { kind: "human-control", tools: observationTools(tool) };
  }
  if (message.includes("after it finishes loading")) {
    return { kind: "loading", tools: observationTools(tool) };
  }
  if (code === "stale-action" || message.includes("observation is stale")
    || message.includes("control is stale") || message.includes("observed application control changed")
    || message.includes("observed application control changed") || message.includes("observation delivery expired")
    || message.includes("observe the selected window before acting")) {
    return { kind: "stale-observation", tools: observationTools(tool) };
  }
  if (MUTATIONS.has(tool) && !provesNoEffect(error)) {
    return uncertainRecovery(tool, argumentsJson);
  }
  return null;
}

function provesNoEffect(error: unknown): boolean {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (["unsupported-action", "permission-denied", "approval-required", "approval-denied", "approval-missing"].includes(code)) {
    return true;
  }
  const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : String(error).toLowerCase();
  return message.startsWith("tool call denied:")
    || message.startsWith("execution blocked:")
    || message.startsWith("set up this agent's")
    || message.startsWith("unknown tool ")
    || message.includes("requires the desktop runtime to execute")
    || message.includes("requires click, fill, press, or select")
    || message.includes("requires an exact observed tab ref")
    || message.includes("action is not allowed for the observed browser control");
}

function observationTools(tool: string): ReadonlySet<string> {
  return new Set(tool.startsWith("local-app")
    ? ["local-app-observe"]
    : ["local-desktop-observe"]);
}

function uncertainRecovery(tool: string, argumentsJson: string): PendingRecovery {
  if (tool === "write-file") {
    return { kind: "uncertain-effect", tools: new Set(["read-file"]), target: stringArgument(argumentsJson, "path") };
  }
  if (tool.startsWith("local-app")) {
    return { kind: "uncertain-effect", tools: new Set(["local-app-observe"]) };
  }
  if (tool === "local-desktop-action") {
    return { kind: "uncertain-effect", tools: new Set(["local-desktop-observe"]) };
  }
  return { kind: "uncertain-effect", tools: new Set() };
}

function recoverySatisfied(recovery: PendingRecovery, tool: string, argumentsJson: string): boolean {
  if (!recovery.tools.has(tool)) return false;
  return recovery.target === undefined || recovery.target === stringArgument(argumentsJson, "path");
}

function stringArgument(argumentsJson: string, key: string): string | undefined {
  try {
    const value = JSON.parse(argumentsJson)?.[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
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
