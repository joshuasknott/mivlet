import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Spine } from "@fable/protocol";
import { executeRuntimeMissionGraph } from "./runtime-mission-graph";

const mocks = vi.hoisted(() => ({
  lifecycle: null as Record<string, unknown> | null,
  journal: null as Record<string, unknown> | null,
  advance: vi.fn(),
  cancel: vi.fn()
}));

vi.mock("../runtime", () => ({
  getRuntimeMissionRun: vi.fn(async () => mocks.journal),
  getRuntimeMissionPlan: vi.fn(async () => mocks.lifecycle),
  advanceRuntimeMissionCoordination: mocks.advance,
  requestRuntimeMissionRunCancellation: mocks.cancel
}));

function metadata() {
  return {
    workspaceId: "workspace-1",
    visibility: "member-private",
    ownerMemberId: "member-1",
    authority: "local",
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "user-1",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z"
  } as const;
}

function worker(id: string, stepKey: string): Spine.Missions.Worker {
  return {
    ...metadata(),
    id: id as Spine.Primitives.WorkerId,
    runId: "run-1" as Spine.Primitives.RunId,
    status: "proposed",
    role: {
      kind: "specialist",
      title: stepKey,
      objective: `Complete ${stepKey}.`,
      responsibilities: [`Complete ${stepKey}.`]
    },
    planRevisionId: "revision-1" as Spine.Primitives.PlanRevisionId,
    planStepKey: stepKey,
    context: [],
    capabilityIds: [],
    capabilityGrantIds: [],
    tools: [],
    budget: { maxAttempts: 1 },
    stopConditions: [],
    outputContract: {
      slots: [{ key: stepKey, description: stepKey, required: true }],
      includeEvidence: false,
      includeUncertainty: true,
      delivery: "run-result"
    }
  } as unknown as Spine.Missions.Worker;
}

function installFixture() {
  const workerA = worker("worker-a", "a");
  const workerB = worker("worker-b", "b");
  mocks.lifecycle = {
    mission: {
      ...metadata(),
      id: "mission-1",
      status: "running",
      executionDepth: "multi-worker",
      outcome: {
        title: "Comparison",
        desiredOutcome: "Compare two options.",
        deliverables: [{ key: "final", description: "Comparison", required: true }]
      },
      scope: { departmentIds: [], context: [] },
      constraints: [],
      acceptance: { criteria: [], requiresHumanAcceptance: false },
      budget: { maxWorkers: 2 },
      currentPlanId: "plan-1",
      currentPlanRevisionId: "revision-1"
    },
    plan: {},
    currentRevision: {
      ...metadata(),
      id: "revision-1",
      planId: "plan-1",
      missionId: "mission-1",
      planRevisionNumber: 1,
      reason: "initial",
      summary: "Run two workers and combine exact outputs.",
      bounds: {
        maxSteps: 3,
        maxDependenciesPerStep: 2,
        maxParallelSteps: 2
      },
      steps: [
        {
          key: "a", kind: "produce", title: "A", objective: "Complete A.",
          dependsOnStepKeys: [], requiredCapabilities: [],
          expectedOutputs: [{ key: "a", description: "A", required: true }],
          acceptanceCriterionKeys: [], optional: false
        },
        {
          key: "b", kind: "produce", title: "B", objective: "Complete B.",
          dependsOnStepKeys: [], requiredCapabilities: [],
          expectedOutputs: [{ key: "b", description: "B", required: true }],
          acceptanceCriterionKeys: [], optional: false
        },
        {
          key: "combine", kind: "coordinate", title: "Combine", objective: "Combine.",
          dependsOnStepKeys: ["a", "b"], requiredCapabilities: [],
          expectedOutputs: [{ key: "final", description: "Comparison", required: true }],
          acceptanceCriterionKeys: [], optional: false
        }
      ]
    }
  };
  mocks.journal = {
    run: {
      ...metadata(),
      id: "run-1",
      status: "running",
      executionDepth: "multi-worker",
      initiator: { kind: "mission", missionId: "mission-1" },
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      parentage: { kind: "root" },
      departmentIds: [],
      planRevisionId: "revision-1",
      budget: { maxWorkers: 2 },
      currentAttemptNumber: 1,
      eventHead: { lastSequence: 3, lastEventId: "join-open" }
    },
    events: [
      { id: "worker-a-created", type: "worker-created", payload: { worker: workerA } },
      { id: "worker-b-created", type: "worker-created", payload: { worker: workerB } },
      {
        id: "join-open",
        type: "join-opened",
        payload: {
          join: {
            joinKey: "join-combine",
            targetStepKey: "combine",
            status: "open",
            strategy: "all",
            workerIds: ["worker-a", "worker-b"],
            quorum: null,
            allowFailedWorkers: false,
            deadline: null,
            satisfiedWorkerIds: [],
            failedWorkerIds: []
          }
        }
      }
    ]
  };
  return { workerA, workerB };
}

