import type { Spine } from "@fable/protocol";

type Run = Spine.Missions.Run;
type RunEvent = Spine.Missions.RunEvent;
type RunStatus = Spine.Missions.RunStatus;

const TERMINAL = new Set<RunStatus>(["completed", "partially-completed", "failed", "cancelled"]);
const HUMAN_INPUT_KINDS = new Set<string>(["text", "number", "boolean", "choice", "date-time", "artifact"]);
const HUMAN_INPUT_LIMITS = {
  waitKey: 200,
  prompt: 2_000,
  fieldKey: 80,
  label: 200,
  help: 500,
  choices: 20,
  choice: 200,
  textValue: 4_000,
  identity: 200,
  timestamp: 64,
  absoluteNumber: 1_000_000_000_000_000
} as const;
const JOIN_LIMITS = {
  joinKey: 200,
  workerId: 200,
  maximumWorkers: 32,
  timestamp: 64
} as const;
const AGGREGATION_LIMITS = {
  stepKey: 160,
  outputKey: 160,
  summary: 2_000,
  reference: 512,
  maximumInputs: 32,
  maximumOutputs: 128
} as const;
const REVIEWER_SELECTION_LIMITS = {
  stepKey: 160,
  criterionKey: 160,
  policyRef: 240,
  maximumCriteria: 32,
  maximumJustifications: 3
} as const;
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["planning", "queued", "running", "cancelling", "cancelled", "failed"],
  planning: ["queued", "running", "waiting-human-input", "cancelling", "cancelled", "failed"],
  queued: ["running", "cancelling", "cancelled", "failed"],
  running: ["waiting-approval", "waiting-human-input", "paused", "retrying", "cancelling", "completed", "partially-completed", "failed", "cancelled"],
  "waiting-approval": ["running", "cancelling", "cancelled", "failed"],
  "waiting-human-input": ["running", "cancelling", "cancelled", "failed"],
  paused: ["queued", "running", "cancelling", "cancelled"],
  retrying: ["queued", "running", "cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "partially-completed", "failed"],
  completed: [], "partially-completed": [], failed: [], cancelled: []
};

export interface RunJournalProjection {
  run: Run;
  events: readonly RunEvent[];
  latestCheckpointEvent?: Extract<RunEvent, { type: "checkpoint-created" }>;
}

export class RunJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunJournalError";
  }
}

export function replayRunJournal(events: readonly RunEvent[]): RunJournalProjection {
  if (events.length === 0) throw new RunJournalError("A run journal must begin with run-created.");
  let projection: RunJournalProjection | undefined;
  for (const event of events) projection = appendRunEvent(projection, event);
  return projection!;
}

export function appendRunEvent(
  current: RunJournalProjection | undefined,
  event: RunEvent
): RunJournalProjection {
  if (!current) return initialize(event);
  const replay = current.events.find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) {
      throw new RunJournalError("A run event idempotency key cannot represent different facts.");
    }
    return current;
  }
  const { run } = current;
  if (TERMINAL.has(run.status)) throw new RunJournalError("A terminal run journal is immutable.");
  if (!sameScope(run, event) || event.runId !== run.id) throw new RunJournalError("Run events must stay in the run's authority scope.");
  if (event.sequence !== run.eventHead.lastSequence + 1 || event.previousEventId !== run.eventHead.lastEventId) {
    throw new RunJournalError("Run event sequence and previous-event link must be contiguous.");
  }
  if (current.events.some((candidate) => candidate.id === event.id)) throw new RunJournalError("Run event ids must be unique.");
  validateEvent(current, event);
  const nextRun = projectRun(run, event);
  return {
    run: { ...nextRun, eventHead: { lastSequence: event.sequence, lastEventId: event.id }, revision: run.revision + 1, updatedAt: event.occurredAt },
    events: [...current.events, event],
    latestCheckpointEvent: event.type === "checkpoint-created" ? event : current.latestCheckpointEvent
  };
}

function initialize(event: RunEvent): RunJournalProjection {
  if (event.type !== "run-created" || event.sequence !== 1 || event.previousEventId !== undefined) {
    throw new RunJournalError("A run journal must begin at sequence one with run-created.");
  }
  const run = event.payload.run;
  if (event.runId !== run.id || !sameScope(run, event) || run.eventHead.lastSequence !== 0 || run.eventHead.lastEventId !== undefined) {
    throw new RunJournalError("The run-created event does not contain a fresh matching run.");
  }
  return {
    run: { ...run, eventHead: { lastSequence: 1, lastEventId: event.id }, revision: run.revision + 1, updatedAt: event.occurredAt },
    events: [event]
  };
}

