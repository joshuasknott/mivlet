import type { Spine } from "@fable/protocol";

type Mission = Spine.Missions.Mission;
type PlanRevision = Spine.Missions.PlanRevision;
type Worker = Spine.Missions.Worker;
type WorkerContextReference = Spine.Missions.WorkerContextReference;
type WorkerToolRequirement = Spine.Missions.WorkerToolRequirement;
type WorkerHandoffContract = Spine.Missions.WorkerHandoffContract;
type ExecutionBudget = Spine.Missions.ExecutionBudget;

const DEFAULT_WORKER_BUDGET: Required<Pick<ExecutionBudget,
  "maxDurationMs" | "maxInputTokens" | "maxOutputTokens" | "maxToolCalls" | "maxAttempts"
>> = {
  maxDurationMs: 10 * 60_000,
  maxInputTokens: 32_000,
  maxOutputTokens: 8_000,
  maxToolCalls: 20,
  maxAttempts: 1
};

export const MAX_WORKER_CONTEXT_REFERENCES = 32;
export const MAX_WORKER_TOOLS = 32;

export interface ExplicitCapabilityGrant {
  capabilityId: Spine.Primitives.CapabilityId;
  capabilityGrantId: Spine.Primitives.CapabilityGrantId;
}

export interface CompileWorkerAssignmentInput {
  mission: Mission;
  planRevision: PlanRevision;
  runId: Spine.Primitives.RunId;
  workerId: Spine.Primitives.WorkerId;
  stepKey: string;
  roleKind?: Exclude<Spine.Missions.WorkerRoleKind, "orchestrator">;
  context: readonly WorkerContextReference[];
  tools: readonly WorkerToolRequirement[];
  grants: readonly ExplicitCapabilityGrant[];
  requestedBudget?: ExecutionBudget;
  handoff?: WorkerHandoffContract;
  now: string;
}

export class WorkerAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAssignmentError";
  }
}

/**
 * Compile one selected generated-plan step into an inspectable worker record.
 * This is not an authority resolver: every capability must carry one explicit
 * grant id, and native execution must still revalidate that grant at use time.
 */
export function compileWorkerAssignment(input: CompileWorkerAssignmentInput): Worker {
  const { mission, planRevision } = input;
  if (planRevision.missionId !== mission.id || mission.currentPlanRevisionId !== planRevision.id) {
    throw new WorkerAssignmentError("The worker must use the mission's selected plan revision.");
  }
  if (!sameScope(mission, planRevision)) {
    throw new WorkerAssignmentError("The mission and plan revision must share one authority scope.");
  }
  if (["completed", "partially-completed", "failed", "cancelled", "archived"].includes(mission.status)) {
    throw new WorkerAssignmentError("A terminal mission cannot create another worker.");
  }
  const step = planRevision.steps.find((candidate) => candidate.key === input.stepKey);
  if (!step) throw new WorkerAssignmentError("The selected plan step is unavailable.");
  if (input.context.length > MAX_WORKER_CONTEXT_REFERENCES) {
    throw new WorkerAssignmentError("The worker context exceeds its reference bound.");
  }
  const allowedContext = new Set(mission.scope.context.map(referenceKey));
  const contextKeys = new Set<string>();
  for (const item of input.context) {
    const key = referenceKey(item.reference);
    if (!allowedContext.has(key)) throw new WorkerAssignmentError("Worker context must be declared by the mission scope.");
    if (contextKeys.has(key)) throw new WorkerAssignmentError("Worker context references must be unique.");
    contextKeys.add(key);
    if (!item.purpose.trim() || (item.maxCharacters !== undefined && (!Number.isInteger(item.maxCharacters) || item.maxCharacters < 1))) {
      throw new WorkerAssignmentError("Worker context bounds are invalid.");
    }
  }
  if (input.tools.length > MAX_WORKER_TOOLS) throw new WorkerAssignmentError("The worker tool set exceeds its bound.");
  const toolNames = new Set<string>();
  for (const tool of input.tools) {
    if (!tool.toolName.trim() || !tool.purpose.trim() || toolNames.has(tool.toolName)) {
      throw new WorkerAssignmentError("Worker tools must be explicit, unique, and explained.");
    }
    toolNames.add(tool.toolName);
  }

  const requiredCapabilities = new Set(step.requiredCapabilities);
  const grantByCapability = new Map<Spine.Primitives.CapabilityId, Spine.Primitives.CapabilityGrantId>();
  for (const grant of input.grants) {
    if (!requiredCapabilities.has(grant.capabilityId) || grantByCapability.has(grant.capabilityId)) {
      throw new WorkerAssignmentError("Capability grants must map exactly once to required capabilities.");
    }
    grantByCapability.set(grant.capabilityId, grant.capabilityGrantId);
  }
  for (const capabilityId of requiredCapabilities) {
    if (!grantByCapability.has(capabilityId)) {
      throw new WorkerAssignmentError("Every worker capability requires an explicit standing grant reference.");
    }
  }
  if (input.handoff?.recipient === "worker" && !input.handoff.recipientWorkerId) {
    throw new WorkerAssignmentError("A worker handoff requires an exact recipient worker.");
  }

  const budget = boundedBudget(mission.budget, step.estimatedBudget, input.requestedBudget);
  const executionPolicy = workerExecutionPolicy(mission);
  const metadata = metadataFromMission(mission, input.now);
  return {
    ...metadata,
    id: input.workerId,
    runId: input.runId,
    status: "proposed",
    role: {
      kind: input.roleKind ?? (step.kind === "review" ? "reviewer" : step.kind === "act" ? "executor" : "specialist"),
      title: step.title,
      objective: step.objective,
      responsibilities: [step.objective]
    },
    planRevisionId: planRevision.id,
    planStepKey: step.key,
    context: input.context,
    capabilityIds: [...requiredCapabilities],
    capabilityGrantIds: [...requiredCapabilities].map((capability) => grantByCapability.get(capability)!),
    tools: input.tools,
    routePreference: executionPolicy.routePreference,
    placementPreference: executionPolicy.placementPreference,
    budget,
    stopConditions: [
      { kind: "objective-met", description: "Stop when the assigned objective and required outputs are complete." },
      { kind: "budget-reached", description: "Stop before any worker budget is exceeded." },
      { kind: "no-progress", description: "Stop after two iterations without useful progress.", threshold: 2 }
    ],
    outputContract: {
      slots: step.expectedOutputs,
      includeEvidence: step.acceptanceCriterionKeys.length > 0,
      includeUncertainty: true,
      delivery: input.handoff ? "handoff" : "run-result"
    },
    ...(input.handoff ? { handoffContract: input.handoff } : {})
  };
}

