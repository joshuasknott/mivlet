import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunTrigger,
  WorkflowStep,
  WorkflowStepRecord
} from "@fable/protocol";
import { assertFreshApproval, workflowMutationKey } from "./idempotency";
import { requiredConnectors, validateWorkflowDefinition } from "./definition";

export interface WorkflowRunnerDependencies {
  now: () => Date;
  persist: (run: WorkflowRun) => Promise<void>;
  connected: (connectorId: string) => boolean;
  prompt: (text: string, input: Record<string, unknown>) => Promise<unknown>;
  connectorRead: (step: Extract<WorkflowStep, { kind: "connector-read" }>) => Promise<unknown>;
  agent: (step: Extract<WorkflowStep, { kind: "agent" }>) => Promise<unknown>;
  tool: (
    step: Extract<WorkflowStep, { kind: "tool" }>,
    idempotencyKey: string
  ) => Promise<unknown>;
}

export interface WorkflowRunOptions {
  runId: string;
  trigger: WorkflowRunTrigger;
  input?: Record<string, unknown>;
  scheduledJobId?: string;
  previous?: WorkflowRun;
  approvals?: Record<
    string,
    { decision: "approved" | "denied" | "expired"; decidedAt?: string; expiresAt?: string }
  >;
}

const iso = (date: Date) => date.toISOString();

export async function runWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowRunOptions,
  dependencies: WorkflowRunnerDependencies
): Promise<WorkflowRun> {
  const errors = validateWorkflowDefinition(definition);
  if (errors.length) throw new Error(errors.join(" "));
  const startedAt = options.previous?.startedAt ?? iso(dependencies.now());
  let run: WorkflowRun = options.previous ?? {
    id: options.runId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    status: "running",
    trigger: options.trigger,
    scheduledJobId: options.scheduledJobId,
    input: options.input ?? {},
    steps: [],
    idempotencyKey: `workflow:${options.runId}`,
    startedAt,
    updatedAt: startedAt
  };
  run = { ...run, status: "running", updatedAt: iso(dependencies.now()) };
  await dependencies.persist(run);

  for (const step of definition.steps) {
    const existing = run.steps.find((record) => record.stepId === step.id);
    if (existing?.status === "succeeded") continue;
    const disconnected = requiredConnectors(step).find((connector) => !dependencies.connected(connector));
    if (disconnected) {
      const record: WorkflowStepRecord = {
        stepId: step.id,
        status: "failed",
        error: `${disconnected} must be connected before this step can run.`,
        startedAt: iso(dependencies.now()),
        finishedAt: iso(dependencies.now())
      };
      run = finishFailed(run, record, record.error!, dependencies.now());
      await dependencies.persist(run);
      return run;
    }

    const started = iso(dependencies.now());
    const running: WorkflowStepRecord = { stepId: step.id, status: "running", startedAt: started };
    run = replaceRecord(run, running, dependencies.now());
    await dependencies.persist(run);

    if (step.kind === "approval" || (step.kind === "tool" && step.consequential)) {
      const approval = assertFreshApproval(options.approvals?.[step.id], dependencies.now());
      if (approval === "pending" || approval === "expired") {
        const awaiting: WorkflowStepRecord = {
          ...running,
          status: "awaiting-approval",
          approval: { decision: approval === "expired" ? "expired" : "pending" }
        };
        run = {
          ...replaceRecord(run, awaiting, dependencies.now()),
          status: "awaiting-approval"
        };
        await dependencies.persist(run);
        return run;
      }
      if (approval === "denied") {
        const denied: WorkflowStepRecord = {
          ...running,
          status: "failed",
          approval: { decision: "denied", decidedAt: options.approvals?.[step.id]?.decidedAt },
          error: "Approval denied.",
          finishedAt: iso(dependencies.now())
        };
        run = finishFailed(run, denied, "Approval denied.", dependencies.now());
        await dependencies.persist(run);
        return run;
      }
      running.approval = {
        decision: "approved",
        decidedAt: options.approvals?.[step.id]?.decidedAt,
        expiresAt: options.approvals?.[step.id]?.expiresAt
      };
    }

    try {
      let output: unknown;
      if (step.kind === "prompt") output = await dependencies.prompt(step.prompt, run.input);
      else if (step.kind === "connector-read") output = await dependencies.connectorRead(step);
      else if (step.kind === "agent") output = await dependencies.agent(step);
      else if (step.kind === "tool") {
        output = await dependencies.tool(
          step,
          workflowMutationKey(run.id, step.id, step.tool, step.arguments)
        );
      } else output = { approved: true };
      const succeeded: WorkflowStepRecord = {
        ...running,
        status: "succeeded",
        output,
        finishedAt: iso(dependencies.now())
      };
      run = replaceRecord(run, succeeded, dependencies.now());
      await dependencies.persist(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workflow step failed.";
      const failed: WorkflowStepRecord = {
        ...running,
        status: "failed",
        error: message,
        finishedAt: iso(dependencies.now())
      };
      run = finishFailed(run, failed, message, dependencies.now());
      await dependencies.persist(run);
      return run;
    }
  }

  const finishedAt = iso(dependencies.now());
  run = { ...run, status: "completed", updatedAt: finishedAt, finishedAt };
  await dependencies.persist(run);
  return run;
}

function replaceRecord(run: WorkflowRun, record: WorkflowStepRecord, now: Date): WorkflowRun {
  return {
    ...run,
    steps: [...run.steps.filter((candidate) => candidate.stepId !== record.stepId), record],
    updatedAt: iso(now)
  };
}

function finishFailed(
  run: WorkflowRun,
  record: WorkflowStepRecord,
  reason: string,
  now: Date
): WorkflowRun {
  const finishedAt = iso(now);
  return {
    ...replaceRecord(run, record, now),
    status: "failed",
    failureReason: reason,
    updatedAt: finishedAt,
    finishedAt
  };
}