function validateEvent(current: RunJournalProjection, event: RunEvent): void {
  const run = current.run;
  if (event.type === "run-created") throw new RunJournalError("run-created can appear only once.");
  if (event.type === "status-transitioned") {
    if (event.payload.from !== run.status || TERMINAL.has(event.payload.to) || !TRANSITIONS[run.status].includes(event.payload.to)) {
      throw new RunJournalError("Run status transition is invalid from the current state.");
    }
  }
  if (event.type === "cancellation-requested") {
    if (run.cancellation || run.status === "cancelling" || !TRANSITIONS[run.status].includes("cancelling")) {
      throw new RunJournalError("Run already has a cancellation request or cannot begin cancelling.");
    }
    if (event.payload.cancellation.scope === "worker" && !event.payload.cancellation.workerId) {
      throw new RunJournalError("Worker cancellation requires an exact worker id.");
    }
  }
  if (event.type === "attempt-finished") {
    const attempt = event.payload.attempt;
    const currentAttempt = run.currentAttemptNumber ?? 1;
    if (attempt.runId !== run.id || attempt.attemptNumber !== currentAttempt
      || event.attemptNumber !== currentAttempt
      || !["succeeded", "failed", "cancelled", "interrupted", "superseded"].includes(attempt.status)) {
      throw new RunJournalError("Finished attempt must match the current run attempt and terminal attempt state.");
    }
    if (attempt.status === "failed" && (!attempt.retryReason || !attempt.finishedAt)) {
      throw new RunJournalError("Failed attempt must retain its retry reason and finish time.");
    }
  }
  if (event.type === "retry-scheduled") {
    const currentAttempt = run.currentAttemptNumber ?? 1;
    const maximumAttempts = run.budget.maxAttempts;
    const previous = current.events.at(-1);
    const finished = previous?.type === "attempt-finished" ? previous.payload.attempt : undefined;
    if (run.status !== "running" || event.attemptNumber !== currentAttempt
      || !Number.isInteger(maximumAttempts) || maximumAttempts! < 1
      || event.payload.nextAttemptNumber !== currentAttempt + 1
      || event.payload.nextAttemptNumber > maximumAttempts!
      || event.payload.childRunId !== undefined
      || event.payload.error.retryable !== true
      || !finished || finished.attemptNumber !== currentAttempt || finished.status !== "failed"
      || JSON.stringify(finished.retryReason) !== JSON.stringify(event.payload.error)) {
      throw new RunJournalError("Same-run retry must follow the exact retryable failed attempt within budget.");
    }
  }
  if (event.type === "checkpoint-created") {
    const boundary = event.payload.checkpoint.replayBoundary;
    const durable = current.events.find((candidate) => candidate.id === boundary.resumeAfterEventId);
    if (!durable || durable.sequence !== boundary.durableThroughSequence || boundary.durableThroughSequence >= event.sequence) {
      throw new RunJournalError("Checkpoint replay boundary must reference an earlier durable event.");
    }
    if (event.payload.checkpoint.attemptNumber !== (run.currentAttemptNumber ?? 1)) {
      throw new RunJournalError("Checkpoint attempt does not match the current run attempt.");
    }
  }
  if (event.type === "checkpoint-restored") {
    if (!current.latestCheckpointEvent || event.payload.checkpointEventId !== current.latestCheckpointEvent.id) {
      throw new RunJournalError("Only the latest durable checkpoint can be restored.");
    }
    const currentAttempt = run.currentAttemptNumber ?? current.latestCheckpointEvent.payload.checkpoint.attemptNumber;
    if (event.payload.newAttemptNumber !== currentAttempt + 1
      || (run.budget.maxAttempts !== undefined && event.payload.newAttemptNumber > run.budget.maxAttempts)) {
      throw new RunJournalError("Checkpoint restore must advance exactly one bounded attempt.");
    }
  }
  if (event.type === "approval-requested") {
    const wait = event.payload.wait;
    const active = activeApprovalWait(current.events);
    const previous = current.events.at(-1);
    if (run.status !== "running" || active
      || previous?.type !== "checkpoint-created"
      || previous.payload.checkpoint.kind !== "wait-boundary"
      || previous.payload.checkpoint.pendingWaitKey !== wait.waitKey
      || wait.status !== "pending"
      || !wait.waitKey.trim() || !wait.approvalRequestRef.trim()
      || !wait.proposalHash.trim() || !wait.actionSummary.trim()
      || (wait.workerId !== undefined && !wait.workerId.trim())) {
      throw new RunJournalError("Approval wait must be one exact pending proposal after a wait-boundary checkpoint.");
    }
  }
  if (event.type === "approval-resolved") {
    const wait = activeApprovalWait(current.events);
    const resolution = event.payload.resolution;
    if (run.status !== "waiting-approval" || !wait
      || resolution.waitKey !== wait.waitKey
      || resolution.acceptedProposalHash !== wait.proposalHash
      || !["approved", "denied", "cancelled"].includes(resolution.decision)
      || (resolution.decision !== "approved" && resolution.replacementApprovalRequestRef !== undefined)) {
      throw new RunJournalError("Approval resolution must resolve the exact active proposal.");
    }
  }
  if (event.type === "human-input-requested") {
    const wait = event.payload.wait;
    const active = activeHumanInputWait(current.events);
    const previous = current.events.at(-1);
    if (!TRANSITIONS[run.status].includes("waiting-human-input") || active
      || previous?.type !== "checkpoint-created"
      || previous.payload.checkpoint.kind !== "wait-boundary"
      || previous.payload.checkpoint.pendingWaitKey !== wait.waitKey
      || !validHumanInputWait(wait)) {
      throw new RunJournalError("Human input wait must be one valid pending schema after its exact wait-boundary checkpoint.");
    }
  }
  if (event.type === "human-input-received") {
    const wait = activeHumanInputWait(current.events);
    const resolution = event.payload.resolution;
    if (run.status !== "waiting-human-input" || !wait
      || resolution.waitKey !== wait.waitKey
      || !validHumanInputResolution(wait, resolution)) {
      throw new RunJournalError("Human input must resolve the exact active wait with values matching its schema.");
    }
  }
  if (event.type === "join-opened") validateJoinOpened(current, event.payload.join);
  if (event.type === "join-resolved") validateJoinResolved(current, event.payload.join, event.occurredAt);
  if (event.type === "aggregation-recorded") {
    validateAggregationRecorded(current, event.payload.aggregation);
  }
  if (event.type === "reviewer-selected") {
    validateReviewerSelected(current, event.payload.selection);
  }
  if (event.type === "run-completed" && event.payload.result.outcome !== "succeeded") {
    throw new RunJournalError("run-completed requires a succeeded result.");
  }
  const terminalTarget = event.type === "run-completed" ? "completed"
    : event.type === "run-failed" ? (event.payload.partial ? "partially-completed" : "failed")
      : event.type === "run-cancelled" ? (event.payload.partial ? "partially-completed" : "cancelled")
        : undefined;
  if (terminalTarget && !TRANSITIONS[run.status].includes(terminalTarget)) {
    throw new RunJournalError("Terminal run event is invalid from the current state.");
  }
  if (event.type === "run-cancelled" && event.payload.cancellation.requestKey !== run.cancellation?.requestKey) {
    throw new RunJournalError("Run cancellation must resolve the current cancellation request.");
  }
}

