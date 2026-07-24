import { describe, expect, it, vi } from "vitest";
import type { Spine } from "@fable/protocol";
import { compileMissionCoordination } from "./coordination";
import {
  MissionGraphRunnerError,
  runMissionGraph,
  type DurableMissionGraphSnapshot
} from "./graph-runner";

const scope = {
  workspaceId: "workspace-1" as never,
  visibility: "member-private" as const,
  ownerMemberId: "member-1" as never,
  authority: "local" as const,
  schemaVersion: 1,
  revision: 1,
  createdByInternalUserId: "user-1" as never,
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z"
};

function step(
  key: string,
  kind: Spine.Missions.PlanStepKind,
  dependencies: readonly string[]
): Spine.Missions.PlanStep {
  return {
    key,
    kind,
    title: key,
    objective: key,
    dependsOnStepKeys: dependencies,
    requiredCapabilities: [],
    expectedOutputs: [{
      key: `output-${key}`,
      description: key,
      required: true,
      format: "text/markdown"
    }],
    acceptanceCriterionKeys: [],
    optional: false
  };
}

function worker(stepKey: string, toolBearing = false): Spine.Missions.Worker {
  return {
    ...scope,
    id: `worker-${stepKey}` as never,
    runId: "run-1" as never,
    status: "proposed",
    role: {
      kind: stepKey === "review" ? "reviewer" : "specialist",
      title: stepKey,
      objective: stepKey,
      responsibilities: [stepKey]
    },
    planRevisionId: "revision-1" as never,
    planStepKey: stepKey,
    context: [],
    capabilityIds: toolBearing ? ["knowledge.content.search" as never] : [],
    capabilityGrantIds: toolBearing ? ["grant-c" as never] : [],
    tools: toolBearing ? [{
      toolName: "connection-read",
      access: "read",
      purpose: "Read exact connected evidence.",
      required: true
    }] : [],
    budget: { maxAttempts: 1 },
    stopConditions: [],
    outputContract: {
      slots: [{
        key: `output-${stepKey}`,
        description: stepKey,
        required: true,
        format: "text/markdown"
      }],
      includeEvidence: toolBearing,
      includeUncertainty: true,
      delivery: "run-result"
    }
  };
}

function graph() {
  const mission: Spine.Missions.Mission = {
    ...scope,
    id: "mission-1" as never,
    status: "ready",
    executionDepth: "multi-worker",
    outcome: {
      title: "General graph",
      desiredOutcome: "Run a bounded dependency graph.",
      deliverables: []
    },
    scope: { departmentIds: [], context: [] },
    constraints: [],
    acceptance: { criteria: [], requiresHumanAcceptance: false },
    budget: { maxWorkers: 4 },
    currentPlanId: "plan-1" as never,
    currentPlanRevisionId: "revision-1" as never
  };
  const planRevision: Spine.Missions.PlanRevision = {
    ...scope,
    id: "revision-1" as never,
    planId: "plan-1" as never,
    missionId: mission.id,
    planRevisionNumber: 1,
    reason: "initial",
    summary: "Three roots, an any-source reviewer, and an all-source aggregate.",
    bounds: {
      maxSteps: 5,
      maxDependenciesPerStep: 3,
      maxParallelSteps: 2,
      maxRevisions: 1
    },
    steps: [
      step("a", "produce", []),
      step("b", "produce", []),
      step("c", "investigate", []),
      step("review", "review", ["a", "b"]),
      step("aggregate", "coordinate", ["a", "b", "c"])
    ]
  };
  return compileMissionCoordination({
    mission,
    planRevision,
    workers: [worker("a"), worker("b"), worker("c", true), worker("review")],
    joins: [
      {
        joinKey: "review-any",
        targetStepKey: "review",
        sourceStepKeys: ["a", "b"],
        strategy: "any",
        allowFailedWorkers: false
      },
      {
        joinKey: "aggregate-all",
        targetStepKey: "aggregate",
        sourceStepKeys: ["a", "b", "c"],
        strategy: "all",
        allowFailedWorkers: false
      }
    ],
    aggregations: [{
      stepKey: "aggregate",
      sourceStepKeys: ["a", "b", "c"],
      strategy: "ordered-manifest-v1"
    }]
  });
}

function initialSnapshot(): DurableMissionGraphSnapshot {
  return {
    workerStates: {
      "worker-a": "pending",
      "worker-b": "pending",
      "worker-c": "pending",
      "worker-review": "pending"
    },
    completedAggregationStepKeys: [],
    cancellationRequested: false
  };
}

