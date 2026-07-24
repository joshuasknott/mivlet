import type { Spine } from "@fable/protocol";

const MAX_COORDINATED_WORKERS = 32;

export type CoordinationWorkerState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DeclaredStepJoin {
  joinKey: string;
  targetStepKey: string;
  sourceStepKeys: readonly string[];
  strategy: Spine.Missions.JoinStrategy;
  quorum?: number;
  allowFailedWorkers: boolean;
  deadline?: string;
}

export interface DeclaredAggregation {
  stepKey: string;
  sourceStepKeys: readonly string[];
  strategy: "ordered-manifest-v1";
}

export interface CompileMissionCoordinationInput {
  mission: Spine.Missions.Mission;
  planRevision: Spine.Missions.PlanRevision;
  workers: readonly Spine.Missions.Worker[];
  joins: readonly DeclaredStepJoin[];
  aggregations?: readonly DeclaredAggregation[];
}

export interface MissionCoordinationGraph {
  workerByStepKey: ReadonlyMap<string, Spine.Missions.Worker>;
  joinByTargetStepKey: ReadonlyMap<string, DeclaredStepJoin>;
  aggregationByStepKey: ReadonlyMap<string, DeclaredAggregation>;
  dependenciesByStepKey: ReadonlyMap<string, readonly string[]>;
  orderedStepKeys: readonly string[];
  maxParallelWorkers: number;
}

export interface EvaluateMissionCoordinationInput {
  graph: MissionCoordinationGraph;
  workerStates: Readonly<Record<string, CoordinationWorkerState>>;
  completedAggregationStepKeys?: readonly string[];
}

export interface MissionCoordinationDecision {
  readyWorkerIds: readonly Spine.Primitives.WorkerId[];
  readyAggregationStepKeys: readonly string[];
  runningWorkerIds: readonly Spine.Primitives.WorkerId[];
  waitingStepKeys: readonly string[];
  blocked: readonly { stepKey: string; reason: string }[];
  complete: boolean;
}

export interface DeterministicAggregationInput {
  sourceStepKey: string;
  workerId: Spine.Primitives.WorkerId;
  status: Extract<CoordinationWorkerState, "completed" | "failed" | "cancelled">;
  outputs: readonly Spine.Missions.ProducedOutput[];
}

export interface DeterministicAggregationReceipt {
  version: 1;
  strategy: "ordered-manifest-v1";
  stepKey: string;
  status: "complete" | "partial";
  inputs: readonly DeterministicAggregationInput[];
  producedOutputs: readonly Spine.Missions.ProducedOutput[];
  missingRequiredOutputKeys: readonly string[];
}

export class MissionCoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionCoordinationError";
  }
}

/**
 * Compile a selected plan revision into a bounded, provider-neutral execution
 * graph. Dependencies with more than one source require an explicit join;
 * coordinate steps require an explicit deterministic aggregation declaration.
 */
