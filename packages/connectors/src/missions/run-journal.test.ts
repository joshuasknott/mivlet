import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import { appendRunEvent, replayRunJournal } from "./run-journal";

const id = <Kind extends string>(value: string) => value as Spine.Primitives.FableId<Kind>;

function run(): Spine.Missions.Run {
  return {
    id: id<"run">("run-1"), workspaceId: id<"workspace">("workspace-1"), visibility: "member-private",
    ownerMemberId: id<"member">("member-1"), authority: "local", schemaVersion: 1, revision: 1,
    createdByInternalUserId: id<"internal-user">("user-1"), createdAt: "t0", updatedAt: "t0",
    status: "created", kind: "mission", executionDepth: "delegated",
    initiator: { kind: "mission", missionId: id<"mission">("mission-1") }, parentage: { kind: "root" },
    departmentIds: [], budget: { maxAttempts: 2 }, eventHead: { lastSequence: 0 }
  };
}

function event<Type extends Spine.Missions.RunEventType>(
  type: Type,
  sequence: number,
  payload: Spine.Missions.RunEventPayloadByType[Type],
  previousEventId?: Spine.Primitives.RunEventId,
  key = `${type}:${sequence}`
): Spine.Missions.RunEvent {
  return {
    id: id<"run-event">(`event-${sequence}`), runId: id<"run">("run-1"), type, sequence, previousEventId,
    workspaceId: id<"workspace">("workspace-1"), visibility: "member-private", ownerMemberId: id<"member">("member-1"),
    authority: "local", schemaVersion: 1, revision: 1, createdByInternalUserId: id<"internal-user">("user-1"),
    createdAt: `t${sequence}`, updatedAt: `t${sequence}`, occurredAt: `t${sequence}`,
    actor: { kind: "system" }, idempotencyKey: key, payload
  } as Spine.Missions.RunEvent;
}

const created = () => event("run-created", 1, { run: run() });

function multiWorkerRun(overrides: Partial<Spine.Missions.Run> = {}): Spine.Missions.Run {
  return {
    ...run(), executionDepth: "multi-worker", planRevisionId: id<"plan-revision">("revision-1"),
    budget: { maxWorkers: 2, maxAttempts: 2 },
    ...overrides
  } as Spine.Missions.Run;
}

function worker(workerId: string, overrides: Partial<Spine.Missions.Worker> = {}): Spine.Missions.Worker {
  return {
    id: id<"worker">(workerId), runId: id<"run">("run-1"), workspaceId: id<"workspace">("workspace-1"),
    visibility: "member-private", ownerMemberId: id<"member">("member-1"), authority: "local",
    schemaVersion: 1, revision: 1, createdByInternalUserId: id<"internal-user">("user-1"),
    createdAt: "t2", updatedAt: "t2", status: "proposed",
    role: { kind: "specialist", title: `Worker ${workerId}`, objective: "Complete the bounded plan step.", responsibilities: [] },
    planRevisionId: id<"plan-revision">("revision-1"), planStepKey: `step-${workerId}`,
    context: [], capabilityIds: [], capabilityGrantIds: [], tools: [], budget: { maxAttempts: 1 },
    stopConditions: [{ kind: "objective-met", description: "Stop when the assigned objective is complete." }],
    outputContract: { slots: [], includeEvidence: false, includeUncertainty: true, delivery: "join" },
    ...overrides
  } as Spine.Missions.Worker;
}

function openJoin(overrides: Partial<Spine.Missions.WorkerJoin> = {}): Spine.Missions.WorkerJoin {
  return {
    joinKey: "join-research", status: "open", strategy: "all",
    workerIds: [id<"worker">("worker-1"), id<"worker">("worker-2")],
    allowFailedWorkers: false, satisfiedWorkerIds: [], failedWorkerIds: [],
    ...overrides
  };
}

function startedWorkers(
  first: Spine.Missions.Worker = worker("worker-1"),
  second: Spine.Missions.Worker = worker("worker-2"),
  runRecord: Spine.Missions.Run = multiWorkerRun()
) {
  const events: Spine.Missions.RunEvent[] = [
    event("run-created", 1, { run: runRecord }),
    event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1")),
    event("worker-created", 3, { worker: first }, id<"run-event">("event-2")),
    event("worker-started", 4, { workerId: first.id }, id<"run-event">("event-3")),
    event("worker-created", 5, { worker: second }, id<"run-event">("event-4")),
    event("worker-started", 6, { workerId: second.id }, id<"run-event">("event-5"))
  ];
  return replayRunJournal(events);
}

const workerError = (): Spine.Missions.ContractError => ({
  code: "worker-failed", category: "internal", message: "The worker failed.", retryable: false
});

