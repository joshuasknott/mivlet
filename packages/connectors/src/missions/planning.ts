import type { Spine } from "@fable/protocol";

type Mission = Spine.Missions.Mission;
type MissionPlan = Spine.Missions.MissionPlan;
type PlanBounds = Spine.Missions.PlanBounds;
type PlanRevision = Spine.Missions.PlanRevision;
type PlanRevisionReason = Spine.Missions.PlanRevisionReason;
type PlanStep = Spine.Missions.PlanStep;
type ExecutionDepth = Spine.Missions.ExecutionDepth;
type PlanId = Spine.Primitives.PlanId;
type PlanRevisionId = Spine.Primitives.PlanRevisionId;

export const MAX_GENERATED_PLAN_STEPS = 32;
export const MAX_GENERATED_PLAN_DEPENDENCIES = 8;
export const MAX_GENERATED_PLAN_REVISIONS = 12;

export class MissionPlanValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join(" "));
    this.name = "MissionPlanValidationError";
    this.issues = issues;
  }
}

export interface MissionPlanSizing {
  executionDepth: Exclude<ExecutionDepth, "direct">;
  workerLimit: number;
  parallelWidth: number;
  reasons: readonly string[];
}

export interface GeneratedPlanDraft {
  summary: string;
  bounds: PlanBounds;
  steps: readonly PlanStep[];
}

export interface MissionPlanLifecycle {
  mission: Mission;
  plan: MissionPlan;
  currentRevision: PlanRevision;
  sizing: MissionPlanSizing;
}

interface CreatePlanInput {
  mission: Mission;
  planId: PlanId;
  revisionId: PlanRevisionId;
  draft: GeneratedPlanDraft;
  now: string;
}

interface RevisePlanInput {
  mission: Mission;
  plan: MissionPlan;
  currentRevision: PlanRevision;
  revisionId: PlanRevisionId;
  reason: Exclude<PlanRevisionReason, "initial">;
  draft: GeneratedPlanDraft;
  now: string;
  expectedPlanRevision: number;
}

export function validateGeneratedPlan(mission: Mission, draft: GeneratedPlanDraft): readonly string[] {
  const issues: string[] = [];
  const { bounds, steps } = draft;
  if (!draft.summary.trim()) issues.push("A generated plan summary is required.");
  if (!Number.isInteger(bounds.maxSteps) || bounds.maxSteps < 1 || bounds.maxSteps > MAX_GENERATED_PLAN_STEPS) {
    issues.push(`Plan maxSteps must be between 1 and ${MAX_GENERATED_PLAN_STEPS}.`);
  }
  if (
    !Number.isInteger(bounds.maxDependenciesPerStep) ||
    bounds.maxDependenciesPerStep < 0 ||
    bounds.maxDependenciesPerStep > MAX_GENERATED_PLAN_DEPENDENCIES
  ) {
    issues.push(`Plan maxDependenciesPerStep must be between 0 and ${MAX_GENERATED_PLAN_DEPENDENCIES}.`);
  }
  if (!Number.isInteger(bounds.maxParallelSteps) || bounds.maxParallelSteps < 1 || bounds.maxParallelSteps > bounds.maxSteps) {
    issues.push("Plan maxParallelSteps must be positive and no greater than maxSteps.");
  }
  if (
    bounds.maxRevisions !== undefined &&
    (!Number.isInteger(bounds.maxRevisions) || bounds.maxRevisions < 1 || bounds.maxRevisions > MAX_GENERATED_PLAN_REVISIONS)
  ) {
    issues.push(`Plan maxRevisions must be between 1 and ${MAX_GENERATED_PLAN_REVISIONS}.`);
  }
  if (steps.length < 1 || steps.length > bounds.maxSteps) {
    issues.push("Generated steps must be non-empty and stay within maxSteps.");
  }

  const criterionKeys = new Set(mission.acceptance.criteria.map((criterion) => criterion.key));
  const deliverableKeys = new Set(mission.outcome.deliverables.map((deliverable) => deliverable.key));
  const stepKeys = new Set<string>();
  for (const step of steps) {
    if (!step.key.trim() || stepKeys.has(step.key)) issues.push("Plan step keys must be unique and non-empty.");
    stepKeys.add(step.key);
    if (!step.title.trim() || !step.objective.trim()) issues.push(`Plan step ${step.key || "<empty>"} needs a title and objective.`);
    if (step.dependsOnStepKeys.length > bounds.maxDependenciesPerStep) {
      issues.push(`Plan step ${step.key} exceeds maxDependenciesPerStep.`);
    }
    for (const criterionKey of step.acceptanceCriterionKeys) {
      if (!criterionKeys.has(criterionKey)) issues.push(`Plan step ${step.key} references unknown acceptance criterion ${criterionKey}.`);
    }
    for (const output of step.expectedOutputs) {
      if (!deliverableKeys.has(output.key)) issues.push(`Plan step ${step.key} references unknown deliverable ${output.key}.`);
    }
  }
  for (const step of steps) {
    for (const dependency of step.dependsOnStepKeys) {
      if (dependency === step.key) issues.push(`Plan step ${step.key} cannot depend on itself.`);
      else if (!stepKeys.has(dependency)) issues.push(`Plan step ${step.key} depends on unknown step ${dependency}.`);
    }
  }

  const graphIssue = detectCycle(steps);
  if (graphIssue) issues.push(graphIssue);
  const parallelWidth = calculateParallelWidth(steps);
  if (parallelWidth > bounds.maxParallelSteps) {
    issues.push(`Generated plan parallel width ${parallelWidth} exceeds maxParallelSteps ${bounds.maxParallelSteps}.`);
  }
  const requiredCriteria = new Set(
    mission.acceptance.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.key)
  );
  const coveredCriteria = new Set(steps.flatMap((step) => [...step.acceptanceCriterionKeys]));
  for (const key of requiredCriteria) {
    if (!coveredCriteria.has(key)) issues.push(`Required acceptance criterion ${key} is not covered by the plan.`);
  }
  for (const deliverable of mission.outcome.deliverables) {
    if (deliverable.required && !steps.some((step) => step.expectedOutputs.some((output) => output.key === deliverable.key))) {
      issues.push(`Required deliverable ${deliverable.key} is not produced by the plan.`);
    }
  }
  return issues;
}

