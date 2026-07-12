import type { Spine } from "@fable/protocol";
import type { LocalWorkerExecutionOutcome } from "./local-driver";

type Mission = Spine.Missions.Mission;
type Worker = Spine.Missions.Worker;
type ProducedOutput = Spine.Missions.ProducedOutput;
type EvaluationResult = Spine.Missions.EvaluationResult;
type AcceptanceResult = Spine.Missions.AcceptanceResult;
type RunResult = Spine.Missions.RunResult;

export interface FinalizeLocalWorkerResultInput {
  mission: Mission;
  worker: Worker;
  execution: LocalWorkerExecutionOutcome;
  outputs: readonly ProducedOutput[];
  evaluations: readonly EvaluationResult[];
  usageKey: string;
  completedAt: string;
  modelReference?: string;
}

export class MissionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionEvaluationError";
  }
}

/**
 * Convert one bounded local execution into a portable run result without
 * treating backend completion as proof that the mission's acceptance bar was met.
 */
export function finalizeLocalWorkerResult(input: FinalizeLocalWorkerResultInput): RunResult {
  validateScope(input.mission, input.worker);
  validateUsage(input.execution);
  const outputs = validateOutputs(input.mission, input.outputs);
  const evaluations = validateEvaluations(input.worker, input.mission, input.evaluations);
  const acceptance = input.mission.acceptance.criteria.map((criterion) =>
    assessCriterion(criterion, evaluations)
  );
  const missingDeliverables = input.mission.outcome.deliverables.filter(
    (deliverable) => deliverable.required && !outputs.some((output) => output.key === deliverable.key)
  );
  const requiredCriteria = input.mission.acceptance.criteria.filter((criterion) => criterion.required);
  const requiredMet = requiredCriteria.filter((criterion) =>
    acceptance.some((result) => result.criterionKey === criterion.key && result.status === "met")
  ).length;
  const minimum = input.mission.acceptance.minimumRequiredCriteria ?? requiredCriteria.length;
  if (!Number.isInteger(minimum) || minimum < 0 || minimum > input.mission.acceptance.criteria.length) {
    throw new MissionEvaluationError("Mission minimum acceptance count is invalid.");
  }
  const allRequiredMet = requiredMet === requiredCriteria.length &&
    acceptance.filter((result) => result.status === "met").length >= minimum;
  const humanAccepted = !input.mission.acceptance.requiresHumanAcceptance ||
    input.mission.acceptance.criteria.some((criterion) => criterion.evaluator === "human" &&
      acceptance.some((result) => result.criterionKey === criterion.key && result.status === "met"));
  const succeeded = input.execution.status === "completed" && missingDeliverables.length === 0 &&
    allRequiredMet && humanAccepted;
  const hasUsefulWork = outputs.length > 0 || input.execution.text.trim().length > 0;
  const outcome: RunResult["outcome"] = succeeded
    ? "succeeded"
    : input.execution.status === "cancelled"
      ? "cancelled"
      : hasUsefulWork
        ? "partial"
        : "failed";
  const incompleteCriteria = input.mission.acceptance.criteria.filter((criterion) =>
    !acceptance.some((result) => result.criterionKey === criterion.key && result.status === "met")
  );
  const remainingWork = [
    ...missingDeliverables.map((item) => `Produce ${item.description}`),
    ...incompleteCriteria.map((item) => `Meet acceptance criterion: ${item.description}`),
    ...(!humanAccepted ? ["Obtain the required human acceptance."] : []),
    ...(input.execution.reason ? [input.execution.reason] : [])
  ];
  const partial = outcome === "succeeded" || (!hasUsefulWork && outcome === "failed")
    ? undefined
    : {
        summary: input.execution.reason ?? "Useful work was preserved, but the mission acceptance bar is not complete.",
        completedOutputs: outputs,
        remainingWork: unique(remainingWork),
        acceptance,
        recoverable: input.execution.retryable || incompleteCriteria.length > 0 || missingDeliverables.length > 0,
        recommendedNextAction: recommendation(input.execution, humanAccepted, missingDeliverables.length, incompleteCriteria)
      } satisfies Spine.Missions.PartialOutcome;
  return {
    outcome,
    summary: succeeded
      ? "The worker completed its declared outputs and acceptance criteria."
      : input.execution.reason ?? "The worker stopped before the mission acceptance bar was complete.",
    outputs,
    acceptance,
    evaluations,
    usage: [{
      usageKey: bounded(input.usageKey, "Usage key", 200),
      runId: input.worker.runId,
      workerId: input.worker.id,
      ...(input.modelReference ? { modelReference: bounded(input.modelReference, "Model reference", 300) } : {}),
      inputTokens: input.execution.usage.inputTokens,
      outputTokens: input.execution.usage.outputTokens,
      toolCalls: input.execution.usage.toolCalls,
      costs: input.execution.usage.costUnknown
        ? [{ amount: { amount: decimal(input.execution.usage.costUsd), currencyCode: "USD" }, provenance: "unknown" }]
        : [{ amount: { amount: decimal(input.execution.usage.costUsd), currencyCode: "USD" }, provenance: "provider-reported" }],
      measuredAt: input.completedAt
    }],
    ...(partial ? { partial } : {}),
    ...(!succeeded && input.execution.reason ? { error: {
      code: input.execution.status === "cancelled" ? "cancelled" : "worker-incomplete",
      category: input.execution.status === "cancelled"
        ? "cancelled"
        : input.execution.reason.toLowerCase().includes("budget") || input.execution.reason.toLowerCase().includes("limit")
          ? "budget-exceeded"
          : "provider",
      message: bounded(input.execution.reason, "Worker error", 2_000),
      retryable: input.execution.retryable
    } } : {}),
    completedAt: input.completedAt
  };
}