function projectRun(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case "status-transitioned": return { ...run, status: event.payload.to };
    case "attempt-started": return { ...run, currentAttemptNumber: event.payload.attempt.attemptNumber };
    case "checkpoint-restored": return { ...run, status: run.status === "retrying" ? "running" : run.status, currentAttemptNumber: event.payload.newAttemptNumber };
    case "retry-scheduled": return { ...run, status: "retrying" };
    case "cancellation-requested": return { ...run, status: "cancelling", cancellation: event.payload.cancellation };
    case "approval-requested": return { ...run, status: "waiting-approval" };
    case "approval-resolved": return { ...run, status: "running" };
    case "human-input-requested": return { ...run, status: "waiting-human-input" };
    case "human-input-received": return { ...run, status: "running" };
    case "run-completed": return { ...run, status: "completed", terminalResult: event.payload.result };
    case "run-failed": return { ...run, status: event.payload.partial ? "partially-completed" : "failed" };
    case "run-cancelled": return { ...run, status: event.payload.partial ? "partially-completed" : "cancelled" };
    default: return run;
  }
}

function validateJoinOpened(current: RunJournalProjection, join: Spine.Missions.WorkerJoin): void {
  const run = current.run;
  const workerLimit = run.budget.maxWorkers;
  if (run.status !== "running" || run.executionDepth !== "multi-worker"
    || !Number.isInteger(workerLimit) || workerLimit! < 1
    || !validOpenJoin(join, Math.min(workerLimit!, JOIN_LIMITS.maximumWorkers))) {
    throw new RunJournalError("A join must open with one valid bounded multi-worker definition.");
  }

  const joins = current.events.filter((candidate) => candidate.type === "join-opened");
  if (joins.some((candidate) => candidate.payload.join.joinKey === join.joinKey)
    || activeWorkerJoin(current.events)) {
    throw new RunJournalError("A join key is immutable and only one worker join can be open.");
  }

  validateJoinMembers(current, join.workerIds);
}