export function sizeMissionPlan(mission: Mission, draft: GeneratedPlanDraft): MissionPlanSizing {
  assertValid(mission, draft);
  const parallelWidth = calculateParallelWidth(draft.steps);
  const missionWorkerLimit = mission.budget?.maxWorkers ?? 1;
  const workerLimit = Math.max(1, Math.min(missionWorkerLimit, draft.bounds.maxParallelSteps, parallelWidth));
  const multiWorker = workerLimit > 1 && (parallelWidth > 1 || draft.steps.length >= 4);
  return {
    executionDepth: multiWorker ? "multi-worker" : "delegated",
    workerLimit,
    parallelWidth,
    reasons: multiWorker
      ? [`${parallelWidth} independent steps are available within the ${workerLimit}-worker budget.`]
      : [missionWorkerLimit < 2 ? "The mission budget permits one worker." : "The plan has no useful bounded parallel work."]
  };
}

export function createMissionPlan(input: CreatePlanInput): MissionPlanLifecycle {
  if (input.mission.currentPlanId || input.mission.currentPlanRevisionId) {
    throw new MissionPlanValidationError(["The mission already has a selected plan."]);
  }
  const sizing = sizeMissionPlan(input.mission, input.draft);
  if (input.mission.executionDepth !== sizing.executionDepth) {
    throw new MissionPlanValidationError([
      `Mission execution depth ${input.mission.executionDepth} does not match generated plan sizing ${sizing.executionDepth}.`
    ]);
  }
  const metadata = metadataFor(input.mission, input.now);
  const { deletedAt: _deletedAt, ...immutableMetadata } = metadata;
  const currentRevision: PlanRevision = {
    ...immutableMetadata,
    id: input.revisionId,
    planId: input.planId,
    missionId: input.mission.id,
    planRevisionNumber: 1,
    reason: "initial",
    summary: input.draft.summary.trim(),
    bounds: input.draft.bounds,
    steps: input.draft.steps
  };
  const plan: MissionPlan = {
    ...metadata,
    id: input.planId,
    missionId: input.mission.id,
    status: "current",
    currentRevisionId: input.revisionId,
    currentRevisionNumber: 1
  };
  return {
    mission: selectPlan(input.mission, input.planId, input.revisionId, input.now),
    plan,
    currentRevision,
    sizing
  };
}

