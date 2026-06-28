import type { WorkflowDefinition, WorkflowStep } from "@fable/protocol";

export const MAX_WORKFLOW_STEPS = 32;
export const MAX_WORKFLOW_TEXT_CHARACTERS = 16_000;

export function validateWorkflowDefinition(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  if (definition.schemaVersion !== 1) errors.push("Unsupported workflow schema version.");
  if (!definition.id.trim() || !definition.name.trim()) errors.push("Workflow id and name are required.");
  if (!Number.isInteger(definition.version) || definition.version < 1) errors.push("Workflow version must be positive.");
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
  }
  return errors;
}

export function nextWorkflowVersion(
  current: WorkflowDefinition,
  changes: Partial<Pick<WorkflowDefinition, "name" | "description" | "steps" | "notificationPrefs">>,
  now: string
): WorkflowDefinition {
  return { ...current, ...changes, version: current.version + 1, updatedAt: now };
}

export function requiredConnectors(step: WorkflowStep): string[] {
  if (step.kind === "connector-read") return [step.connectorId];
  if (step.kind === "prompt" || step.kind === "agent") return step.requiresConnectors ?? [];
  return [];
}