export function compileMissionCoordination(
  input: CompileMissionCoordinationInput
): MissionCoordinationGraph {
  const { mission, planRevision } = input;
  if (
    planRevision.missionId !== mission.id ||
    mission.currentPlanRevisionId !== planRevision.id ||
    !sameScope(mission, planRevision)
  ) {
    throw new MissionCoordinationError(
      "Coordination requires the mission's exact selected plan revision and authority scope."
    );
  }
  const workerLimit = Math.min(
    mission.budget?.maxWorkers ?? 1,
    planRevision.bounds.maxSteps,
    MAX_COORDINATED_WORKERS
  );
  if (
    !Number.isInteger(workerLimit) ||
    workerLimit < 1 ||
    input.workers.length > workerLimit
  ) {
    throw new MissionCoordinationError(
      "Coordinated workers exceed the mission's bounded worker limit."
    );
  }

  const stepByKey = new Map(planRevision.steps.map((step) => [step.key, step]));
  const workerByStepKey = new Map<string, Spine.Missions.Worker>();
  const workerIds = new Set<string>();
  for (const worker of input.workers) {
    const stepKey = worker.planStepKey;
    if (
      !stepKey ||
      !stepByKey.has(stepKey) ||
      worker.runId === undefined ||
      worker.planRevisionId !== planRevision.id ||
      !sameScope(mission, worker) ||
      workerIds.has(worker.id) ||
      workerByStepKey.has(stepKey)
    ) {
      throw new MissionCoordinationError(
        "Every coordinated worker must uniquely bind one step in the exact selected plan."
      );
    }
    workerIds.add(worker.id);
    workerByStepKey.set(stepKey, worker);
  }

  const aggregationByStepKey = new Map<string, DeclaredAggregation>();
  for (const aggregation of input.aggregations ?? []) {
    const step = stepByKey.get(aggregation.stepKey);
    if (
      !step ||
      step.kind !== "coordinate" ||
      aggregation.strategy !== "ordered-manifest-v1" ||
      aggregationByStepKey.has(aggregation.stepKey) ||
      !sameOrderedKeys(aggregation.sourceStepKeys, step.dependsOnStepKeys)
    ) {
      throw new MissionCoordinationError(
        "A deterministic aggregation must uniquely bind a coordinate step and its exact ordered dependencies."
      );
    }
    aggregationByStepKey.set(aggregation.stepKey, aggregation);
  }

  for (const step of planRevision.steps) {
    const hasWorker = workerByStepKey.has(step.key);
    const hasAggregation = aggregationByStepKey.has(step.key);
    if (step.kind === "coordinate" ? hasWorker === hasAggregation : !hasWorker || hasAggregation) {
      throw new MissionCoordinationError(
        "Each plan step must have exactly one worker, except an explicitly deterministic coordinate step."
      );
    }
  }

  const joinByTargetStepKey = new Map<string, DeclaredStepJoin>();
  const joinKeys = new Set<string>();
  for (const join of input.joins) {
    const step = stepByKey.get(join.targetStepKey);
    if (
      !step ||
      step.dependsOnStepKeys.length < 2 ||
      !join.joinKey.trim() ||
      joinKeys.has(join.joinKey) ||
      joinByTargetStepKey.has(join.targetStepKey) ||
      !sameOrderedKeys(join.sourceStepKeys, step.dependsOnStepKeys) ||
      (join.deadline !== undefined && !Number.isFinite(Date.parse(join.deadline)))
    ) {
      throw new MissionCoordinationError(
        "A declared join must uniquely bind a multi-dependency step and its exact ordered sources."
      );
    }
    if (
      join.strategy === "quorum"
        ? !Number.isInteger(join.quorum) ||
          join.quorum! < 1 ||
          join.quorum! > join.sourceStepKeys.length
        : join.quorum !== undefined
    ) {
      throw new MissionCoordinationError("The declared join quorum is invalid.");
    }
    joinKeys.add(join.joinKey);
    joinByTargetStepKey.set(join.targetStepKey, join);
  }
  for (const step of planRevision.steps) {
    if (step.dependsOnStepKeys.length > 1 && !joinByTargetStepKey.has(step.key)) {
      throw new MissionCoordinationError(
        `Plan step ${step.key} requires an explicit dependency join.`
      );
    }
  }

  return {
    workerByStepKey,
    joinByTargetStepKey,
    aggregationByStepKey,
    dependenciesByStepKey: new Map(
      planRevision.steps.map((step) => [step.key, [...step.dependsOnStepKeys]])
    ),
    orderedStepKeys: planRevision.steps.map((step) => step.key),
    maxParallelWorkers: Math.min(planRevision.bounds.maxParallelSteps, workerLimit)
  };
}

/** Derive the next runnable work from current durable worker/aggregation facts. */
export function evaluateMissionCoordination(
  input: EvaluateMissionCoordinationInput
): MissionCoordinationDecision {
  const completedAggregations = new Set(input.completedAggregationStepKeys ?? []);
  const stateByStep = new Map<string, CoordinationWorkerState>();
  for (const stepKey of input.graph.orderedStepKeys) {
    const aggregation = input.graph.aggregationByStepKey.get(stepKey);
    if (aggregation) {
      stateByStep.set(stepKey, completedAggregations.has(stepKey) ? "completed" : "pending");
      continue;
    }
    const worker = input.graph.workerByStepKey.get(stepKey)!;
    const state = input.workerStates[worker.id];
    if (!state) {
      throw new MissionCoordinationError(
        `Worker ${worker.id} has no durable coordination state.`
      );
    }
    stateByStep.set(stepKey, state);
  }

  const readyWorkerIds: Spine.Primitives.WorkerId[] = [];
  const readyAggregationStepKeys: string[] = [];
  const runningWorkerIds: Spine.Primitives.WorkerId[] = [];
  const waitingStepKeys: string[] = [];
  const blocked: { stepKey: string; reason: string }[] = [];

  for (const stepKey of input.graph.orderedStepKeys) {
    const state = stateByStep.get(stepKey)!;
    const worker = input.graph.workerByStepKey.get(stepKey);
    if (state === "running" && worker) {
      runningWorkerIds.push(worker.id);
      continue;
    }
    if (state !== "pending") continue;
    const gate = dependencyGate(input.graph, stepKey, stateByStep);
    if (gate === "ready") {
      if (worker) readyWorkerIds.push(worker.id);
      else readyAggregationStepKeys.push(stepKey);
    } else if (gate === "waiting") {
      waitingStepKeys.push(stepKey);
    } else {
      blocked.push({
        stepKey,
        reason: "Its declared dependencies cannot satisfy the required join."
      });
    }
  }

  const availableSlots = Math.max(
    0,
    input.graph.maxParallelWorkers - runningWorkerIds.length
  );
  if (readyWorkerIds.length > availableSlots) {
    const deferredWorkerIds = readyWorkerIds.slice(availableSlots);
    waitingStepKeys.push(
      ...input.graph.orderedStepKeys.filter((stepKey) => {
        const worker = input.graph.workerByStepKey.get(stepKey);
        return worker !== undefined && deferredWorkerIds.includes(worker.id);
      })
    );
    readyWorkerIds.splice(availableSlots);
  }

  const allTerminal = [...stateByStep.values()].every((state) =>
    ["completed", "failed", "cancelled"].includes(state)
  );
  return {
    readyWorkerIds,
    readyAggregationStepKeys,
    runningWorkerIds,
    waitingStepKeys,
    blocked,
    complete: allTerminal && blocked.length === 0
  };
}