function workerExecutionPolicy(mission: Mission): Pick<
  Worker,
  "routePreference" | "placementPreference"
> {
  const routeIds = [...(mission.dataBoundary?.allowedProviderRouteIds ?? [])];
  const executionNodeIds = [...(mission.dataBoundary?.allowedExecutionNodeIds ?? [])];
  if (new Set(routeIds).size !== routeIds.length || new Set(executionNodeIds).size !== executionNodeIds.length) {
    throw new WorkerAssignmentError("Mission execution policy identities must be unique.");
  }
  if (
    executionNodeIds.length > 0
    && !executionNodeIds.includes("local-desktop" as Spine.Primitives.ExecutionNodeId)
  ) {
    throw new WorkerAssignmentError(
      "The selected Mission does not permit local desktop execution."
    );
  }
  return {
    routePreference: {
      policy: routeIds.length > 0 ? "require" : "automatic",
      providerRouteIds: routeIds,
      allowFallback: false,
      reason: routeIds.length > 0
        ? "Use only the provider routes saved by the Mission data boundary."
        : "Resolve one authorized route at execution time without crossing route boundaries."
    },
    placementPreference: {
      policy: "require",
      executionNodeIds: ["local-desktop" as Spine.Primitives.ExecutionNodeId],
      locality: "local",
      allowTransfer: false,
      reason: "This repository-local Mission runs only on the local desktop."
    }
  };
}

function boundedBudget(...budgets: readonly (ExecutionBudget | undefined)[]): ExecutionBudget {
  const numericKeys = ["maxDurationMs", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxAttempts"] as const;
  const result: ExecutionBudget = {};
  for (const key of numericKeys) {
    const values = [DEFAULT_WORKER_BUDGET[key], ...budgets.map((budget) => budget?.[key])]
      .filter((value): value is number => value !== undefined);
    if (values.some((value) => !Number.isInteger(value) || value < 1)) {
      throw new WorkerAssignmentError(`Worker ${key} must be a positive integer.`);
    }
    (result as Record<string, number>)[key] = Math.min(...values);
  }
  const maxCost = budgets.map((budget) => budget?.maxCost).find((value) => value !== undefined);
  return maxCost ? { ...result, maxCost } : result;
}

function metadataFromMission(mission: Mission, now: string): Spine.Primitives.ScopedRecordMetadata {
  const base = {
    workspaceId: mission.workspaceId,
    authority: mission.authority,
    schemaVersion: mission.schemaVersion,
    revision: 1,
    createdByInternalUserId: mission.createdByInternalUserId,
    ...(mission.createdByDeviceId ? { createdByDeviceId: mission.createdByDeviceId } : {}),
    createdAt: now,
    updatedAt: now
  } as const;
  return mission.visibility === "member-private"
    ? { ...base, visibility: "member-private", ownerMemberId: mission.ownerMemberId }
    : { ...base, visibility: "workspace-shared" };
}

function sameScope(mission: Mission, revision: PlanRevision): boolean {
  return mission.workspaceId === revision.workspaceId && mission.authority === revision.authority &&
    mission.schemaVersion === revision.schemaVersion && mission.visibility === revision.visibility &&
    (mission.visibility !== "member-private" ||
      (revision.visibility === "member-private" && mission.ownerMemberId === revision.ownerMemberId));
}

function referenceKey(reference: Spine.Missions.WorkContextReference): string {
  switch (reference.kind) {
    case "thread": return `thread:${reference.threadId}`;
    case "project": return `project:${reference.projectId}`;
    case "goal": return `goal:${reference.goalId}`;
    case "department": return `department:${reference.departmentId}`;
    case "pipeline": return `pipeline:${reference.pipelineId}`;
    case "artifact": return `artifact:${reference.artifactId}:${reference.versionId ?? ""}`;
    case "connection": return `connection:${reference.connectionId}`;
    default: return `${reference.kind}:${reference.reference}`;
  }
}
