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

  it("makes terminal cancellation immutable and preserves the exact request", () => {
    const initial = appendRunEvent(undefined, created());
    const cancellation: Spine.Missions.CancellationRequest = {
      requestKey: "stop-1", requestedAt: "t2", requestedByInternalUserId: id<"internal-user">("user-1"),
      scope: "run", mode: "cooperative"
    };
    const requested = appendRunEvent(initial, event("cancellation-requested", 2, { cancellation }, id<"run-event">("event-1")));
    const cancelled = appendRunEvent(requested, event("run-cancelled", 3, { cancellation }, id<"run-event">("event-2")));
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.run.cancellation?.requestKey).toBe("stop-1");
    expect(() => appendRunEvent(cancelled, event("worker-progressed", 4, { workerId: id<"worker">("worker-1"), summary: "late" }, id<"run-event">("event-3"))))
      .toThrow("terminal run journal is immutable");
  });
});
