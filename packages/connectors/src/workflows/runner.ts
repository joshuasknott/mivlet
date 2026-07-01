import type {
  PermissionProfileId,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunTrigger,
  WorkflowStep,
  WorkflowStepRecord
} from "@fable/protocol";
import { assertFreshApproval, workflowMutationKey } from "./idempotency";
import { requiredConnectors, validateWorkflowDefinition } from "./definition";
import {
  effectForTool,
  evaluatePermissionPolicy,
  permissionModeForProfile,
  type PermissionEffect
} from "../permission-policy";
import {
  redactSecretsFromObject,
  redactSecretsFromString
} from "../agent-runtime/utils/redact";

export interface WorkflowRunnerDependencies {
  now: () => Date;
  persist: (run: WorkflowRun) => Promise<void>;
  connected: (connectorId: string) => boolean;
  prompt: (text: string, input: Record<string, unknown>) => Promise<unknown>;
  connectorRead: (
    step: Extract<WorkflowStep, { kind: "connector-read" }>,
    signal?: AbortSignal
  ) => Promise<unknown>;
  connectorWrite?: (
    step: Extract<WorkflowStep, { kind: "connector-write" }>,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => Promise<unknown>;
  agent: (step: Extract<WorkflowStep, { kind: "agent" }>) => Promise<unknown>;
  tool: (
    step: Extract<WorkflowStep, { kind: "tool" }>,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => Promise<unknown>;
  /** Optional append-only execution observer; it never grants authority. */
  audit?: (event: WorkflowAuditEvent) => Promise<void> | void;
}

export interface WorkflowRunOptions {
  runId: string;
  trigger: WorkflowRunTrigger;
  input?: Record<string, unknown>;
  scheduledJobId?: string;
  previous?: WorkflowRun;
  /** Captured run profile. Revalidated at start and before every task. */
  permissionProfile?: PermissionProfileId;
  attemptNumber?: number;
  signal?: AbortSignal;
  approvals?: Record<
    string,
    { decision: "approved" | "denied" | "expired"; decidedAt?: string; expiresAt?: string }
  >;
}

export interface WorkflowAuditEvent {
  runId: string;
  definitionId: string;
  stepId?: string;
  action: "started" | "task-started" | "task-succeeded" | "task-failed" | "cancelled" | "completed";
  status: string;
  errorCode?: string;
}

const iso = (date: Date) => date.toISOString();

export async function runWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowRunOptions,
  dependencies: WorkflowRunnerDependencies
): Promise<WorkflowRun> {
  const errors = validateWorkflowDefinition(definition);
  if (errors.length) throw new Error(errors.join(" "));
  if ((definition.status ?? "active") !== "active") {
    throw new Error("Workflow is paused.");
  }
  const startedAt = options.previous?.startedAt ?? iso(dependencies.now());
  const permissionProfile =
    options.permissionProfile ??
    options.previous?.permissionProfile ??
    definition.permissionProfile ??
    "trusted";
  let run: WorkflowRun = options.previous ?? {
    id: options.runId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    status: "running",
    trigger: options.trigger,
    scheduledJobId: options.scheduledJobId,
    permissionProfile,
    input: options.input ?? {},
    steps: [],
    idempotencyKey: `workflow:${options.runId}`,
    attemptNumber: options.attemptNumber ?? 1,
    startedAt,
    updatedAt: startedAt
  };
  if (options.trigger === "schedule") {
    const startPolicy = evaluatePermissionPolicy({
      profile: permissionProfile,
      effect: "schedule-execution",
      riskLevel: "medium"
    });
    if (!startPolicy.allowed) {
      run = finishFailed(
        run,
        {
          stepId: "__run__",
          status: "failed",
          error: startPolicy.reason,
          errorCode: "permission-denied",
          startedAt,
          finishedAt: iso(dependencies.now())
        },
        startPolicy.reason,
        dependencies.now()
      );
      await dependencies.persist(sanitizeRun(run));
      return sanitizeRun(run);
    }
  }
  run = {
    ...run,
    permissionProfile,
    status: "running",
    failureReason: undefined,
    finishedAt: undefined,
    nextRetryAt: undefined,
    updatedAt: iso(dependencies.now())
  };
  run = sanitizeRun(run);
  await dependencies.persist(run);
  await observe(dependencies, {
    runId: run.id,
    definitionId: definition.id,
    action: "started",
    status: "running"
  });

  for (const step of definition.steps) {
    if (options.signal?.aborted) {
      run = cancelRun(run, dependencies.now());
      await dependencies.persist(run);
      await observe(dependencies, {
        runId: run.id,
        definitionId: definition.id,
        action: "cancelled",
        status: "cancelled"
      });
      return run;
    }
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
    const taskProfile = step.permissionProfile ?? permissionProfile;
    const taskPolicy = evaluatePermissionPolicy({
      profile: taskProfile,
      mode: permissionModeForProfile(taskProfile),
      effect: effectForStep(step),
      riskLevel: step.kind === "tool" && step.consequential ? "high" : "medium"
    });
    const attemptsElevation = permissionRank(taskProfile) > permissionRank(permissionProfile);
    if (!taskPolicy.allowed || attemptsElevation) {
      const reason = attemptsElevation
        ? "A workflow task cannot elevate the run permission profile."
        : taskPolicy.reason;
      const denied: WorkflowStepRecord = {
        ...running,
        status: "failed",
        error: reason,
        errorCode: "permission-denied",
        finishedAt: iso(dependencies.now())
      };
      run = finishFailed(run, denied, reason, dependencies.now());
      await dependencies.persist(sanitizeRun(run));
      await observe(dependencies, {
        runId: run.id,
        definitionId: definition.id,
        stepId: step.id,
        action: "task-failed",
        status: "blocked",
        errorCode: "permission-denied"
      });
      return sanitizeRun(run);
    }
    run = replaceRecord(run, running, dependencies.now());
    await dependencies.persist(run);
    await observe(dependencies, {
      runId: run.id,
      definitionId: definition.id,
      stepId: step.id,
      action: "task-started",
      status: "running"
    });

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
      else if (step.kind === "connector-read") {
        const response = await dependencies.connectorRead(step, options.signal);
        output = {
          connectorId: step.connectorId,
          capability: step.capability,
          response
        };
        run = {
          ...run,
          input: { ...run.input, [step.outputVar]: redactSecretsFromObject(response) }
        };
      }
      else if (step.kind === "connector-write") {
        if (!dependencies.connectorWrite) {
          throw Object.assign(new Error("Connector writes are unavailable in this runtime."), {
            code: "connector-capability-unavailable"
          });
        }
        const response = await dependencies.connectorWrite(
          step,
          workflowMutationKey(run.id, step.id, step.capability, step.input),
          options.signal
        );
        output = {
          connectorId: step.connectorId,
          capability: step.capability,
          response
        };
        if (step.outputVar) {
          run = {
            ...run,
            input: { ...run.input, [step.outputVar]: redactSecretsFromObject(response) }
          };
        }
      }
      else if (step.kind === "agent") output = await dependencies.agent(step);
      else if (step.kind === "tool") {
        output = await dependencies.tool(
          step,
          workflowMutationKey(run.id, step.id, step.tool, step.arguments),
          options.signal
        );
      } else output = { approved: true };
      if (options.signal?.aborted) {
        run = cancelRun(run, dependencies.now());
        await dependencies.persist(run);
        return run;
      }
      const succeeded: WorkflowStepRecord = {
        ...running,
        status: "succeeded",
        output: redactSecretsFromObject(output),
        finishedAt: iso(dependencies.now())
      };
      run = replaceRecord(run, succeeded, dependencies.now());
      await dependencies.persist(run);
      await observe(dependencies, {
        runId: run.id,
        definitionId: definition.id,
        stepId: step.id,
        action: "task-succeeded",
        status: "ok"
      });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        run = cancelRun(run, dependencies.now());
        await dependencies.persist(run);
        return run;
      }
      const { message, code } = failureMetadata(error);
      const failed: WorkflowStepRecord = {
        ...running,
        status: "failed",
        error: message,
        errorCode: code,
        finishedAt: iso(dependencies.now())
      };
      run = finishFailed(run, failed, message, dependencies.now());
      if (code === "authentication" || code === "expired-auth") {
        run = { ...run, status: "blocked-auth" };
      }
      await dependencies.persist(run);
      await observe(dependencies, {
        runId: run.id,
        definitionId: definition.id,
        stepId: step.id,
        action: "task-failed",
        status: "failed",
        errorCode: code
      });
      return run;
    }
  }

  const finishedAt = iso(dependencies.now());
  run = { ...run, status: "completed", updatedAt: finishedAt, finishedAt };
  await dependencies.persist(run);
  await observe(dependencies, {
    runId: run.id,
    definitionId: definition.id,
    action: "completed",
    status: "ok"
  });
  return run;
}

