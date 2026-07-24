import type { Spine } from "@fable/protocol";
import {
  aggregateMissionOutputs,
  type MissionCoordinationGraph
} from "./coordination";

export interface MissionWorkerResult {
  workerId: Spine.Primitives.WorkerId;
  result: Spine.Missions.RunResult;
}

export type MissionOutputSource =
  | {
      kind: "worker";
      workerId: Spine.Primitives.WorkerId;
      outputKey: string;
    }
  | {
      kind: "aggregation";
      stepKey: string;
      outputKey: string;
    };

export interface MissionOutputSelection {
  deliverableKey: string;
  source: MissionOutputSource;
}

export interface FinalizeMissionGraphResultInput {
  mission: Spine.Missions.Mission;
  graph: MissionCoordinationGraph;
  workerResults: readonly MissionWorkerResult[];
  aggregationReceipts?: readonly Spine.Missions.DeterministicAggregationReceipt[];
  outputSelections: readonly MissionOutputSelection[];
  completedAt: string;
}

export class MissionResultAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionResultAggregationError";
  }
}

/**
 * Derive one terminal Mission result from exact durable worker results and
 * deterministic aggregation receipts. Output presence and typed evaluator
 * evidence determine acceptance; model completion alone never does.
 */
export function finalizeMissionGraphResult(
  input: FinalizeMissionGraphResultInput
): Spine.Missions.MissionResult {
  validateMissionGraph(input.mission, input.graph);
  const workers = new Map(
    [...input.graph.workerByStepKey.values()].map((worker) => [worker.id, worker])
  );
  const resultByWorker = validateWorkerResults(workers, input.workerResults);
  const aggregationByStep = validateAggregations(
    input.graph,
    resultByWorker,
    input.aggregationReceipts ?? []
  );
  const outputs = selectOutputs(
    input.mission,
    workers,
    resultByWorker,
    aggregationByStep,
    input.outputSelections
  );
  const evaluations = validateEvaluations(
    input.mission,
    workers,
    input.workerResults.flatMap(({ result }) => result.evaluations)
  );
  const acceptance = input.mission.acceptance.criteria.map((criterion) =>
    assessCriterion(criterion, evaluations)
  );
  const requiredDeliverables = input.mission.outcome.deliverables.filter(
    (deliverable) => deliverable.required
  );
  const missingDeliverables = requiredDeliverables.filter(
    (deliverable) => !outputs.some((output) => output.key === deliverable.key)
  );
  const incompleteCriteria = input.mission.acceptance.criteria.filter(
    (criterion) =>
      !acceptance.some(
        (result) =>
          result.criterionKey === criterion.key && result.status === "met"
      )
  );
  const acceptanceMet = missionAcceptanceMet(
    input.mission,
    acceptance
  );
  const hasSuccessfulWorker = input.workerResults.some(
    ({ result }) => result.outcome === "succeeded"
  );
  const requiredSourcesComplete = requiredDeliverables.every((deliverable) => {
    const selection = input.outputSelections.find(
      (candidate) => candidate.deliverableKey === deliverable.key
    );
    if (!selection) return false;
    if (selection.source.kind === "worker") {
      return resultByWorker.get(selection.source.workerId)?.outcome === "succeeded";
    }
    const receipt = aggregationByStep.get(selection.source.stepKey);
    return (
      receipt?.status === "complete" &&
      receipt.inputs.every(
        (receiptInput) =>
          resultByWorker.get(receiptInput.workerId)?.outcome === "succeeded"
      )
    );
  });
  const succeeded =
    hasSuccessfulWorker &&
    requiredSourcesComplete &&
    missingDeliverables.length === 0 &&
    acceptanceMet;
  const allCancelled = input.workerResults.every(
    ({ result }) => result.outcome === "cancelled"
  );
  const hasUsefulWork = outputs.length > 0;
  const outcome: Spine.Missions.RunOutcomeKind = succeeded
    ? "succeeded"
    : allCancelled
      ? "cancelled"
      : hasUsefulWork
        ? "partial"
        : "failed";
  const retryable = input.workerResults.some(
    ({ result }) => result.error?.retryable === true
  );
  const humanAccepted =
    !input.mission.acceptance.requiresHumanAcceptance ||
    input.mission.acceptance.criteria.some(
      (criterion) =>
        criterion.evaluator === "human" &&
        acceptance.some(
          (result) =>
            result.criterionKey === criterion.key && result.status === "met"
        )
    );
  const partial =
    succeeded || !hasUsefulWork
      ? undefined
      : {
          summary:
            outcome === "cancelled"
              ? "The mission was cancelled; exact completed outputs were preserved."
              : "Useful work was preserved, but the mission acceptance bar is not complete.",
          completedOutputs: outputs,
          remainingWork: unique([
            ...missingDeliverables.map(
              (deliverable) => `Produce ${deliverable.description}`
            ),
            ...incompleteCriteria.map(
              (criterion) =>
                `Meet acceptance criterion: ${criterion.description}`
            ),
            ...(!humanAccepted
              ? ["Obtain the required human acceptance."]
              : [])
          ]),
          acceptance,
          recoverable:
            outcome !== "cancelled" ||
            retryable ||
            missingDeliverables.length > 0 ||
            incompleteCriteria.length > 0,
          recommendedNextAction: recommendNextAction({
            outcome,
            retryable,
            humanAccepted,
            missingDeliverables: missingDeliverables.length,
            incompleteCriteria
          })
        } satisfies Spine.Missions.PartialOutcome;

  return {
    outcome,
    summary:
      outcome === "succeeded"
        ? "The mission completed its declared deliverables and acceptance criteria."
        : outcome === "cancelled"
          ? "The mission was cancelled before its acceptance bar was complete."
          : outcome === "partial"
            ? "The mission preserved useful work but did not meet its full acceptance bar."
            : "The mission ended without a declared deliverable that met its acceptance bar.",
    producingRunIds: uniqueIds(
      [...workers.values()].map((worker) => worker.runId)
    ),
    outputs,
    acceptance,
    ...(partial ? { partial } : {}),
    completedAt: bounded(input.completedAt, "Completion time", 100)
  };
}