export function reviseMissionPlan(input: RevisePlanInput): MissionPlanLifecycle {
  if (input.plan.revision !== input.expectedPlanRevision) {
    throw new MissionPlanValidationError(["The plan changed before this revision could be selected."]);
  }
  if (
    input.plan.status !== "current" ||
    input.plan.missionId !== input.mission.id ||
    input.currentRevision.id !== input.plan.currentRevisionId ||
    input.currentRevision.planId !== input.plan.id
  ) {
    throw new MissionPlanValidationError(["The current mission, plan, and plan revision do not form one active lifecycle."]);
  }
  const nextNumber = input.currentRevision.planRevisionNumber + 1;
  const revisionLimit = input.draft.bounds.maxRevisions ?? input.currentRevision.bounds.maxRevisions ?? MAX_GENERATED_PLAN_REVISIONS;
  if (nextNumber > revisionLimit) throw new MissionPlanValidationError(["The generated plan revision limit has been reached."]);
  const sizing = sizeMissionPlan(input.mission, input.draft);
  if (input.mission.executionDepth !== sizing.executionDepth) {
    throw new MissionPlanValidationError(["A plan revision cannot silently change the mission execution depth."]);
  }
  const { deletedAt: _deletedAt, ...immutableMetadata } = metadataFor(input.mission, input.now);
  const currentRevision: PlanRevision = {
    ...immutableMetadata,
    id: input.revisionId,
    planId: input.plan.id,
    missionId: input.mission.id,
    planRevisionNumber: nextNumber,
    supersedesRevisionId: input.currentRevision.id,
    reason: input.reason,
    summary: input.draft.summary.trim(),
    bounds: input.draft.bounds,
    steps: input.draft.steps
  };
  const plan: MissionPlan = {
    ...input.plan,
    currentRevisionId: input.revisionId,
    currentRevisionNumber: nextNumber,
    revision: input.plan.revision + 1,
    updatedAt: input.now
  };
  return {
    mission: selectPlan(input.mission, input.plan.id, input.revisionId, input.now),
    plan,
    currentRevision,
    sizing
  };
}

function metadataFor(mission: Mission, now: string): Spine.Primitives.ScopedRecordMetadata {
  const { workspaceId, authority, schemaVersion, createdByInternalUserId, createdByDeviceId } = mission;
  const base = {
    workspaceId,
    authority,
    schemaVersion,
    revision: 1,
    createdByInternalUserId,
    ...(createdByDeviceId ? { createdByDeviceId } : {}),
    createdAt: now,
    updatedAt: now
  } as const;
  return mission.visibility === "member-private"
    ? { ...base, visibility: "member-private", ownerMemberId: mission.ownerMemberId }
    : { ...base, visibility: "workspace-shared" };
}

function selectPlan(mission: Mission, planId: PlanId, revisionId: PlanRevisionId, now: string): Mission {
  return {
    ...mission,
    status: "ready",
    currentPlanId: planId,
    currentPlanRevisionId: revisionId,
    revision: mission.revision + 1,
    updatedAt: now
  };
}

function assertValid(mission: Mission, draft: GeneratedPlanDraft): void {
  const issues = validateGeneratedPlan(mission, draft);
  if (issues.length) throw new MissionPlanValidationError(issues);
}

function calculateParallelWidth(steps: readonly PlanStep[]): number {
  if (steps.length === 0) return 0;
  const depth = new Map<string, number>();
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const visit = (key: string, visiting: Set<string>): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const step = byKey.get(key);
    const value = step ? 1 + Math.max(0, ...step.dependsOnStepKeys.map((dependency) => visit(dependency, visiting))) : 1;
    visiting.delete(key);
    depth.set(key, value);
    return value;
  };
  for (const step of steps) visit(step.key, new Set());
  const widths = new Map<number, number>();
  for (const value of depth.values()) widths.set(value, (widths.get(value) ?? 0) + 1);
  return Math.max(...widths.values());
}

function detectCycle(steps: readonly PlanStep[]): string | undefined {
  const graph = new Map(steps.map((step) => [step.key, step.dependsOnStepKeys]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return steps.some((step) => visit(step.key)) ? "Generated plan dependencies must be acyclic." : undefined;
}
