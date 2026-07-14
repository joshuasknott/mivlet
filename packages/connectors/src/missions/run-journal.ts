import type { Spine } from "@fable/protocol";

type Run = Spine.Missions.Run;
type RunEvent = Spine.Missions.RunEvent;
type RunStatus = Spine.Missions.RunStatus;

const TERMINAL = new Set<RunStatus>(["completed", "partially-completed", "failed", "cancelled"]);
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
    case "run-completed": return { ...run, status: "completed", terminalResult: event.payload.result };
    case "run-failed": return { ...run, status: event.payload.partial ? "partially-completed" : "failed" };
    case "run-cancelled": return { ...run, status: event.payload.partial ? "partially-completed" : "cancelled" };
    default: return run;
  }
}

function sameScope(run: Run, event: RunEvent): boolean {
  return run.workspaceId === event.workspaceId && run.authority === event.authority &&
    run.schemaVersion === event.schemaVersion && run.visibility === event.visibility &&
    (run.visibility !== "member-private" ||
      (event.visibility === "member-private" && run.ownerMemberId === event.ownerMemberId));
}
