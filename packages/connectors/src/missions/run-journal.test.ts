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
      { key: "due-at", label: "Due at", kind: "date-time", required: true, sensitive: false }
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

function humanInputResolution(values: readonly Spine.Missions.HumanInputValue[] = [
  { fieldKey: "title", value: "Quarterly research brief" },
  { fieldKey: "count", value: 3 },
  { fieldKey: "confirmed", value: true },
  { fieldKey: "format", value: "brief" },
  { fieldKey: "due-at", value: "2026-07-31T16:30:00Z" }
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
      { ...wait, fields: [{ ...first, kind: "artifact" }] },
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
    const invalidResolutions: readonly Spine.Missions.HumanInputResolution[] = [
      { ...humanInputResolution(), waitKey: "wrong-wait" },
      humanInputResolution(valid.filter((input) => input.fieldKey !== "title")),
      humanInputResolution([...valid, { fieldKey: "unknown", value: "extra" }]),
      humanInputResolution([{ fieldKey: "title", value: "one" }, { fieldKey: "title", value: "two" }, ...valid.slice(1)]),
      humanInputResolution([{ fieldKey: "title", value: "x".repeat(4_001) }, ...valid.slice(1)]),
      humanInputResolution([valid[0]!, { fieldKey: "count", value: Number.POSITIVE_INFINITY }, ...valid.slice(2)]),
      humanInputResolution([valid[0]!, valid[1]!, { fieldKey: "confirmed", value: "true" }, ...valid.slice(3)] as readonly Spine.Missions.HumanInputValue[]),
      humanInputResolution([...valid.slice(0, 3), { fieldKey: "format", value: "memo" }, valid[4]!]),
      humanInputResolution([...valid.slice(0, 4), { fieldKey: "due-at", value: "tomorrow" }]),
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
});