function validateJoinMembers(
  current: RunJournalProjection,
  memberIds: readonly Spine.Primitives.WorkerId[]
): void {
  const { run } = current;
  const selectedPlanRevisionId = current.events.reduce<Spine.Primitives.PlanRevisionId | undefined>(
    (selected, candidate) => candidate.type === "plan-revision-selected" ? candidate.payload.planRevisionId : selected,
    run.planRevisionId
  );
  if (!selectedPlanRevisionId) {
    throw new RunJournalError("Join members must belong to the run's exact selected plan revision.");
  }

  const members = new Set(memberIds);
  const created = new Map<Spine.Primitives.WorkerId, { worker: Spine.Missions.Worker; sequence: number }>();
  const started = new Map<Spine.Primitives.WorkerId, number>();
  for (const candidate of current.events) {
    if (candidate.type === "worker-created" && members.has(candidate.payload.worker.id)) {
      const worker = candidate.payload.worker;
      if (created.has(worker.id)) {
        throw new RunJournalError("Each join member must have one unique worker-created fact.");
      }
      created.set(worker.id, { worker, sequence: candidate.sequence });
    }
    if (candidate.type === "worker-started" && members.has(candidate.payload.workerId)) {
      if (started.has(candidate.payload.workerId)) {
        throw new RunJournalError("Each join member must have one unique worker-started fact.");
      }
      started.set(candidate.payload.workerId, candidate.sequence);
    }
  }

  for (const workerId of memberIds) {
    const creation = created.get(workerId);
    const startedAt = started.get(workerId);
    if (!creation || startedAt === undefined || startedAt <= creation.sequence) {
      throw new RunJournalError("Every join member must be derived from one started worker-created journal fact.");
    }
    const worker = creation.worker;
    if (worker.runId !== run.id || !sameWorkerScope(run, worker)
      || worker.planRevisionId !== selectedPlanRevisionId
      || !boundedString(worker.planStepKey, JOIN_LIMITS.joinKey)) {
      throw new RunJournalError("Join members must stay in the run scope and exact selected plan revision.");
    }
  }
}

function validateJoinResolved(
  current: RunJournalProjection,
  resolution: Spine.Missions.WorkerJoin,
  occurredAt: string
): void {
  const opened = activeWorkerJoin(current.events);
  const validShape = validResolvedJoinShape(resolution);
  const validRunStatus = current.run.status === "running"
    || (current.run.status === "cancelling" && validShape && resolution.status === "cancelled");
  if (!validRunStatus || !opened || !validShape
    || resolution.joinKey !== opened.joinKey
    || !sameJoinDefinition(opened, resolution)
  ) {
    throw new RunJournalError("Join resolution must immutably resolve the exact active join.");
  }
  validateJoinMembers(current, opened.workerIds);

  const memberIds = new Set(opened.workerIds);
  const startedAt = new Map<Spine.Primitives.WorkerId, number>();
  const completed = new Set<Spine.Primitives.WorkerId>();
  const failed = new Set<Spine.Primitives.WorkerId>();
  for (const candidate of current.events) {
    if (candidate.type === "worker-started" && memberIds.has(candidate.payload.workerId)) {
      startedAt.set(candidate.payload.workerId, candidate.sequence);
    }
  }
  for (const candidate of current.events) {
    if (candidate.type === "worker-completed" && memberIds.has(candidate.payload.workerId)) {
      if (candidate.sequence <= startedAt.get(candidate.payload.workerId)!
        || completed.has(candidate.payload.workerId) || failed.has(candidate.payload.workerId)) {
        throw new RunJournalError("A join member can have only one terminal worker fact.");
      }
      completed.add(candidate.payload.workerId);
    }
    if (candidate.type === "worker-failed" && memberIds.has(candidate.payload.workerId)) {
      if (candidate.sequence <= startedAt.get(candidate.payload.workerId)!
        || completed.has(candidate.payload.workerId) || failed.has(candidate.payload.workerId)) {
        throw new RunJournalError("A join member can have only one terminal worker fact.");
      }
      failed.add(candidate.payload.workerId);
    }
  }

  const expectedSatisfied = opened.workerIds.filter((workerId) => completed.has(workerId));
  const expectedFailed = opened.workerIds.filter((workerId) => failed.has(workerId));
  if (!sameStrings(resolution.satisfiedWorkerIds, expectedSatisfied)
    || !sameStrings(resolution.failedWorkerIds, expectedFailed)) {
    throw new RunJournalError("Join outcome sets must be derived exactly from terminal member worker facts.");
  }

  if (resolution.status === "satisfied" && !joinIsSatisfied(opened, completed.size, failed.size)) {
    throw new RunJournalError("A join cannot resolve satisfied before its exact strategy is satisfied.");
  }
  if (resolution.status === "timed-out") {
    const deadline = opened.deadline === undefined ? Number.NaN : Date.parse(opened.deadline);
    const resolvedAt = Date.parse(occurredAt);
    if (!Number.isFinite(deadline) || !Number.isFinite(resolvedAt) || resolvedAt < deadline) {
      throw new RunJournalError("A join can time out only at or after its declared deadline.");
    }
  }
}

