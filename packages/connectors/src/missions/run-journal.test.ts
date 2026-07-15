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
});