function humanInputWait(): Spine.Missions.HumanInputWait {
  return {
    waitKey: "collect-brief-1",
    status: "pending",
    prompt: "Provide the bounded details needed to continue.",
    requestedAt: "2026-07-15T10:00:00Z",
    fields: [
      { key: "title", label: "Title", help: "Use a short working title.", kind: "text", required: true, sensitive: false } as Spine.Missions.HumanInputField,
      { key: "note", label: "Optional note", kind: "text", required: false, sensitive: false },
      { key: "count", label: "Count", kind: "number", required: true, sensitive: false },
      { key: "confirmed", label: "Confirmed", kind: "boolean", required: true, sensitive: false },
      { key: "format", label: "Format", kind: "choice", choices: ["brief", "report"], required: true, sensitive: false },
      { key: "due-at", label: "Due at", kind: "date-time", required: true, sensitive: false },
      { key: "source", label: "Source artifact", kind: "artifact", required: true, sensitive: false }
    ]
  };
}

function savedHumanInputBoundary(waitKey = "collect-brief-1") {
  const running = appendRunEvent(
    appendRunEvent(undefined, created()),
    event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1"))
  );
  return appendRunEvent(running, event("checkpoint-created", 3, {
    checkpoint: {
      kind: "wait-boundary", attemptNumber: 1, createdAt: "t3",
      replayBoundary: { durableThroughSequence: 2, resumeAfterEventId: id<"run-event">("event-2"), completedPlanStepKeys: [], completedWorkerIds: [], committedEffectKeys: [] },
      stateStorage: "portable-redacted", stateReference: "checkpoint:human-input", stateHash: "hash-human-input",
      pendingWaitKey: waitKey,
      executionNodeId: id<"execution-node">("local")
    }
  }, id<"run-event">("event-2")));
}

function humanInputArtifactReference(): Spine.Missions.HumanInputArtifactVersionReference {
  return {
    artifactId: id<"artifact">("artifact-1"),
    artifactVersionId: id<"artifact-version">("artifact-version-1"),
    contentHash: { algorithm: "sha-256", value: "a".repeat(64) }
  };
}

function humanInputResolution(values: readonly Spine.Missions.HumanInputValue[] = [
  { fieldKey: "title", value: "Quarterly research brief" },
  { fieldKey: "count", value: 3 },
  { fieldKey: "confirmed", value: true },
  { fieldKey: "format", value: "brief" },
  { fieldKey: "due-at", value: "2026-07-31T16:30:00Z" },
  { fieldKey: "source", value: humanInputArtifactReference() }
]): Spine.Missions.HumanInputResolution {
  return {
    waitKey: "collect-brief-1", receivedAt: "2026-07-15T10:01:00Z",
    suppliedByInternalUserId: id<"internal-user">("user-1"), values
  };
}