function validateMissionGraph(
  mission: Spine.Missions.Mission,
  graph: MissionCoordinationGraph
): void {
  if (
    graph.missionId !== mission.id ||
    graph.planRevisionId !== mission.currentPlanRevisionId
  ) {
    throw new MissionResultAggregationError(
      "Mission aggregation requires the exact selected mission graph."
    );
  }
  if (
    [...graph.workerByStepKey.values()].some(
      (worker) =>
        worker.workspaceId !== mission.workspaceId ||
        worker.authority !== mission.authority ||
        worker.visibility !== mission.visibility ||
        (mission.visibility === "member-private" &&
          (worker.visibility !== "member-private" ||
            worker.ownerMemberId !== mission.ownerMemberId))
    )
  ) {
    throw new MissionResultAggregationError(
      "Mission aggregation workers must retain the mission's exact authority scope."
    );
  }
}

function validateWorkerResults(
  workers: ReadonlyMap<Spine.Primitives.WorkerId, Spine.Missions.Worker>,
  values: readonly MissionWorkerResult[]
): ReadonlyMap<Spine.Primitives.WorkerId, Spine.Missions.RunResult> {
  const resultByWorker = new Map<
    Spine.Primitives.WorkerId,
    Spine.Missions.RunResult
  >();
  const usageKeys = new Set<string>();
  for (const value of values) {
    const worker = workers.get(value.workerId);
    if (!worker || resultByWorker.has(value.workerId)) {
      throw new MissionResultAggregationError(
        "Worker results must uniquely match every worker in the compiled graph."
      );
    }
    const outputKeys = new Set<string>();
    const declaredOutputKeys = new Set(
      worker.outputContract.slots.map((slot) => slot.key)
    );
    for (const output of value.result.outputs) {
      if (
        !declaredOutputKeys.has(output.key) ||
        outputKeys.has(output.key) ||
        !output.summary.trim()
      ) {
        throw new MissionResultAggregationError(
          "Worker result outputs must be unique and match the exact worker contract."
        );
      }
      outputKeys.add(output.key);
    }
    for (const usage of value.result.usage) {
      if (
        usage.runId !== worker.runId ||
        (usage.workerId !== undefined && usage.workerId !== worker.id) ||
        !usage.usageKey.trim() ||
        usageKeys.has(usage.usageKey)
      ) {
        throw new MissionResultAggregationError(
          "Mission usage must uniquely match its exact worker and run."
        );
      }
      usageKeys.add(usage.usageKey);
    }
    resultByWorker.set(value.workerId, value.result);
  }
  if (resultByWorker.size !== workers.size) {
    throw new MissionResultAggregationError(
      "Terminal mission aggregation requires one durable result for every graph worker."
    );
  }
  return resultByWorker;
}