describe("general mission graph runner", () => {
  it("reacts to individual completions, honors width, and starts an any-join before its sibling ends", async () => {
    const state = initialSnapshot();
    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => { releaseB = resolve; });
    let active = 0;
    let maximumActive = 0;
    const launchOrder: string[] = [];
    let reviewStartedWhileBRunning = false;
    const settledJoins: string[] = [];

    const result = await runMissionGraph({
      graph: graph(),
      callbacks: {
        loadSnapshot: async () => structuredClone(state),
        settleJoin: async (join) => {
          settledJoins.push(join.joinKey);
          if (join.joinKey === "review-any") {
            return state.workerStates["worker-a"] === "completed" ? "satisfied" : "waiting";
          }
          return ["worker-a", "worker-b", "worker-c"].every(
            (id) => state.workerStates[id] === "completed"
          ) ? "satisfied" : "waiting";
        },
        executeWorker: async (assigned) => {
          const id = assigned.id;
          launchOrder.push(id);
          (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[id] = "running";
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (id === "worker-b") await holdB;
          if (id === "worker-review") {
            reviewStartedWhileBRunning = state.workerStates["worker-b"] === "running";
            releaseB();
          }
          if (id === "worker-c") {
            expect(assigned.tools).toEqual([
              expect.objectContaining({ toolName: "connection-read", access: "read" })
            ]);
          }
          (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[id] = "completed";
          active -= 1;
        },
        recordAggregation: async (stepKey) => {
          (state.completedAggregationStepKeys as string[]).push(stepKey);
        },
        requestCancellation: async () => {
          state.cancellationRequested = true;
        }
      }
    });

    expect(result.status).toBe("complete");
    expect(result.launchedWorkerIds).toEqual([
      "worker-a",
      "worker-b",
      "worker-c",
      "worker-review"
    ]);
    expect(result.recordedAggregationStepKeys).toEqual(["aggregate"]);
    expect(new Set(settledJoins)).toEqual(new Set(["review-any", "aggregate-all"]));
    expect(maximumActive).toBe(2);
    expect(reviewStartedWhileBRunning).toBe(true);
    expect(launchOrder.indexOf("worker-review")).toBeLessThan(
      launchOrder.indexOf("worker-b") + 3
    );
  });

  it("persists cancellation before aborting active worker execution", async () => {
    const state = initialSnapshot();
    const controller = new AbortController();
    let observedDurableCancellation = false;
    const started = vi.fn();

    const execution = runMissionGraph({
      graph: graph(),
      signal: controller.signal,
      callbacks: {
        loadSnapshot: async () => structuredClone(state),
        settleJoin: async () => "waiting",
        executeWorker: async (assigned, signal) => {
          started(assigned.id);
          (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[assigned.id] = "running";
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              observedDurableCancellation = state.cancellationRequested;
              (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[assigned.id] = "cancelled";
              resolve();
            }, { once: true });
          });
        },
        recordAggregation: async () => undefined,
        requestCancellation: async () => {
          state.cancellationRequested = true;
        }
      }
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    controller.abort("User stopped the mission.");

    await expect(execution).resolves.toMatchObject({ status: "cancelled" });
    expect(observedDurableCancellation).toBe(true);
  });

  it("rejects callbacks that return or fail without a durable terminal fact", async () => {
    const state = initialSnapshot();
    await expect(runMissionGraph({
      graph: graph(),
      callbacks: {
        loadSnapshot: async () => structuredClone(state),
        settleJoin: async () => "waiting",
        executeWorker: async (assigned) => {
          (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[assigned.id] = "running";
          throw new Error("provider disappeared");
        },
        recordAggregation: async () => undefined,
        requestCancellation: async () => {
          state.cancellationRequested = true;
        }
      }
    })).rejects.toThrow(
      "failed without recording a durable terminal fact"
    );
  });

  it("fails closed when a durable snapshot substitutes graph workers", async () => {
    const state = initialSnapshot();
    (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)["worker-invented"] = "completed";
    await expect(runMissionGraph({
      graph: graph(),
      callbacks: {
        loadSnapshot: async () => state,
        settleJoin: async () => "waiting",
        executeWorker: async () => undefined,
        recordAggregation: async () => undefined,
        requestCancellation: async () => undefined
      }
    })).rejects.toBeInstanceOf(MissionGraphRunnerError);
  });

  it("resumes after a durable wait without replaying already terminal workers", async () => {
    const state = initialSnapshot();
    (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)["worker-a"] = "waiting";
    (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)["worker-b"] = "completed";
    (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)["worker-c"] = "completed";
    const executed: string[] = [];
    const callbacks = {
      loadSnapshot: async () => structuredClone(state),
      settleJoin: async (join: { joinKey: string }) => {
        if (join.joinKey === "review-any") return "satisfied" as const;
        return state.workerStates["worker-a"] === "completed"
          ? "satisfied" as const
          : "waiting" as const;
      },
      executeWorker: async (assigned: Spine.Missions.Worker) => {
        executed.push(assigned.id);
        (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)[assigned.id] =
          "completed";
      },
      recordAggregation: async (stepKey: string) => {
        (state.completedAggregationStepKeys as string[]).push(stepKey);
      },
      requestCancellation: async () => {
        state.cancellationRequested = true;
      }
    };

    await expect(runMissionGraph({ graph: graph(), callbacks })).resolves.toMatchObject({
      status: "waiting",
      launchedWorkerIds: ["worker-review"]
    });
    expect(executed).toEqual(["worker-review"]);

    (state.workerStates as Record<string, Spine.Missions.WorkerStatus>)["worker-a"] =
      "completed";
    await expect(runMissionGraph({ graph: graph(), callbacks })).resolves.toMatchObject({
      status: "complete",
      launchedWorkerIds: [],
      recordedAggregationStepKeys: ["aggregate"]
    });
    expect(executed).toEqual(["worker-review"]);
  });
});