function validResolvedJoinShape(join: Spine.Missions.WorkerJoin): boolean {
  return isRecord(join)
    && hasOnlyKeys(join, ["joinKey", "status", "strategy", "workerIds", "quorum", "allowFailedWorkers", "deadline", "satisfiedWorkerIds", "failedWorkerIds"])
    && boundedString(join.joinKey, JOIN_LIMITS.joinKey)
    && ["satisfied", "timed-out", "cancelled"].includes(join.status)
    && ["all", "any", "quorum"].includes(join.strategy)
    && Array.isArray(join.workerIds)
    && join.workerIds.every((workerId) => boundedString(workerId, JOIN_LIMITS.workerId))
    && Array.isArray(join.satisfiedWorkerIds)
    && join.satisfiedWorkerIds.every((workerId) => boundedString(workerId, JOIN_LIMITS.workerId))
    && Array.isArray(join.failedWorkerIds)
    && join.failedWorkerIds.every((workerId) => boundedString(workerId, JOIN_LIMITS.workerId))
    && typeof join.allowFailedWorkers === "boolean"
    && (join.deadline === undefined || boundedString(join.deadline, JOIN_LIMITS.timestamp));
}

function validOpenJoin(join: Spine.Missions.WorkerJoin, workerLimit: number): boolean {
  if (!isRecord(join)
    || !hasOnlyKeys(join, ["joinKey", "status", "strategy", "workerIds", "quorum", "allowFailedWorkers", "deadline", "satisfiedWorkerIds", "failedWorkerIds"])
    || !boundedString(join.joinKey, JOIN_LIMITS.joinKey)
    || join.status !== "open"
    || !["all", "any", "quorum"].includes(join.strategy)
    || !Array.isArray(join.workerIds) || join.workerIds.length < 1
    || join.workerIds.length > workerLimit || join.workerIds.length > JOIN_LIMITS.maximumWorkers
    || new Set(join.workerIds).size !== join.workerIds.length
    || join.workerIds.some((workerId) => !boundedString(workerId, JOIN_LIMITS.workerId))
    || typeof join.allowFailedWorkers !== "boolean"
    || (join.deadline !== undefined && (!boundedString(join.deadline, JOIN_LIMITS.timestamp) || !Number.isFinite(Date.parse(join.deadline))))
    || !Array.isArray(join.satisfiedWorkerIds) || join.satisfiedWorkerIds.length !== 0
    || !Array.isArray(join.failedWorkerIds) || join.failedWorkerIds.length !== 0) {
    return false;
  }
  if (join.strategy === "quorum") {
    return Number.isInteger(join.quorum) && join.quorum! >= 1 && join.quorum! <= join.workerIds.length;
  }
  return join.quorum === undefined;
}

