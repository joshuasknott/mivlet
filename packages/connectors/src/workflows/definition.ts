import type { WorkflowDefinition, WorkflowStep } from "@fable/protocol";
import { effectForTool, evaluatePermissionPolicy } from "../permission-policy";

export const MAX_WORKFLOW_STEPS = 32;
export const MAX_WORKFLOW_TEXT_CHARACTERS = 16_000;

export function validateWorkflowDefinition(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  if (definition.schemaVersion !== 1) errors.push("Unsupported workflow schema version.");
  if (!definition.id.trim() || !definition.name.trim()) errors.push("Workflow id and name are required.");
  if (!Number.isInteger(definition.version) || definition.version < 1) errors.push("Workflow version must be positive.");
  if (definition.status && definition.status !== "active" && definition.status !== "paused") {
    errors.push("Workflow status must be active or paused.");
  }
  if (definition.steps.length === 0 || definition.steps.length > MAX_WORKFLOW_STEPS) {
    errors.push(`Workflow must contain 1-${MAX_WORKFLOW_STEPS} steps.`);
  }
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!step.id.trim() || ids.has(step.id)) errors.push("Workflow step ids must be unique and non-empty.");
    ids.add(step.id);
    const text =
      step.kind === "prompt" || step.kind === "agent"
        ? step.prompt
        : step.kind === "approval"
          ? step.description
          : "";
    if (text.length > MAX_WORKFLOW_TEXT_CHARACTERS) errors.push(`Step ${step.id} is too large.`);
    const profile = step.permissionProfile ?? definition.permissionProfile;
    if (
      step.permissionProfile &&
      definition.permissionProfile &&
      permissionRank(step.permissionProfile) > permissionRank(definition.permissionProfile)
    ) {
      errors.push(`Step ${step.id} cannot elevate the workflow permission profile.`);
    }
    const effect =
      step.kind === "connector-read" || step.kind === "connector-write"
        ? step.kind
        : step.kind === "tool"
          ? effectForTool(step.tool)
          : null;
    if (profile && effect) {
      const decision = evaluatePermissionPolicy({ profile, effect, riskLevel: "medium" });
      if (!decision.allowed) errors.push(`Step ${step.id} is not allowed by ${profile}.`);
    }
  }
  return errors;
}

function permissionRank(profile: "read-only" | "trusted" | "full-with-approvals"): number {
  return profile === "read-only" ? 0 : profile === "trusted" ? 1 : 2;
}

export function nextWorkflowVersion(
  current: WorkflowDefinition,
  changes: Partial<Pick<WorkflowDefinition, "name" | "description" | "steps" | "notificationPrefs">>,
  now: string
): WorkflowDefinition {
  return { ...current, ...changes, version: current.version + 1, updatedAt: now };
}

/** Pause/resume by creating a new immutable definition version. */
export function setWorkflowStatus(
  current: WorkflowDefinition,
  status: "active" | "paused",
  now: string
): WorkflowDefinition {
  return {
    ...current,
    status,
    version: current.version + 1,
    updatedAt: now
  };
}

export function requiredConnectors(step: WorkflowStep): string[] {
  if (step.kind === "connector-read" || step.kind === "connector-write") return [step.connectorId];
  if (step.kind === "prompt" || step.kind === "agent") return step.requiresConnectors ?? [];
  return [];
}