function validateAggregations(
  graph: MissionCoordinationGraph,
  results: ReadonlyMap<
    Spine.Primitives.WorkerId,
    Spine.Missions.RunResult
  >,
  values: readonly Spine.Missions.DeterministicAggregationReceipt[]
): ReadonlyMap<string, Spine.Missions.DeterministicAggregationReceipt> {
  const byStep = new Map<
    string,
    Spine.Missions.DeterministicAggregationReceipt
  >();
  for (const receipt of values) {
    if (byStep.has(receipt.stepKey)) {
      throw new MissionResultAggregationError(
        "Aggregation receipts must uniquely bind one coordinate step."
      );
    }
    for (const receiptInput of receipt.inputs) {
      const result = results.get(receiptInput.workerId);
      const expectedStatus =
        result?.outcome === "failed"
          ? "failed"
          : result?.outcome === "cancelled"
            ? "cancelled"
            : result
              ? "completed"
              : undefined;
      if (
        !result ||
        receiptInput.status !== expectedStatus ||
        JSON.stringify(receiptInput.outputs) !== JSON.stringify(result.outputs)
      ) {
        throw new MissionResultAggregationError(
          "Mission aggregation inputs must match the exact durable worker results."
        );
      }
    }
    let expected: Spine.Missions.DeterministicAggregationReceipt;
    try {
      expected = aggregateMissionOutputs(
        graph,
        receipt.stepKey,
        receipt.inputs
      );
    } catch (error) {
      throw new MissionResultAggregationError(
        error instanceof Error
          ? error.message
          : "Mission aggregation receipt is invalid."
      );
    }
    if (JSON.stringify(expected) !== JSON.stringify(receipt)) {
      throw new MissionResultAggregationError(
        "Mission aggregation receipt does not match its deterministic inputs."
      );
    }
    byStep.set(receipt.stepKey, receipt);
  }
  return byStep;
}

function selectOutputs(
  mission: Spine.Missions.Mission,
  workers: ReadonlyMap<Spine.Primitives.WorkerId, Spine.Missions.Worker>,
  results: ReadonlyMap<Spine.Primitives.WorkerId, Spine.Missions.RunResult>,
  aggregations: ReadonlyMap<
    string,
    Spine.Missions.DeterministicAggregationReceipt
  >,
  selections: readonly MissionOutputSelection[]
): readonly Spine.Missions.ProducedOutput[] {
  const deliverables = new Map(
    mission.outcome.deliverables.map((deliverable) => [
      deliverable.key,
      deliverable
    ])
  );
  const selectedDeliverables = new Set<string>();
  const selectedSources = new Set<string>();
  return selections.map((selection) => {
    if (
      !deliverables.has(selection.deliverableKey) ||
      selectedDeliverables.has(selection.deliverableKey)
    ) {
      throw new MissionResultAggregationError(
        "Mission outputs must uniquely bind declared deliverables."
      );
    }
    const sourceKey =
      selection.source.kind === "worker"
        ? `worker:${selection.source.workerId}:${selection.source.outputKey}`
        : `aggregation:${selection.source.stepKey}:${selection.source.outputKey}`;
    if (selectedSources.has(sourceKey)) {
      throw new MissionResultAggregationError(
        "One durable output cannot satisfy multiple mission deliverables."
      );
    }
    let source: Spine.Missions.ProducedOutput | undefined;
    if (selection.source.kind === "worker") {
      if (!workers.has(selection.source.workerId)) {
        throw new MissionResultAggregationError(
          "A mission output selection references an unknown worker."
        );
      }
      source = results
        .get(selection.source.workerId)
        ?.outputs.find(
          (output) => output.key === selection.source.outputKey
        );
    } else {
      source = aggregations
        .get(selection.source.stepKey)
        ?.producedOutputs.find(
          (output) => output.key === selection.source.outputKey
        );
    }
    if (!source) {
      throw new MissionResultAggregationError(
        "A mission output selection lacks its exact durable source."
      );
    }
    selectedDeliverables.add(selection.deliverableKey);
    selectedSources.add(sourceKey);
    return { ...source, key: selection.deliverableKey };
  });
}