function validateAggregationRecorded(
  current: RunJournalProjection,
  aggregation: Spine.Missions.DeterministicAggregationReceipt
): void {
  if (
    current.run.status !== "running" ||
    current.run.executionDepth !== "multi-worker" ||
    aggregation.version !== 1 ||
    aggregation.strategy !== "ordered-manifest-v1" ||
    !boundedString(aggregation.stepKey, AGGREGATION_LIMITS.stepKey) ||
    !["complete", "partial"].includes(aggregation.status) ||
    aggregation.inputs.length < 1 ||
    aggregation.inputs.length > AGGREGATION_LIMITS.maximumInputs ||
    aggregation.producedOutputs.length > AGGREGATION_LIMITS.maximumOutputs ||
    current.events.some(
      (candidate) =>
        candidate.type === "aggregation-recorded" &&
        candidate.payload.aggregation.stepKey === aggregation.stepKey
    )
  ) {
    throw new RunJournalError(
      "A deterministic aggregation must be one bounded immutable running-run fact."
    );
  }

  const selectedPlanRevisionId = current.events.reduce<
    Spine.Primitives.PlanRevisionId | undefined
  >(
    (selected, candidate) =>
      candidate.type === "plan-revision-selected"
        ? candidate.payload.planRevisionId
        : selected,
    current.run.planRevisionId
  );
  const workers = new Map<string, Spine.Missions.Worker>();
  const terminal = new Map<
    string,
    { status: "completed" | "failed"; outputs: readonly Spine.Missions.ProducedOutput[] }
  >();
  for (const candidate of current.events) {
    if (candidate.type === "worker-created") {
      workers.set(candidate.payload.worker.id, candidate.payload.worker);
    } else if (candidate.type === "worker-completed") {
      terminal.set(candidate.payload.workerId, {
        status: "completed",
        outputs: candidate.payload.outputs
      });
    } else if (candidate.type === "worker-failed") {
      terminal.set(candidate.payload.workerId, {
        status: "failed",
        outputs: candidate.payload.partial?.completedOutputs ?? []
      });
    }
  }

  const sourceSteps = new Set<string>();
  const workerIds = new Set<string>();
  const orderedWorkerIds: Spine.Primitives.WorkerId[] = [];
  const outputKeys = new Set<string>();
  const requiredKeys = new Set<string>();
  const expectedOutputs: Spine.Missions.ProducedOutput[] = [];
  for (const input of aggregation.inputs) {
    const worker = workers.get(input.workerId);
    const outcome = terminal.get(input.workerId);
    if (
      !worker ||
      !outcome ||
      input.status === "cancelled" ||
      input.status !== outcome.status ||
      worker.runId !== current.run.id ||
      worker.planRevisionId !== selectedPlanRevisionId ||
      worker.planStepKey !== input.sourceStepKey ||
      aggregation.stepKey === input.sourceStepKey ||
      !sameWorkerScope(current.run, worker) ||
      !sourceSteps.add(input.sourceStepKey) ||
      !workerIds.add(input.workerId) ||
      JSON.stringify(input.outputs) !== JSON.stringify(outcome.outputs)
    ) {
      throw new RunJournalError(
        "Aggregation inputs must match unique terminal workers in the selected run."
      );
    }
    orderedWorkerIds.push(input.workerId);
    const declared = new Map(worker.outputContract.slots.map((slot) => [slot.key, slot]));
    for (const slot of worker.outputContract.slots) {
      if (slot.required) requiredKeys.add(slot.key);
    }
    for (const output of input.outputs) {
      if (
        !declared.has(output.key) ||
        !validProducedOutput(output) ||
        outputKeys.has(output.key)
      ) {
        throw new RunJournalError(
          "Aggregation outputs must be unique exact outputs declared by their source workers."
        );
      }
      outputKeys.add(output.key);
      requiredKeys.delete(output.key);
      expectedOutputs.push(output);
    }
  }
  if (
    orderedWorkerIds.length > 1 &&
    !current.events.some(
      (candidate) =>
        candidate.type === "join-resolved" &&
        candidate.payload.join.status === "satisfied" &&
        sameStrings(candidate.payload.join.workerIds, orderedWorkerIds)
    )
  ) {
    throw new RunJournalError(
      "A multi-source aggregation requires its exact satisfied dependency join."
    );
  }
  const expectedMissing = [...requiredKeys].sort();
  const expectedStatus =
    aggregation.inputs.every((input) => input.status === "completed") &&
    expectedMissing.length === 0
      ? "complete"
      : "partial";
  if (
    aggregation.status !== expectedStatus ||
    JSON.stringify(aggregation.producedOutputs) !== JSON.stringify(expectedOutputs) ||
    !sameStrings(aggregation.missingRequiredOutputKeys, expectedMissing)
  ) {
    throw new RunJournalError(
      "Aggregation result must be derived exactly from its ordered immutable inputs."
    );
  }
}

function validateReviewerSelected(
  current: RunJournalProjection,
  selection: Spine.Missions.MissionReviewerSelection
): void {
  const justifications = [
    "declared-worker-acceptance",
    "user-requested-advisory",
    "high-risk-policy",
    "conflicting-evidence"
  ] as const;
  const matchingWorkers = current.events
    .flatMap((candidate) =>
      candidate.type === "worker-created" &&
      candidate.payload.worker.id === selection.reviewerWorkerId
        ? [candidate.payload.worker]
        : []
    );
  const selectedPlanRevisionId = current.events.reduce<
    Spine.Primitives.PlanRevisionId | undefined
  >(
    (selected, candidate) =>
      candidate.type === "plan-revision-selected"
        ? candidate.payload.planRevisionId
        : selected,
    current.run.planRevisionId
  );
  if (
    current.run.status !== "running" ||
    current.run.executionDepth !== "multi-worker" ||
    current.events.some((candidate) => candidate.type === "reviewer-selected") ||
    current.events.some(
      (candidate) =>
        candidate.type === "worker-started" &&
        candidate.payload.workerId === selection.reviewerWorkerId
    ) ||
    matchingWorkers.length !== 1 ||
    matchingWorkers[0]!.runId !== current.run.id ||
    matchingWorkers[0]!.planRevisionId !== selectedPlanRevisionId ||
    matchingWorkers[0]!.planStepKey !== selection.reviewStepKey ||
    matchingWorkers[0]!.role.kind !== "reviewer" ||
    !sameWorkerScope(current.run, matchingWorkers[0]!) ||
    !boundedString(selection.reviewStepKey, REVIEWER_SELECTION_LIMITS.stepKey) ||
    !boundedString(selection.policyRef, REVIEWER_SELECTION_LIMITS.policyRef) ||
    !selection.policyRef.startsWith("native-policy:") ||
    selection.justification.length < 1 ||
    selection.justification.length > REVIEWER_SELECTION_LIMITS.maximumJustifications ||
    new Set(selection.justification).size !== selection.justification.length ||
    selection.justification.some(
      (justification) => !justifications.includes(justification)
    ) ||
    selection.criterionKeys.length > REVIEWER_SELECTION_LIMITS.maximumCriteria ||
    new Set(selection.criterionKeys).size !== selection.criterionKeys.length ||
    selection.criterionKeys.some(
      (criterion) =>
        !boundedString(criterion, REVIEWER_SELECTION_LIMITS.criterionKey)
    ) ||
    (selection.authority === "declared-worker-evaluator") !==
      selection.justification.includes("declared-worker-acceptance") ||
    (
      selection.justification.includes("user-requested-advisory") &&
      (
        selection.authority !== "advisory" ||
        selection.justification.length !== 1 ||
        selection.criterionKeys.length !== 0 ||
        selection.policyRef !== "native-policy:mission-advisory-review:v1"
      )
    )
  ) {
    throw new RunJournalError(
      "Reviewer selection must bind one exact declared reviewer to bounded native justification."
    );
  }
}