function assessCriterion(
  criterion: Spine.Missions.AcceptanceCriterion,
  evaluations: readonly EvaluationResult[]
): AcceptanceResult {
  const results = evaluations.flatMap((evaluation) => evaluation.criteria)
    .filter((result) => result.criterionKey === criterion.key);
  const evidence = unique(results.flatMap((result) => [...result.evidenceRefs]));
  const hasPass = results.some((result) => result.passed === true);
  const hasFail = results.some((result) => result.passed === false);
  const hasRequiredEvidence = (criterion.evidenceRequired ?? []).every((reference) => evidence.includes(reference));
  const status: AcceptanceResult["status"] = hasPass && hasFail
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
    summary: status === "partially-met" && !hasRequiredEvidence
      ? "The evaluator passed this criterion, but required evidence is missing."
      : results.map((result) => result.summary).filter(Boolean).join(" ") || undefined
  };
}

function validateEvaluations(worker: Worker, mission: Mission, values: readonly EvaluationResult[]): readonly EvaluationResult[] {
  const keys = new Set<string>();
  const criteria = new Map(mission.acceptance.criteria.map((criterion) => [criterion.key, criterion]));
  for (const evaluation of values) {
    if (!evaluation.evaluationKey.trim() || keys.has(evaluation.evaluationKey)) {
      throw new MissionEvaluationError("Evaluation keys must be explicit and unique.");
    }
    keys.add(evaluation.evaluationKey);
    if (!((evaluation.target.kind === "run" && evaluation.target.runId === worker.runId) ||
      (evaluation.target.kind === "worker" && evaluation.target.workerId === worker.id))) {
      throw new MissionEvaluationError("Evaluation target must match the completed worker or its run.");
    }
    for (const result of evaluation.criteria) {
      const criterion = criteria.get(result.criterionKey);
      if (!criterion) throw new MissionEvaluationError("Evaluation references an unknown acceptance criterion.");
      if (criterion.evaluator === "human" && !evaluation.reviewerInternalUserId) {
        throw new MissionEvaluationError("Human acceptance requires an identified internal reviewer.");
      }
      if (criterion.evaluator === "worker" && !evaluation.reviewerWorkerId) {
        throw new MissionEvaluationError("Worker evaluation requires an identified reviewer worker.");
      }
      if (criterion.evaluator === "external") {
        throw new MissionEvaluationError("External acceptance requires a future attested evaluator boundary.");
      }
    }
    if (new Set(evaluation.criteria.map((result) => result.criterionKey)).size !== evaluation.criteria.length) {
      throw new MissionEvaluationError("One evaluation cannot repeat an acceptance criterion.");
    }
  }
  return [...values];
}

function validateOutputs(mission: Mission, values: readonly ProducedOutput[]): readonly ProducedOutput[] {
  const declared = new Set(mission.outcome.deliverables.map((item) => item.key));
  const keys = new Set<string>();
  for (const output of values) {
    if (!declared.has(output.key) || keys.has(output.key) || !output.summary.trim()) {
      throw new MissionEvaluationError("Worker outputs must be unique declared deliverables with a summary.");
    }
    keys.add(output.key);
  }
  return [...values];
}

function validateScope(mission: Mission, worker: Worker): void {
  if (mission.workspaceId !== worker.workspaceId || mission.authority !== worker.authority ||
    mission.visibility !== worker.visibility || (mission.visibility === "member-private" &&
      (worker.visibility !== "member-private" || mission.ownerMemberId !== worker.ownerMemberId))) {
    throw new MissionEvaluationError("Mission and worker must share one authority scope.");
  }
}

function validateUsage(execution: LocalWorkerExecutionOutcome): void {
  const counts = [execution.usage.inputTokens, execution.usage.outputTokens, execution.usage.toolCalls];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new MissionEvaluationError("Worker usage counts are invalid.");
  }
  decimal(execution.usage.costUsd);
}

function recommendation(
  execution: LocalWorkerExecutionOutcome,
  humanAccepted: boolean,
  missingDeliverables: number,
  incompleteCriteria: readonly Spine.Missions.AcceptanceCriterion[]
): NonNullable<Spine.Missions.PartialOutcome["recommendedNextAction"]> {
  if (!humanAccepted || incompleteCriteria.some((criterion) => criterion.evaluator === "human")) return "human-review";
  if (execution.retryable) return "retry";
  if (missingDeliverables > 0) return "resume";
  if (incompleteCriteria.some((criterion) => criterion.evaluator === "worker")) return "revise-plan";
  return "stop";
}

function bounded(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new MissionEvaluationError(`${label} is invalid.`);
  return trimmed;
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new MissionEvaluationError("Worker cost is invalid.");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}