describe("durable run journal projection", () => {
  it("replays contiguous events into one deterministic run projection", () => {
    const started = event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1"));
    const projection = replayRunJournal([created(), started]);
    expect(projection.run).toMatchObject({ status: "running", revision: 3, eventHead: { lastSequence: 2, lastEventId: "event-2" } });
  });

  it("deduplicates an exact idempotent replay and rejects changed facts", () => {
    const initial = appendRunEvent(undefined, created());
    expect(appendRunEvent(initial, created())).toBe(initial);
    expect(() => appendRunEvent(initial, event("run-created", 1, { run: run() }, undefined, "run-created:1")))
      .not.toThrow();
    const changed = { ...created(), occurredAt: "changed" } as Spine.Missions.RunEvent;
    expect(() => appendRunEvent(initial, changed)).toThrow("different facts");
  });

  it("requires a contiguous hash-free event chain and valid transitions", () => {
    const initial = appendRunEvent(undefined, created());
    expect(() => appendRunEvent(initial, event("status-transitioned", 3, { from: "created", to: "running" }, id<"run-event">("event-1"))))
      .toThrow("contiguous");
    expect(() => appendRunEvent(initial, event("status-transitioned", 2, { from: "created", to: "completed" }, id<"run-event">("event-1"))))
      .toThrow("transition is invalid");
  });

  it("binds checkpoints to an earlier durable event and advances recovery attempts", () => {
    const initial = appendRunEvent(undefined, created());
    const checkpoint = event("checkpoint-created", 2, {
      checkpoint: {
        kind: "automatic", attemptNumber: 1, createdAt: "t2",
        replayBoundary: { durableThroughSequence: 1, resumeAfterEventId: id<"run-event">("event-1"), completedPlanStepKeys: [], completedWorkerIds: [], committedEffectKeys: [] },
        stateStorage: "portable-redacted", stateReference: "checkpoint:1", stateHash: "hash",
        executionNodeId: id<"execution-node">("local")
      }
    }, id<"run-event">("event-1"));
    const saved = appendRunEvent(initial, checkpoint);
    const restored = appendRunEvent(saved, event("checkpoint-restored", 3, {
      checkpointEventId: id<"run-event">("event-2"), newAttemptNumber: 2
    }, id<"run-event">("event-2")));
    expect(restored.run.currentAttemptNumber).toBe(2);
    expect(restored.latestCheckpointEvent?.id).toBe("event-2");
  });

  it("schedules one bounded same-run retry only from the exact retryable failed attempt", () => {
    const running = appendRunEvent(
      appendRunEvent(undefined, created()),
      event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1"))
    );
    const checkpoint = event("checkpoint-created", 3, {
      checkpoint: {
        kind: "automatic", attemptNumber: 1, createdAt: "t3",
        replayBoundary: { durableThroughSequence: 2, resumeAfterEventId: id<"run-event">("event-2"), completedPlanStepKeys: [], completedWorkerIds: [], committedEffectKeys: [] },
        stateStorage: "portable-redacted", stateReference: "checkpoint:retry", stateHash: "hash-retry",
        executionNodeId: id<"execution-node">("local"), pendingWaitKey: "accept-draft-1"
      }
    }, id<"run-event">("event-2"));
    const saved = appendRunEvent(running, checkpoint);
    const error: Spine.Missions.ContractError = {
      code: "provider-temporarily-unavailable", category: "provider",
      message: "Provider temporarily unavailable.", retryable: true
    };
    const attempt: Spine.Missions.RunAttempt = {
      runId: id<"run">("run-1"), attemptNumber: 1, status: "failed", retryReason: error,
      selectedPlacement: { executionNodeId: id<"execution-node">("local"), selectedAt: "t2", reason: "Local desktop" },
      finishedAt: "t4"
    };
    const finished = { ...event("attempt-finished", 4, { attempt }, id<"run-event">("event-3")), attemptNumber: 1 } as Spine.Missions.RunEvent;
    const failedAttempt = appendRunEvent(saved, finished);
    const scheduledEvent = { ...event("retry-scheduled", 5, { nextAttemptNumber: 2, error }, id<"run-event">("event-4")), attemptNumber: 1 } as Spine.Missions.RunEvent;
    const scheduled = appendRunEvent(failedAttempt, scheduledEvent);
    expect(scheduled.run.status).toBe("retrying");
    expect(scheduled.run.currentAttemptNumber).toBeUndefined();
    const restored = appendRunEvent(scheduled, event("checkpoint-restored", 6, {
      checkpointEventId: id<"run-event">("event-3"), newAttemptNumber: 2
    }, id<"run-event">("event-5")));
    expect(restored.run).toMatchObject({ status: "running", currentAttemptNumber: 2 });

    const changedError = { ...error, code: "another-error" };
    const changedRetry = { ...event("retry-scheduled", 5, { nextAttemptNumber: 2, error: changedError }, id<"run-event">("event-4")), attemptNumber: 1 } as Spine.Missions.RunEvent;
    expect(() => appendRunEvent(failedAttempt, changedRetry)).toThrow("exact retryable failed attempt");
    const overBudget = { ...event("retry-scheduled", 5, { nextAttemptNumber: 3, error }, id<"run-event">("event-4")), attemptNumber: 1 } as Spine.Missions.RunEvent;
    expect(() => appendRunEvent(failedAttempt, overBudget)).toThrow("within budget");
  });

  it("makes terminal cancellation immutable and preserves the exact request", () => {
    const initial = appendRunEvent(undefined, created());
    const running = appendRunEvent(initial, event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1")));
    const cancellation: Spine.Missions.CancellationRequest = {
      requestKey: "stop-1", requestedAt: "t3", requestedByInternalUserId: id<"internal-user">("user-1"),
      scope: "run", mode: "cooperative"
    };
    const requested = appendRunEvent(running, event("cancellation-requested", 3, { cancellation }, id<"run-event">("event-2")));
    expect(() => appendRunEvent(requested, event("cancellation-requested", 4, { cancellation: { ...cancellation, requestKey: "stop-2" } }, id<"run-event">("event-3"))))
      .toThrow("already has a cancellation");
    const cancelled = appendRunEvent(requested, event("run-cancelled", 4, { cancellation }, id<"run-event">("event-3")));
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.run.cancellation?.requestKey).toBe("stop-1");
    expect(() => appendRunEvent(cancelled, event("worker-progressed", 5, { workerId: id<"worker">("worker-1"), summary: "late" }, id<"run-event">("event-4"))))
      .toThrow("terminal run journal is immutable");
  });

  it("waits on one checkpoint-bound approval and resolves only the exact proposal", () => {
    const running = appendRunEvent(
      appendRunEvent(undefined, created()),
      event("status-transitioned", 2, { from: "created", to: "running" }, id<"run-event">("event-1"))
    );
    const checkpoint = event("checkpoint-created", 3, {
      checkpoint: {
        kind: "wait-boundary", attemptNumber: 1, createdAt: "t3",
        replayBoundary: { durableThroughSequence: 2, resumeAfterEventId: id<"run-event">("event-2"), completedPlanStepKeys: [], completedWorkerIds: [], committedEffectKeys: [] },
        stateStorage: "portable-redacted", stateReference: "checkpoint:approval", stateHash: "hash-approval",
        pendingWaitKey: "accept-draft-1",
        executionNodeId: id<"execution-node">("local")
      }
    }, id<"run-event">("event-2"));
    const saved = appendRunEvent(running, checkpoint);
    const wait: Spine.Missions.ApprovalWait = {
      waitKey: "accept-draft-1", status: "pending", approvalRequestRef: "mission-approval:1",
      proposalHash: "proposal-hash-1", actionSummary: "Save this cited brief as an accepted artifact.",
      requestedAt: "t4", workerId: id<"worker">("worker-1")
    };
    const waiting = appendRunEvent(saved, event("approval-requested", 4, { wait }, id<"run-event">("event-3")));
    expect(waiting.run.status).toBe("waiting-approval");
    expect(() => appendRunEvent(waiting, event("approval-requested", 5, { wait: { ...wait, waitKey: "another" } }, id<"run-event">("event-4"))))
      .toThrow("one exact pending proposal");

    const wrongHash = event("approval-resolved", 5, { resolution: {
      waitKey: wait.waitKey, decision: "approved", decidedAt: "t5", acceptedProposalHash: "changed"
    } }, id<"run-event">("event-4"));
    expect(() => appendRunEvent(waiting, wrongHash)).toThrow("exact active proposal");
    const resolved = appendRunEvent(waiting, event("approval-resolved", 5, { resolution: {
      waitKey: wait.waitKey, decision: "approved", decidedAt: "t5", acceptedProposalHash: wait.proposalHash
    } }, id<"run-event">("event-4")));
    expect(resolved.run.status).toBe("running");
  });

  it("waits for one checkpoint-bound human-input schema and resumes from its exact response", () => {
    const saved = savedHumanInputBoundary();
    const wait = humanInputWait();
    const requestedEvent = event("human-input-requested", 4, { wait }, id<"run-event">("event-3"));
    const waiting = appendRunEvent(saved, requestedEvent);
    expect(waiting.run.status).toBe("waiting-human-input");
    expect(appendRunEvent(waiting, requestedEvent)).toBe(waiting);

    const changedRequest = { ...requestedEvent, occurredAt: "changed" } as Spine.Missions.RunEvent;
    expect(() => appendRunEvent(waiting, changedRequest)).toThrow("different facts");
    expect(() => appendRunEvent(waiting, event("human-input-requested", 5, { wait }, id<"run-event">("event-4"))))
      .toThrow("one valid pending schema");

    const resolution = humanInputResolution();
    const receivedEvent = event("human-input-received", 5, { resolution }, id<"run-event">("event-4"));
    const resumed = appendRunEvent(waiting, receivedEvent);
    expect(resumed.run.status).toBe("running");
    expect(appendRunEvent(resumed, receivedEvent)).toBe(resumed);

    const alternative = event("human-input-received", 5, {
      resolution: humanInputResolution([
        { fieldKey: "title", value: "Changed answer" },
        ...resolution.values.slice(1)
      ])
    }, id<"run-event">("event-4"));
    expect(() => appendRunEvent(resumed, alternative)).toThrow("different facts");

    const changedArtifact = event("human-input-received", 5, {
      resolution: humanInputResolution(resolution.values.map((input) => input.fieldKey === "source"
        ? { ...input, value: {
            artifactId: id<"artifact">("artifact-1"),
            artifactVersionId: id<"artifact-version">("artifact-version-2"),
            contentHash: { algorithm: "sha-256" as const, value: "b".repeat(64) }
          } }
        : input))
    }, id<"run-event">("event-4"));
    expect(() => appendRunEvent(resumed, changedArtifact)).toThrow("different facts");
  });

  it("rejects unbounded, ambiguous, or unsupported human-input schemas", () => {
    const saved = savedHumanInputBoundary();
    const wait = humanInputWait();
    const first = wait.fields[0]!;
    const invalidWaits: readonly Spine.Missions.HumanInputWait[] = [
      { ...wait, waitKey: "another-wait" },
      { ...wait, fields: [] },
      { ...wait, fields: Array.from({ length: 9 }, (_, index) => ({ ...first, key: `field-${index}` })) },
      { ...wait, fields: [...wait.fields, { ...first }] },
      { ...wait, fields: [{ ...first, sensitive: true }] },
      { ...wait, fields: [{ key: "format", label: "Format", kind: "choice", choices: ["only"], required: true, sensitive: false }] },
      { ...wait, fields: [{ key: "format", label: "Format", kind: "choice", choices: ["same", "same"], required: true, sensitive: false }] },
      { ...wait, fields: [{ ...first, choices: ["not-allowed"] }] },
      { ...wait, fields: [{ ...first, help: "h".repeat(501) } as Spine.Missions.HumanInputField] }
    ];
    for (const invalid of invalidWaits) {
      expect(() => appendRunEvent(saved, event("human-input-requested", 4, { wait: invalid }, id<"run-event">("event-3"))))
        .toThrow("one valid pending schema");
    }
  });

  it("requires the exact human-input field set and bounded values", () => {
    const saved = savedHumanInputBoundary();
    const wait = humanInputWait();
    const waiting = appendRunEvent(saved, event("human-input-requested", 4, { wait }, id<"run-event">("event-3")));
    const valid = humanInputResolution().values;
    const artifact = humanInputArtifactReference();
    const invalidResolutions: readonly Spine.Missions.HumanInputResolution[] = [
      { ...humanInputResolution(), waitKey: "wrong-wait" },
      humanInputResolution(valid.filter((input) => input.fieldKey !== "title")),
      humanInputResolution([...valid, { fieldKey: "unknown", value: "extra" }]),
      humanInputResolution([{ fieldKey: "title", value: "one" }, { fieldKey: "title", value: "two" }, ...valid.slice(1)]),
      humanInputResolution([{ fieldKey: "title", value: "x".repeat(4_001) }, ...valid.slice(1)]),
      humanInputResolution([valid[0]!, { fieldKey: "count", value: Number.POSITIVE_INFINITY }, ...valid.slice(2)]),
      humanInputResolution([valid[0]!, valid[1]!, { fieldKey: "confirmed", value: "true" }, ...valid.slice(3)] as readonly Spine.Missions.HumanInputValue[]),
      humanInputResolution([...valid.slice(0, 3), { fieldKey: "format", value: "memo" }, ...valid.slice(4)]),
      humanInputResolution([...valid.slice(0, 4), { fieldKey: "due-at", value: "tomorrow" }, ...valid.slice(5)]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: "artifact-1" }]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        artifactId: artifact.artifactId,
        artifactVersionId: artifact.artifactVersionId
      } } as unknown as Spine.Missions.HumanInputValue]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact, artifactId: id<"artifact">("")
      } }]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact, artifactVersionId: id<"artifact-version">("v".repeat(201))
      } }]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact, contentHash: { algorithm: "sha-256", value: "A".repeat(64) }
      } }]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact, contentHash: { algorithm: "sha-256", value: "a".repeat(63) }
      } }]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact,
        contentHash: { algorithm: "sha-512", value: "a".repeat(64) }
      } } as unknown as Spine.Missions.HumanInputValue]),
      humanInputResolution([...valid.slice(0, 5), { fieldKey: "source", value: {
        ...artifact,
        extra: true
      } } as unknown as Spine.Missions.HumanInputValue]),
      humanInputResolution([{ fieldKey: "title", value: null }, ...valid.slice(1)])
    ];
    for (const invalid of invalidResolutions) {
      expect(() => appendRunEvent(waiting, event("human-input-received", 5, { resolution: invalid }, id<"run-event">("event-4"))))
        .toThrow("matching its schema");
    }
  });

  it("allows cancellation while waiting for human input and keeps the terminal journal immutable", () => {
    const saved = savedHumanInputBoundary();
    const waiting = appendRunEvent(saved, event("human-input-requested", 4, { wait: humanInputWait() }, id<"run-event">("event-3")));
    const cancellation: Spine.Missions.CancellationRequest = {
      requestKey: "stop-human-wait", requestedAt: "t5", requestedByInternalUserId: id<"internal-user">("user-1"),
      scope: "run", mode: "cooperative"
    };
    const cancelling = appendRunEvent(waiting, event("cancellation-requested", 5, { cancellation }, id<"run-event">("event-4")));
    const cancelled = appendRunEvent(cancelling, event("run-cancelled", 6, { cancellation }, id<"run-event">("event-5")));
    expect(cancelled.run.status).toBe("cancelled");
    expect(() => appendRunEvent(cancelled, event("human-input-received", 7, {
      resolution: humanInputResolution()
    }, id<"run-event">("event-6")))).toThrow("terminal run journal is immutable");
  });

  it("opens one bounded join from exact started plan workers and resolves from terminal facts", () => {
    const base = startedWorkers();
    const join = openJoin();
    const openedEvent = event("join-opened", 7, { join }, id<"run-event">("event-6"));
    const opened = appendRunEvent(base, openedEvent);
    expect(appendRunEvent(opened, openedEvent)).toBe(opened);

    const first = appendRunEvent(opened, event("worker-completed", 8, {
      workerId: id<"worker">("worker-1"), outputs: []
    }, id<"run-event">("event-7")));
    expect(() => appendRunEvent(first, event("join-resolved", 9, {
      join: { ...join, status: "satisfied", satisfiedWorkerIds: [id<"worker">("worker-1")] }
    }, id<"run-event">("event-8")))).toThrow("strategy is satisfied");

    const both = appendRunEvent(first, event("worker-completed", 9, {
      workerId: id<"worker">("worker-2"), outputs: []
    }, id<"run-event">("event-8")));
    expect(() => appendRunEvent(both, event("join-resolved", 10, {
      join: { ...join, status: "satisfied", strategy: "any", satisfiedWorkerIds: join.workerIds }
    }, id<"run-event">("event-9")))).toThrow("exact active join");
    const resolvedEvent = event("join-resolved", 10, {
      join: { ...join, status: "satisfied", satisfiedWorkerIds: join.workerIds }
    }, id<"run-event">("event-9"));
    const resolved = appendRunEvent(both, resolvedEvent);
    expect(appendRunEvent(resolved, resolvedEvent)).toBe(resolved);
    expect(() => appendRunEvent(resolved, {
      ...resolvedEvent, payload: { join: { ...join, status: "satisfied", satisfiedWorkerIds: join.workerIds, strategy: "any" } }
    } as Spine.Missions.RunEvent)).toThrow("different facts");
    expect(replayRunJournal(resolved.events)).toEqual(resolved);
  });

  it("rejects invalid, duplicate, over-budget, or concurrently open join definitions", () => {
    const base = startedWorkers();
    const invalid: readonly Spine.Missions.WorkerJoin[] = [
      openJoin({ status: "satisfied" }),
      openJoin({ strategy: "quorum" }),
      openJoin({ strategy: "quorum", quorum: 0 }),
      openJoin({ strategy: "quorum", quorum: 3 }),
      openJoin({ strategy: "all", quorum: 1 }),
      openJoin({ workerIds: [id<"worker">("worker-1"), id<"worker">("worker-1")] }),
      openJoin({ workerIds: [] }),
      openJoin({ satisfiedWorkerIds: [id<"worker">("worker-1")] }),
      openJoin({ failedWorkerIds: [id<"worker">("worker-2")] }),
      openJoin({ deadline: "not-a-date" })
    ];
    for (const join of invalid) {
      expect(() => appendRunEvent(base, event("join-opened", 7, { join }, id<"run-event">("event-6"))))
        .toThrow("valid bounded multi-worker definition");
    }

    const overBudget = startedWorkers(worker("worker-1"), worker("worker-2"), multiWorkerRun({ budget: { maxWorkers: 1 } }));
    expect(() => appendRunEvent(overBudget, event("join-opened", 7, { join: openJoin() }, id<"run-event">("event-6"))))
      .toThrow("valid bounded multi-worker definition");

    const opened = appendRunEvent(base, event("join-opened", 7, { join: openJoin() }, id<"run-event">("event-6")));
    expect(() => appendRunEvent(opened, event("join-opened", 8, {
      join: openJoin({ joinKey: "join-another" })
    }, id<"run-event">("event-7")))).toThrow("only one worker join can be open");
    const cancelled = appendRunEvent(opened, event("join-resolved", 8, {
      join: { ...openJoin(), status: "cancelled" }
    }, id<"run-event">("event-7")));
    expect(() => appendRunEvent(cancelled, event("join-opened", 9, { join: openJoin() }, id<"run-event">("event-8"))))
      .toThrow("join key is immutable");
  });

  it("rejects unstarted, foreign, out-of-plan, and multiply-created members", () => {
    const complete = startedWorkers();
    const unstarted = replayRunJournal(complete.events.slice(0, -1));
    const variants: readonly [string, ReturnType<typeof startedWorkers>][] = [
      ["started worker-created", unstarted],
      ["run scope", startedWorkers(worker("worker-1"), worker("worker-2", { runId: id<"run">("foreign-run") }))],
      ["run scope", startedWorkers(worker("worker-1"), worker("worker-2", { workspaceId: id<"workspace">("foreign-workspace") }))],
      ["selected plan revision", startedWorkers(worker("worker-1"), worker("worker-2", { planRevisionId: id<"plan-revision">("old-revision") }))],
      ["selected plan revision", startedWorkers(worker("worker-1"), worker("worker-2", { planStepKey: undefined }))],
      ["started worker-created", complete]
    ];
    for (const [message, base] of variants) {
      const sequence = base.run.eventHead.lastSequence + 1;
      const join = base === complete
        ? openJoin({ workerIds: [id<"worker">("worker-1"), id<"worker">("worker-3")] })
        : openJoin();
      expect(() => appendRunEvent(base, event("join-opened", sequence, { join }, base.run.eventHead.lastEventId)))
        .toThrow(message);
    }

    const duplicate = appendRunEvent(complete, event("worker-created", 7, {
      worker: worker("worker-2")
    }, id<"run-event">("event-6")));
    expect(() => appendRunEvent(duplicate, event("join-opened", 8, { join: openJoin() }, id<"run-event">("event-7"))))
      .toThrow("one unique worker-created fact");

    const startedTwice = appendRunEvent(complete, event("worker-started", 7, {
      workerId: id<"worker">("worker-2")
    }, id<"run-event">("event-6")));
    expect(() => appendRunEvent(startedTwice, event("join-opened", 8, { join: openJoin() }, id<"run-event">("event-7"))))
      .toThrow("one unique worker-started fact");
  });

  it("derives failure sets and applies tolerant and strict join strategies", () => {
    const base = startedWorkers();
    const join = openJoin({ strategy: "quorum", quorum: 1, allowFailedWorkers: true });
    const opened = appendRunEvent(base, event("join-opened", 7, { join }, id<"run-event">("event-6")));
    const failed = appendRunEvent(opened, event("worker-failed", 8, {
      workerId: id<"worker">("worker-1"), error: workerError()
    }, id<"run-event">("event-7")));
    const mixed = appendRunEvent(failed, event("worker-completed", 9, {
      workerId: id<"worker">("worker-2"), outputs: []
    }, id<"run-event">("event-8")));
    const exact = { ...join, status: "satisfied" as const,
      satisfiedWorkerIds: [id<"worker">("worker-2")], failedWorkerIds: [id<"worker">("worker-1")] };
    expect(() => appendRunEvent(mixed, event("join-resolved", 10, {
      join: { ...exact, satisfiedWorkerIds: join.workerIds }
    }, id<"run-event">("event-9")))).toThrow("derived exactly");
    expect(appendRunEvent(mixed, event("join-resolved", 10, { join: exact }, id<"run-event">("event-9"))).events)
      .toHaveLength(10);

    const strictJoin = openJoin({ strategy: "any", allowFailedWorkers: false });
    const strictOpened = appendRunEvent(base, event("join-opened", 7, { join: strictJoin }, id<"run-event">("event-6")));
    const strictFailed = appendRunEvent(strictOpened, event("worker-failed", 8, {
      workerId: id<"worker">("worker-1"), error: workerError()
    }, id<"run-event">("event-7")));
    const strictMixed = appendRunEvent(strictFailed, event("worker-completed", 9, {
      workerId: id<"worker">("worker-2"), outputs: []
    }, id<"run-event">("event-8")));
    expect(() => appendRunEvent(strictMixed, event("join-resolved", 10, {
      join: { ...strictJoin, status: "satisfied", satisfiedWorkerIds: [id<"worker">("worker-2")], failedWorkerIds: [id<"worker">("worker-1")] }
    }, id<"run-event">("event-9")))).toThrow("strategy is satisfied");
  });

  it("allows timeout only at the immutable deadline", () => {
    const base = startedWorkers();
    const join = openJoin({ deadline: "2026-07-15T12:00:00Z" });
    const opened = appendRunEvent(base, event("join-opened", 7, { join }, id<"run-event">("event-6")));
    const resolution = { ...join, status: "timed-out" as const };
    const early = { ...event("join-resolved", 8, { join: resolution }, id<"run-event">("event-7")),
      occurredAt: "2026-07-15T11:59:59Z" } as Spine.Missions.RunEvent;
    expect(() => appendRunEvent(opened, early)).toThrow("at or after its declared deadline");
    const onTime = { ...event("join-resolved", 8, { join: resolution }, id<"run-event">("event-7")),
      occurredAt: "2026-07-15T12:00:00Z" } as Spine.Missions.RunEvent;
    expect(appendRunEvent(opened, onTime).events.at(-1)).toEqual(onTime);

    const noDeadlineJoin = openJoin();
    const noDeadlineOpen = appendRunEvent(base, event("join-opened", 7, { join: noDeadlineJoin }, id<"run-event">("event-6")));
    expect(() => appendRunEvent(noDeadlineOpen, event("join-resolved", 8, {
      join: { ...noDeadlineJoin, status: "timed-out" }
    }, id<"run-event">("event-7")))).toThrow("declared deadline");
  });

  it("records only an exact deterministic aggregation over terminal worker outputs", () => {
    const left = worker("worker-1", {
      outputContract: {
        slots: [{ key: "left", description: "Left result", required: true }],
        includeEvidence: false,
        includeUncertainty: true,
        delivery: "join"
      }
    });
    const right = worker("worker-2", {
      outputContract: {
        slots: [{ key: "right", description: "Right result", required: true }],
        includeEvidence: false,
        includeUncertainty: true,
        delivery: "join"
      }
    });
    const started = startedWorkers(left, right);
    const leftOutput: Spine.Missions.ProducedOutput = {
      key: "left", summary: "Left output is available.",
      valueReference: "mission-output:v1:left"
    };
    const rightOutput: Spine.Missions.ProducedOutput = {
      key: "right", summary: "Right output is available.",
      valueReference: "mission-output:v1:right"
    };
    const join = openJoin();
    const opened = appendRunEvent(started, event("join-opened", 7, {
      join
    }, id<"run-event">("event-6")));
    const first = appendRunEvent(opened, event("worker-completed", 8, {
      workerId: left.id, outputs: [leftOutput]
    }, id<"run-event">("event-7")));
    const settled = appendRunEvent(first, event("worker-completed", 9, {
      workerId: right.id, outputs: [rightOutput]
    }, id<"run-event">("event-8")));
    const joined = appendRunEvent(settled, event("join-resolved", 10, {
      join: { ...join, status: "satisfied", satisfiedWorkerIds: join.workerIds }
    }, id<"run-event">("event-9")));
    const aggregation: Spine.Missions.DeterministicAggregationReceipt = {
      version: 1,
      strategy: "ordered-manifest-v1",
      stepKey: "combine",
      status: "complete",
      inputs: [
        { sourceStepKey: "step-worker-1", workerId: left.id, status: "completed", outputs: [leftOutput] },
        { sourceStepKey: "step-worker-2", workerId: right.id, status: "completed", outputs: [rightOutput] }
      ],
      producedOutputs: [leftOutput, rightOutput],
      missingRequiredOutputKeys: []
    };
    const recorded = appendRunEvent(joined, event("aggregation-recorded", 11, {
      aggregation
    }, id<"run-event">("event-10")));
    expect(recorded.events.at(-1)?.type).toBe("aggregation-recorded");

    expect(() => appendRunEvent(joined, event("aggregation-recorded", 11, {
      aggregation: { ...aggregation, producedOutputs: [rightOutput, leftOutput] }
    }, id<"run-event">("event-10")))).toThrow("derived exactly");
    expect(() => appendRunEvent(recorded, event("aggregation-recorded", 12, {
      aggregation
    }, id<"run-event">("event-11")))).toThrow("immutable");

    expect(() => appendRunEvent(settled, event("aggregation-recorded", 10, {
      aggregation
    }, id<"run-event">("event-9")))).toThrow("satisfied dependency join");
  });

  it("records one exact reviewer selection before reviewer execution", () => {
    const producer = worker("worker-1");
    const reviewer = worker("reviewer-1", {
      planStepKey: "review",
      role: {
        kind: "reviewer",
        title: "Reviewer",
        objective: "Review the declared evidence.",
        responsibilities: ["Review the declared evidence."]
      }
    });
    const running = replayRunJournal([
      event("run-created", 1, {
        run: multiWorkerRun({ budget: { maxWorkers: 2, maxAttempts: 2 } })
      }),
      event(
        "status-transitioned",
        2,
        { from: "created", to: "running" },
        id<"run-event">("event-1")
      ),
      event("worker-created", 3, { worker: producer }, id<"run-event">("event-2")),
      event("worker-created", 4, { worker: reviewer }, id<"run-event">("event-3"))
    ]);
    const selection: Spine.Missions.MissionReviewerSelection = {
      reviewStepKey: "review",
      reviewerWorkerId: reviewer.id,
      justification: ["declared-worker-acceptance"],
      criterionKeys: ["quality"],
      authority: "declared-worker-evaluator",
      policyRef: "native-policy:mission-review:v1"
    };
    const selected = appendRunEvent(
      running,
      event(
        "reviewer-selected",
        5,
        { selection },
        id<"run-event">("event-4")
      )
    );
    expect(selected.events.at(-1)?.payload).toEqual({ selection });
    expect(() =>
      appendRunEvent(
        selected,
        event(
          "reviewer-selected",
          6,
          { selection },
          id<"run-event">("event-5")
        )
      )
    ).toThrow("one exact declared reviewer");

    const started = appendRunEvent(
      running,
      event(
        "worker-started",
        5,
        { workerId: reviewer.id },
        id<"run-event">("event-4")
      )
    );
    expect(() =>
      appendRunEvent(
        started,
        event(
          "reviewer-selected",
          6,
          { selection },
          id<"run-event">("event-5")
        )
      )
    ).toThrow("one exact declared reviewer");

    const advisory: Spine.Missions.MissionReviewerSelection = {
      reviewStepKey: "review",
      reviewerWorkerId: reviewer.id,
      justification: ["user-requested-advisory"],
      criterionKeys: [],
      authority: "advisory",
      policyRef: "native-policy:mission-advisory-review:v1"
    };
    expect(appendRunEvent(
      running,
      event(
        "reviewer-selected",
        5,
        { selection: advisory },
        id<"run-event">("event-4")
      )
    ).events.at(-1)?.payload).toEqual({ selection: advisory });
    expect(() => appendRunEvent(
      running,
      event(
        "reviewer-selected",
        5,
        { selection: { ...advisory, criterionKeys: ["human-only"] } },
        id<"run-event">("event-4")
      )
    )).toThrow("one exact declared reviewer");
  });

  it("can cancel the exact active join while its run is cancelling", () => {
    const join = openJoin();
    const opened = appendRunEvent(startedWorkers(), event("join-opened", 7, { join }, id<"run-event">("event-6")));
    const cancellation: Spine.Missions.CancellationRequest = {
      requestKey: "cancel-parallel-run", requestedAt: "t8", scope: "run", mode: "cooperative"
    };
    const cancelling = appendRunEvent(opened, event("cancellation-requested", 8, {
      cancellation
    }, id<"run-event">("event-7")));
    expect(appendRunEvent(cancelling, event("join-resolved", 9, {
      join: { ...join, status: "cancelled" }
    }, id<"run-event">("event-8"))).events).toHaveLength(9);
  });
});