function validProducedOutput(output: Spine.Missions.ProducedOutput): boolean {
  return (
    boundedString(output.key, AGGREGATION_LIMITS.outputKey) &&
    boundedString(output.summary, AGGREGATION_LIMITS.summary) &&
    [output.artifactId, output.artifactVersionId, output.handoffId, output.valueReference].every(
      (value) => value === undefined || boundedString(value, AGGREGATION_LIMITS.reference)
    )
  );
}

function activeWorkerJoin(events: readonly RunEvent[]): Spine.Missions.WorkerJoin | undefined {
  let active: Spine.Missions.WorkerJoin | undefined;
  for (const event of events) {
    if (event.type === "join-opened") active = event.payload.join;
    if (event.type === "join-resolved" && active?.joinKey === event.payload.join.joinKey) active = undefined;
  }
  return active;
}

function sameJoinDefinition(opened: Spine.Missions.WorkerJoin, resolution: Spine.Missions.WorkerJoin): boolean {
  return opened.strategy === resolution.strategy
    && sameStrings(opened.workerIds, resolution.workerIds)
    && opened.quorum === resolution.quorum
    && opened.allowFailedWorkers === resolution.allowFailedWorkers
    && opened.deadline === resolution.deadline;
}

function joinIsSatisfied(join: Spine.Missions.WorkerJoin, completed: number, failed: number): boolean {
  if (!join.allowFailedWorkers && failed > 0) return false;
  const accepted = completed + (join.allowFailedWorkers ? failed : 0);
  if (join.strategy === "all") return accepted === join.workerIds.length;
  if (join.strategy === "any") return accepted >= 1;
  return accepted >= join.quorum!;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameWorkerScope(run: Run, worker: Spine.Missions.Worker): boolean {
  return run.workspaceId === worker.workspaceId && run.authority === worker.authority
    && run.schemaVersion === worker.schemaVersion && run.visibility === worker.visibility
    && (run.visibility !== "member-private"
      || (worker.visibility === "member-private" && run.ownerMemberId === worker.ownerMemberId));
}

function activeApprovalWait(events: readonly RunEvent[]): Spine.Missions.ApprovalWait | undefined {
  let active: Spine.Missions.ApprovalWait | undefined;
  for (const event of events) {
    if (event.type === "approval-requested") active = event.payload.wait;
    if (event.type === "approval-resolved" && active?.waitKey === event.payload.resolution.waitKey) active = undefined;
  }
  return active;
}

function activeHumanInputWait(events: readonly RunEvent[]): Spine.Missions.HumanInputWait | undefined {
  let active: Spine.Missions.HumanInputWait | undefined;
  for (const event of events) {
    if (event.type === "human-input-requested") active = event.payload.wait;
    if (event.type === "human-input-received" && active?.waitKey === event.payload.resolution.waitKey) active = undefined;
  }
  return active;
}

function validHumanInputWait(wait: Spine.Missions.HumanInputWait): boolean {
  if (!isRecord(wait)
    || !hasOnlyKeys(wait, ["waitKey", "status", "prompt", "fields", "requestedAt", "expiresAt", "workerId"])
    || wait.status !== "pending"
    || !boundedString(wait.waitKey, HUMAN_INPUT_LIMITS.waitKey)
    || !boundedString(wait.prompt, HUMAN_INPUT_LIMITS.prompt)
    || !boundedString(wait.requestedAt, HUMAN_INPUT_LIMITS.timestamp)
    || (wait.expiresAt !== undefined && !boundedString(wait.expiresAt, HUMAN_INPUT_LIMITS.timestamp))
    || (wait.workerId !== undefined && !boundedString(wait.workerId, HUMAN_INPUT_LIMITS.identity))
    || !Array.isArray(wait.fields) || wait.fields.length < 1 || wait.fields.length > 8) {
    return false;
  }

  const keys = new Set<string>();
  for (const field of wait.fields) {
    if (!isRecord(field)
      || !hasOnlyKeys(field, ["key", "label", "help", "kind", "required", "choices", "sensitive"])
      || !boundedString(field.key, HUMAN_INPUT_LIMITS.fieldKey)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(field.key)
      || keys.has(field.key)
      || !boundedString(field.label, HUMAN_INPUT_LIMITS.label)
      || (field.help !== undefined && !boundedString(field.help, HUMAN_INPUT_LIMITS.help))
      || typeof field.kind !== "string"
      || !HUMAN_INPUT_KINDS.has(field.kind)
      || typeof field.required !== "boolean"
      || field.sensitive !== false) {
      return false;
    }
    keys.add(field.key);

    if (field.kind === "choice") {
      if (!Array.isArray(field.choices) || field.choices.length < 2 || field.choices.length > HUMAN_INPUT_LIMITS.choices) return false;
      const choices = new Set<string>();
      for (const choice of field.choices) {
        if (!boundedString(choice, HUMAN_INPUT_LIMITS.choice) || choices.has(choice)) return false;
        choices.add(choice);
      }
    } else if (field.choices !== undefined) {
      return false;
    }
  }
  return true;
}

function validHumanInputResolution(
  wait: Spine.Missions.HumanInputWait,
  resolution: Spine.Missions.HumanInputResolution
): boolean {
  if (!isRecord(resolution)
    || !hasOnlyKeys(resolution, ["waitKey", "receivedAt", "suppliedByInternalUserId", "values"])
    || !boundedString(resolution.waitKey, HUMAN_INPUT_LIMITS.waitKey)
    || !boundedString(resolution.receivedAt, HUMAN_INPUT_LIMITS.timestamp)
    || !boundedString(resolution.suppliedByInternalUserId, HUMAN_INPUT_LIMITS.identity)
    || !Array.isArray(resolution.values)
    || resolution.values.length > wait.fields.length) {
    return false;
  }

  const fields = new Map(wait.fields.map((field) => [field.key, field] as const));
  const supplied = new Set<string>();
  for (const input of resolution.values) {
    if (!isRecord(input)
      || !hasOnlyKeys(input, ["fieldKey", "value"])
      || !boundedString(input.fieldKey, HUMAN_INPUT_LIMITS.fieldKey)
      || supplied.has(input.fieldKey)) {
      return false;
    }
    const field = fields.get(input.fieldKey);
    if (!field || !validHumanInputValue(field, input.value)) return false;
    supplied.add(input.fieldKey);
  }
  return wait.fields.every((field) => !field.required || supplied.has(field.key));
}

function validHumanInputValue(field: Spine.Missions.HumanInputField, value: unknown): boolean {
  if (value === null) return !field.required;
  switch (field.kind) {
    case "text":
      return typeof value === "string" && value.length <= HUMAN_INPUT_LIMITS.textValue && (!field.required || value.trim().length > 0);
    case "number":
      return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= HUMAN_INPUT_LIMITS.absoluteNumber;
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && field.choices?.includes(value) === true;
    case "date-time":
      return typeof value === "string" && value.length <= HUMAN_INPUT_LIMITS.timestamp
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
        && Number.isFinite(Date.parse(value));
    case "artifact":
      return isRecord(value)
        && hasExactKeys(value, ["artifactId", "artifactVersionId", "contentHash"])
        && boundedString(value.artifactId, HUMAN_INPUT_LIMITS.identity)
        && boundedString(value.artifactVersionId, HUMAN_INPUT_LIMITS.identity)
        && isRecord(value.contentHash)
        && hasExactKeys(value.contentHash, ["algorithm", "value"])
        && value.contentHash.algorithm === "sha-256"
        && typeof value.contentHash.value === "string"
        && /^[0-9a-f]{64}$/.test(value.contentHash.value);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function sameScope(run: Run, event: RunEvent): boolean {
  return run.workspaceId === event.workspaceId && run.authority === event.authority &&
    run.schemaVersion === event.schemaVersion && run.visibility === event.visibility &&
    (run.visibility !== "member-private" ||
      (event.visibility === "member-private" && run.ownerMemberId === event.ownerMemberId));
}
