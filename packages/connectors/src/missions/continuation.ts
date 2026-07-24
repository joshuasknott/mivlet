import type { Spine } from "@fable/protocol";

const MAX_ITERATION_HISTORY = 64;

export type ContinuationAcceptanceAuthority =
  | "policy"
  | "human"
  | "worker"
  | "external";

export interface WorkerIterationFact {
  iterationNumber: number;
  attemptNumber: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  progressFingerprint: string;
  acceptanceStatus: "accepted" | "rejected" | "unevaluated";
  acceptanceAuthority?: ContinuationAcceptanceAuthority;
  retryableError?: Spine.Missions.ContractError;
  cancellationRequested: boolean;
  humanStopRequested: boolean;
  policyStopRequested: boolean;
  deadlineReached: boolean;
}

export interface DecideWorkerContinuationInput {
  worker: Spine.Missions.Worker;
  history: readonly WorkerIterationFact[];
  current: WorkerIterationFact;
  maxIterations: number;
  allowEscalation: boolean;
}

export interface WorkerContinuationDecision {
  action: "continue" | "complete" | "retry" | "escalate" | "stop";
  reason:
    | "accepted"
    | "cancelled"
    | "human-stop"
    | "policy-stop"
    | "deadline"
    | "budget"
    | "no-progress"
    | "retryable-failure"
    | "attempts-exhausted"
    | "iteration-limit"
    | "work-remains";
  requiresFreshAuthorization: boolean;
  nextAttemptNumber?: number;
  nextIterationNumber?: number;
}

export class WorkerContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerContinuationError";
  }
}

/**
 * Decide only whether bounded work may continue. This policy never treats a
 * worker or external model verdict as acceptance authority and never performs
 * a retry, escalation, provider switch, grant reuse, or side effect itself.
 */
export function decideWorkerContinuation(
  input: DecideWorkerContinuationInput
): WorkerContinuationDecision {
  validateInput(input);
  const { worker, current } = input;
  if (current.cancellationRequested) return stop("cancelled");
  if (current.humanStopRequested) return stop("human-stop");
  if (current.policyStopRequested) return stop("policy-stop");
  if (current.deadlineReached) return stop("deadline");
  if (exceedsBudget(worker, current)) return stop("budget");

  if (current.acceptanceStatus === "accepted") {
    if (!matchesAcceptanceAuthority(current.acceptanceAuthority)) {
      throw new WorkerContinuationError(
        "Only a trusted policy or identified human acceptance fact can complete bounded work."
      );
    }
    return {
      action: "complete",
      reason: "accepted",
      requiresFreshAuthorization: false
    };
  }

  if (current.retryableError) {
    if (current.retryableError.retryable !== true) {
      throw new WorkerContinuationError(
        "A retry request must retain an exact retryable error."
      );
    }
    const maximumAttempts = worker.budget.maxAttempts ?? 1;
    if (current.attemptNumber < maximumAttempts) {
      return {
        action: "retry",
        reason: "retryable-failure",
        requiresFreshAuthorization: true,
        nextAttemptNumber: current.attemptNumber + 1
      };
    }
    return input.allowEscalation
      ? {
          action: "escalate",
          reason: "attempts-exhausted",
          requiresFreshAuthorization: true
        }
      : stop("attempts-exhausted");
  }

  if (noProgressLimitReached(worker, [...input.history, current])) {
    return input.allowEscalation
      ? {
          action: "escalate",
          reason: "no-progress",
          requiresFreshAuthorization: true
        }
      : stop("no-progress");
  }
  if (current.iterationNumber >= input.maxIterations) {
    return stop("iteration-limit");
  }
  return {
    action: "continue",
    reason: "work-remains",
    requiresFreshAuthorization: false,
    nextIterationNumber: current.iterationNumber + 1
  };
}

function stop(reason: WorkerContinuationDecision["reason"]): WorkerContinuationDecision {
  return { action: "stop", reason, requiresFreshAuthorization: false };
}

function validateInput(input: DecideWorkerContinuationInput): void {
  if (
    !Number.isInteger(input.maxIterations) ||
    input.maxIterations < 1 ||
    input.maxIterations > MAX_ITERATION_HISTORY ||
    input.history.length >= MAX_ITERATION_HISTORY
  ) {
    throw new WorkerContinuationError("Worker iteration history exceeds its bounded limit.");
  }
  const facts = [...input.history, input.current];
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index]!;
    if (
      !Number.isInteger(fact.iterationNumber) ||
      fact.iterationNumber !== index + 1 ||
      !Number.isInteger(fact.attemptNumber) ||
      fact.attemptNumber < 1 ||
      ![fact.elapsedMs, fact.inputTokens, fact.outputTokens, fact.toolCalls].every(
        (value) => Number.isInteger(value) && value >= 0
      ) ||
      !fact.progressFingerprint.trim() ||
      fact.progressFingerprint.length > 200 ||
      [...fact.progressFingerprint].some((character) => character < " ")
    ) {
      throw new WorkerContinuationError(
        "Worker iteration facts must be contiguous, bounded, and nonnegative."
      );
    }
    if (
      fact.acceptanceStatus === "unevaluated"
        ? fact.acceptanceAuthority !== undefined
        : fact.acceptanceAuthority === undefined
    ) {
      throw new WorkerContinuationError(
        "Worker acceptance status must retain its exact evaluation authority."
      );
    }
    if (index > 0 && fact.attemptNumber < facts[index - 1]!.attemptNumber) {
      throw new WorkerContinuationError("Worker attempts cannot move backwards.");
    }
  }
}

function matchesAcceptanceAuthority(
  authority: ContinuationAcceptanceAuthority | undefined
): boolean {
  return authority === "policy" || authority === "human";
}

function exceedsBudget(worker: Spine.Missions.Worker, fact: WorkerIterationFact): boolean {
  const budget = worker.budget;
  return (
    (budget.maxDurationMs !== undefined && fact.elapsedMs >= budget.maxDurationMs) ||
    (budget.maxInputTokens !== undefined && fact.inputTokens >= budget.maxInputTokens) ||
    (budget.maxOutputTokens !== undefined && fact.outputTokens >= budget.maxOutputTokens) ||
    (budget.maxToolCalls !== undefined && fact.toolCalls >= budget.maxToolCalls)
  );
}

function noProgressLimitReached(
  worker: Spine.Missions.Worker,
  facts: readonly WorkerIterationFact[]
): boolean {
  const threshold = worker.stopConditions
    .filter((condition) => condition.kind === "no-progress")
    .map((condition) => condition.threshold)
    .find((value): value is number => value !== undefined);
  if (threshold === undefined) return false;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_ITERATION_HISTORY) {
    throw new WorkerContinuationError("Worker no-progress threshold is invalid.");
  }
  const latest = facts.at(-1)!.progressFingerprint;
  let repeated = 0;
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    if (facts[index]!.progressFingerprint !== latest) break;
    repeated += 1;
  }
  return repeated >= threshold;
}