function validateEvaluations(
  mission: Spine.Missions.Mission,
  workers: ReadonlyMap<Spine.Primitives.WorkerId, Spine.Missions.Worker>,
  values: readonly Spine.Missions.EvaluationResult[]
): readonly Spine.Missions.EvaluationResult[] {
  const evaluationKeys = new Set<string>();
  const criteria = new Map(
    mission.acceptance.criteria.map((criterion) => [
      criterion.key,
      criterion
    ])
  );
  const runIds = new Set([...workers.values()].map((worker) => worker.runId));
  for (const evaluation of values) {
    if (
      !evaluation.evaluationKey.trim() ||
      evaluationKeys.has(evaluation.evaluationKey)
    ) {
      throw new MissionResultAggregationError(
        "Evaluation keys must be explicit and unique across the mission."
      );
    }
    evaluationKeys.add(evaluation.evaluationKey);
    if (
      !(
        (evaluation.target.kind === "worker" &&
          workers.has(evaluation.target.workerId)) ||
        (evaluation.target.kind === "run" &&
          runIds.has(evaluation.target.runId))
      )
    ) {
      throw new MissionResultAggregationError(
        "Mission evaluation must target an exact graph worker or producing run."
      );
    }
    if (
      new Set(
        evaluation.criteria.map((result) => result.criterionKey)
      ).size !== evaluation.criteria.length
    ) {
      throw new MissionResultAggregationError(
        "One evaluation cannot repeat an acceptance criterion."
      );
    }
    for (const result of evaluation.criteria) {
      const criterion = criteria.get(result.criterionKey);
      if (!criterion) {
        throw new MissionResultAggregationError(
          "Evaluation references an unknown mission acceptance criterion."
        );
      }
      if (
        criterion.evaluator === "human" &&
        !evaluation.reviewerInternalUserId
      ) {
        throw new MissionResultAggregationError(
          "Human acceptance requires an identified internal reviewer."
        );
      }
      if (
        criterion.evaluator === "worker" &&
        (!evaluation.reviewerWorkerId ||
          !workers.has(evaluation.reviewerWorkerId))
      ) {
        throw new MissionResultAggregationError(
          "Worker acceptance requires an exact reviewer from the mission graph."
        );
      }
      if (criterion.evaluator === "external") {
        throw new MissionResultAggregationError(
          "External acceptance requires an attested evaluator boundary."
        );
      }
    }
  }
  return [...values];
}

function assessCriterion(
  criterion: Spine.Missions.AcceptanceCriterion,
  evaluations: readonly Spine.Missions.EvaluationResult[]
): Spine.Missions.AcceptanceResult {
  const results = evaluations
    .flatMap((evaluation) => evaluation.criteria)
    .filter((result) => result.criterionKey === criterion.key);
  const evidence = unique(
    results.flatMap((result) => [...result.evidenceRefs])
  );
  const hasPass = results.some((result) => result.passed === true);
  const hasFail = results.some((result) => result.passed === false);
  const hasRequiredEvidence = (criterion.evidenceRequired ?? []).every(
    (reference) => evidence.includes(reference)
  );
  const status: Spine.Missions.AcceptanceResult["status"] =
    hasPass && hasFail
      ? "partially-met"
      : hasFail
        ? "not-met"
        : hasPass && hasRequiredEvidence
          ? "met"
          : hasPass
            ? "partially-met"
            : "not-evaluated";
  return {
    criterionKey: criterion.key,
    status,
    evidenceRefs: evidence,
    summary:
      status === "partially-met" && !hasRequiredEvidence
        ? "An evaluator passed this criterion, but required evidence is missing."
        : results
            .map((result) => result.summary)
            .filter(Boolean)
            .join(" ") || undefined
  };
}

function missionAcceptanceMet(
  mission: Spine.Missions.Mission,
  acceptance: readonly Spine.Missions.AcceptanceResult[]
): boolean {
  const required = mission.acceptance.criteria.filter(
    (criterion) => criterion.required
  );
  const minimum =
    mission.acceptance.minimumRequiredCriteria ?? required.length;
  if (
    !Number.isInteger(minimum) ||
    minimum < 0 ||
    minimum > mission.acceptance.criteria.length
  ) {
    throw new MissionResultAggregationError(
      "Mission minimum acceptance count is invalid."
    );
  }
  const met = new Set(
    acceptance
      .filter((result) => result.status === "met")
      .map((result) => result.criterionKey)
  );
  const requiredMet = required.every((criterion) => met.has(criterion.key));
  const humanAccepted =
    !mission.acceptance.requiresHumanAcceptance ||
    mission.acceptance.criteria.some(
      (criterion) =>
        criterion.evaluator === "human" && met.has(criterion.key)
    );
  return requiredMet && met.size >= minimum && humanAccepted;
}

function recommendNextAction(input: {
  outcome: Spine.Missions.RunOutcomeKind;
  retryable: boolean;
  humanAccepted: boolean;
  missingDeliverables: number;
  incompleteCriteria: readonly Spine.Missions.AcceptanceCriterion[];
}): NonNullable<Spine.Missions.PartialOutcome["recommendedNextAction"]> {
  if (
    !input.humanAccepted ||
    input.incompleteCriteria.some(
      (criterion) => criterion.evaluator === "human"
    )
  ) {
    return "human-review";
  }
  if (input.retryable) return "retry";
  if (input.missingDeliverables > 0) return "resume";
  if (
    input.incompleteCriteria.some(
      (criterion) => criterion.evaluator === "worker"
    )
  ) {
    return "revise-plan";
  }
  return "stop";
}

function bounded(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new MissionResultAggregationError(`${label} is invalid.`);
  }
  return trimmed;
}

function unique(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
}

function uniqueIds<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