describe("authenticated runtime Mission graph composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lifecycle = null;
    mocks.journal = null;
    mocks.advance.mockImplementation(async () => {
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const completed = journal.events.filter((event) => event.type === "worker-completed");
      if (completed.length === 2
        && !journal.events.some((event) => event.type === "join-resolved")) {
        journal.events.push({
          id: "join-resolved",
          type: "join-resolved",
          payload: {
            join: {
              joinKey: "join-combine",
              targetStepKey: "combine",
              status: "satisfied",
              strategy: "all",
              workerIds: ["worker-a", "worker-b"],
              quorum: null,
              allowFailedWorkers: false,
              deadline: null,
              satisfiedWorkerIds: ["worker-a", "worker-b"],
              failedWorkerIds: []
            }
          }
        }, {
          id: "aggregation",
          type: "aggregation-recorded",
          payload: {
            aggregation: {
              stepKey: "combine",
              status: "complete",
              producedOutputs: []
            }
          }
        });
      }
      return { journal, progress: {}, appendedEventIds: [] };
    });
    mocks.cancel.mockImplementation(async () => {
      (mocks.journal!.run as Record<string, unknown>).status = "cancelling";
      return mocks.journal;
    });
  });

  it("does not simulate an authenticated graph outside the desktop runtime", async () => {
    await expect(executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker: vi.fn()
    })).resolves.toBeNull();
  });

  it("runs exact durable workers and delegates joins and aggregation back to native", async () => {
    installFixture();
    const executeWorker = vi.fn(async (assigned: Spine.Missions.Worker) => {
      (mocks.journal!.events as Array<Record<string, unknown>>).push({
        id: `${assigned.id}-started`,
        type: "worker-started",
        payload: { workerId: assigned.id }
      }, {
        id: `${assigned.id}-completed`,
        type: "worker-completed",
        payload: {
          workerId: assigned.id,
          outputs: [{
            key: assigned.planStepKey,
            summary: `${assigned.planStepKey} output`,
            valueReference: `mission-output:${assigned.planStepKey}`
          }]
        }
      });
    });
    const result = await executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker
    });
    expect(result).toMatchObject({
      status: "complete",
      launchedWorkerIds: ["worker-a", "worker-b"],
      settledJoinKeys: ["join-combine"],
      recordedAggregationStepKeys: ["combine"]
    });
    expect(executeWorker).toHaveBeenCalledTimes(2);
    expect(mocks.advance).toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("persists cancellation before it asks the worker callback to abort", async () => {
    installFixture();
    const executeWorker = vi.fn();
    const cancellation = new AbortController();
    cancellation.abort();
    const result = await executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker,
      signal: cancellation.signal
    });
    expect(result?.status).toBe("cancelled");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(executeWorker).not.toHaveBeenCalled();
  });

  it("rejects a changed durable join resolution", async () => {
    installFixture();
    (mocks.journal!.events as Array<Record<string, unknown>>).push({
      id: "join-resolved",
      type: "join-resolved",
      payload: {
        join: {
          joinKey: "join-combine",
          targetStepKey: "other-step",
          status: "satisfied",
          strategy: "all",
          workerIds: ["worker-b", "worker-a"],
          quorum: null,
          allowFailedWorkers: false,
          deadline: null,
          satisfiedWorkerIds: ["worker-a", "worker-b"],
          failedWorkerIds: []
        }
      }
    });
    await expect(executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker: vi.fn()
    })).rejects.toThrow("stored Mission join changed its target");
  });
});
