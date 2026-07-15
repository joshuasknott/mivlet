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