function permissionRank(profile: PermissionProfileId): number {
  return profile === "read-only" ? 0 : profile === "trusted" ? 1 : 2;
}

async function observe(
  dependencies: WorkflowRunnerDependencies,
  event: WorkflowAuditEvent
): Promise<void> {
  try {
    await dependencies.audit?.(event);
  } catch {
    // Audit observes execution and must never become execution authority.
  }
}

function effectForStep(step: WorkflowStep): PermissionEffect {
  if (step.kind === "connector-read") return "connector-read";
  if (step.kind === "connector-write") return "connector-write";
  if (step.kind === "tool") {
    return effectForTool(step.tool) ?? (step.consequential ? "app-state-mutation" : "local-read");
  }
  return "local-read";
}

function failureMetadata(error: unknown): { message: string; code: string } {
  const candidate = error as { message?: string; code?: string };
  return {
    message: redactSecretsFromString(candidate?.message ?? "Workflow step failed."),
    code: candidate?.code ?? "workflow-step-failed"
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string })?.name === "AbortError";
}

function sanitizeRun(run: WorkflowRun): WorkflowRun {
  return redactSecretsFromObject(run);
}

function cancelRun(run: WorkflowRun, now: Date): WorkflowRun {
  const finishedAt = iso(now);
  return {
    ...run,
    status: "cancelled",
    failureReason: "Cancelled.",
    updatedAt: finishedAt,
    finishedAt,
    steps: run.steps.map((record) =>
      record.status === "running"
        ? {
            ...record,
            status: "failed",
            error: "Cancelled.",
            errorCode: "cancelled",
            finishedAt
          }
        : record
    )
  };
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