/**
 * Produce a stable aggregation manifest. This combines only authenticated
 * references and never treats worker prose as policy or acceptance authority.
 */
export function aggregateMissionOutputs(
  graph: MissionCoordinationGraph,
  stepKey: string,
  inputs: readonly DeterministicAggregationInput[]
): DeterministicAggregationReceipt {
  const aggregation = graph.aggregationByStepKey.get(stepKey);
  if (!aggregation) {
    throw new MissionCoordinationError("The requested deterministic aggregation is unavailable.");
  }
  const inputByStep = new Map(inputs.map((input) => [input.sourceStepKey, input]));
  if (
    inputByStep.size !== inputs.length ||
    inputs.some((input) => {
      const worker = graph.workerByStepKey.get(input.sourceStepKey);
      return !worker || worker.id !== input.workerId;
    })
  ) {
    throw new MissionCoordinationError(
      "Aggregation inputs must uniquely match the graph's exact source workers."
    );
  }
  const orderedInputs = aggregation.sourceStepKeys
    .map((sourceStepKey) => inputByStep.get(sourceStepKey))
    .filter((value): value is DeterministicAggregationInput => value !== undefined);
  if (orderedInputs.length !== aggregation.sourceStepKeys.length) {
    throw new MissionCoordinationError("Deterministic aggregation is missing a declared source.");
  }
  const outputKeys = new Set<string>();
  const producedOutputs = orderedInputs.flatMap((input) => {
    const declared = new Set(
      graph.workerByStepKey
        .get(input.sourceStepKey)!
        .outputContract.slots.map((slot) => slot.key)
    );
    for (const output of input.outputs) {
      if (!declared.has(output.key) || outputKeys.has(output.key)) {
        throw new MissionCoordinationError(
          "Aggregation outputs must be unique and declared by their exact source worker."
        );
      }
      outputKeys.add(output.key);
    }
    return [...input.outputs];
  });
  const requiredKeys = new Set(
    orderedInputs.flatMap((input) =>
      graph.workerByStepKey
        .get(input.sourceStepKey)!
        .outputContract.slots.filter((slot) => slot.required)
        .map((slot) => slot.key)
    )
  );
  for (const output of producedOutputs) requiredKeys.delete(output.key);
  return {
    version: 1,
    strategy: "ordered-manifest-v1",
    stepKey,
    status:
      orderedInputs.every((input) => input.status === "completed") && requiredKeys.size === 0
        ? "complete"
        : "partial",
    inputs: orderedInputs,
    producedOutputs,
    missingRequiredOutputKeys: [...requiredKeys].sort()
  };
}

function dependencyGate(
  graph: MissionCoordinationGraph,
  stepKey: string,
  stateByStep: ReadonlyMap<string, CoordinationWorkerState>
): "ready" | "waiting" | "blocked" {
  const join = graph.joinByTargetStepKey.get(stepKey);
  const sources = join?.sourceStepKeys ?? dependenciesFor(graph, stepKey);
  if (sources.length === 0) return "ready";
  const states = sources.map((source) => stateByStep.get(source)!);
  const completed = states.filter((state) => state === "completed").length;
  const failed = states.filter((state) => state === "failed" || state === "cancelled").length;
  const terminal = completed + failed;
  if (!join) {
    if (completed === 1) return "ready";
    return failed === 1 ? "blocked" : "waiting";
  }
  const accepted = completed + (join.allowFailedWorkers ? failed : 0);
  const target =
    join.strategy === "all"
      ? states.length
      : join.strategy === "any"
        ? 1
        : join.quorum!;
  if (accepted >= target && (join.allowFailedWorkers || failed === 0)) return "ready";
  const possible = accepted + (states.length - terminal);
  if ((!join.allowFailedWorkers && failed > 0) || possible < target) return "blocked";
  return "waiting";
}

function dependenciesFor(graph: MissionCoordinationGraph, targetStepKey: string): readonly string[] {
  return graph.dependenciesByStepKey.get(targetStepKey) ?? [];
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index]) &&
    new Set(left).size === left.length
  );
}

function sameScope(
  left: Pick<
    Spine.Primitives.ScopedRecordMetadata,
    "workspaceId" | "authority" | "schemaVersion" | "visibility" | "ownerMemberId"
  >,
  right: Pick<
    Spine.Primitives.ScopedRecordMetadata,
    "workspaceId" | "authority" | "schemaVersion" | "visibility" | "ownerMemberId"
  >
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.authority === right.authority &&
    left.schemaVersion === right.schemaVersion &&
    left.visibility === right.visibility &&
    (left.visibility !== "member-private" ||
      (right.visibility === "member-private" &&
        left.ownerMemberId === right.ownerMemberId))
  );
}
