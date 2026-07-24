import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  aggregateMissionOutputs,
  compileMissionCoordination,
  evaluateMissionCoordination
} from "./coordination";

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

function mission(maxWorkers = 6): Spine.Missions.Mission {
  return {
    ...scope,
    id: "mission-1" as never,
    status: "ready",
    executionDepth: "multi-worker",
    outcome: {
      title: "Compare evidence",
      desiredOutcome: "Compare three sources",
      deliverables: [
        { key: "a", description: "A", required: true, format: "text/markdown" },
        { key: "b", description: "B", required: true, format: "text/markdown" },
        { key: "c", description: "C", required: true, format: "text/markdown" }
      ]
    },
    scope: { departmentIds: [], context: [] },
    constraints: [],
    acceptance: { criteria: [], requiresHumanAcceptance: false },
    budget: { maxWorkers },
    currentPlanId: "plan-1" as never,
    currentPlanRevisionId: "revision-1" as never
  };
}

function plan(): Spine.Missions.PlanRevision {
  return {
    ...scope,
    id: "revision-1" as never,
    planId: "plan-1" as never,
    missionId: "mission-1" as never,
    planRevisionNumber: 1,
    reason: "initial",
    summary: "Three producers, any-source review, deterministic aggregate",
    bounds: {
      maxSteps: 5,
      maxDependenciesPerStep: 3,
      maxParallelSteps: 3,
      maxRevisions: 1
    },
    steps: [
      step("source-a", "produce", [], "a"),
      step("source-b", "produce", [], "b"),
      step("source-c", "produce", [], "c"),
      step("review", "review", ["source-a", "source-b", "source-c"], "review"),
      step("aggregate", "coordinate", ["source-a", "source-b", "source-c"], "manifest")
    ]
  };
}

function step(
  key: string,
  kind: Spine.Missions.PlanStepKind,
  dependsOnStepKeys: readonly string[],
  outputKey: string
): Spine.Missions.PlanStep {
  return {
    key,
    kind,
    title: key,
    objective: key,
    dependsOnStepKeys,
    requiredCapabilities: [],
    expectedOutputs: [
      {
        key: outputKey,
        description: outputKey,
        required: true,
        format: "text/markdown"
      }
    ],
    acceptanceCriterionKeys: [],
    optional: false
  };
}

function worker(stepKey: string, outputKey = stepKey): Spine.Missions.Worker {
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
    capabilityIds: [],
    capabilityGrantIds: [],
    tools: [],
    budget: { maxAttempts: 1 },
    stopConditions: [],
    outputContract: {
      slots: [
        {
          key: outputKey,
          description: outputKey,
          required: true,
          format: "text/markdown"
        }
      ],
      includeEvidence: false,
      includeUncertainty: true,
      delivery: stepKey === "review" ? "join" : "run-result"
    }
  };
}

function graph(reviewAllowFailedWorkers = true) {
  return compileMissionCoordination({
    mission: mission(),
    planRevision: plan(),
    workers: [
      worker("source-a", "a"),
      worker("source-b", "b"),
      worker("source-c", "c"),
      worker("review", "review")
    ],
    joins: [
      {
        joinKey: "review-any",
        targetStepKey: "review",
        sourceStepKeys: ["source-a", "source-b", "source-c"],
        strategy: "any",
        allowFailedWorkers: reviewAllowFailedWorkers
      },
      {
        joinKey: "aggregate-all",
        targetStepKey: "aggregate",
        sourceStepKeys: ["source-a", "source-b", "source-c"],
        strategy: "all",
        allowFailedWorkers: true
      }
    ],
    aggregations: [
      {
        stepKey: "aggregate",
        sourceStepKeys: ["source-a", "source-b", "source-c"],
        strategy: "ordered-manifest-v1"
      }
    ]
  });
}

describe("general mission coordination", () => {
  it("schedules arbitrary bounded roots and evaluates explicit any/all joins", () => {
    const compiled = graph();
    expect(
      evaluateMissionCoordination({
        graph: compiled,
        workerStates: {
          "worker-source-a": "pending",
          "worker-source-b": "pending",
          "worker-source-c": "pending",
          "worker-review": "pending"
        }
      })
    ).toMatchObject({
      readyWorkerIds: ["worker-source-a", "worker-source-b", "worker-source-c"],
      readyAggregationStepKeys: [],
      waitingStepKeys: ["review", "aggregate"],
      blocked: []
    });

    expect(
      evaluateMissionCoordination({
        graph: compiled,
        workerStates: {
          "worker-source-a": "completed",
          "worker-source-b": "running",
          "worker-source-c": "failed",
          "worker-review": "pending"
        }
      })
    ).toMatchObject({
      readyWorkerIds: ["worker-review"],
      readyAggregationStepKeys: [],
      runningWorkerIds: ["worker-source-b"],
      waitingStepKeys: ["aggregate"],
      blocked: []
    });

    expect(
      evaluateMissionCoordination({
        graph: compiled,
        workerStates: {
          "worker-source-a": "completed",
          "worker-source-b": "completed",
          "worker-source-c": "failed",
          "worker-review": "completed"
        }
      })
    ).toMatchObject({
      readyWorkerIds: [],
      readyAggregationStepKeys: ["aggregate"],
      waitingStepKeys: [],
      blocked: []
    });
  });

  it("fails closed on implicit multi-dependency joins and changed graph authority", () => {
    expect(() =>
      compileMissionCoordination({
        mission: mission(),
        planRevision: plan(),
        workers: [
          worker("source-a", "a"),
          worker("source-b", "b"),
          worker("source-c", "c"),
          worker("review", "review")
        ],
        joins: [],
        aggregations: [
          {
            stepKey: "aggregate",
            sourceStepKeys: ["source-a", "source-b", "source-c"],
            strategy: "ordered-manifest-v1"
          }
        ]
      })
    ).toThrow("explicit dependency join");

    expect(() =>
      compileMissionCoordination({
        mission: mission(),
        planRevision: { ...plan(), workspaceId: "other" as never },
        workers: [],
        joins: []
      })
    ).toThrow("authority scope");
  });

  it("blocks joins that can no longer meet their declared strategy", () => {
    const compiled = graph(false);
    const decision = evaluateMissionCoordination({
      graph: compiled,
      workerStates: {
        "worker-source-a": "failed",
        "worker-source-b": "pending",
        "worker-source-c": "pending",
        "worker-review": "pending"
      }
    });
    expect(decision.blocked).toEqual([
      {
        stepKey: "review",
        reason: "Its declared dependencies cannot satisfy the required join."
      }
    ]);
  });

  it("aggregates only exact ordered worker outputs without inventing acceptance", () => {
    const receipt = aggregateMissionOutputs(graph(), "aggregate", [
      {
        sourceStepKey: "source-c",
        workerId: "worker-source-c" as never,
        status: "failed",
        outputs: []
      },
      {
        sourceStepKey: "source-a",
        workerId: "worker-source-a" as never,
        status: "completed",
        outputs: [{ key: "a", summary: "A", valueReference: "output:a" }]
      },
      {
        sourceStepKey: "source-b",
        workerId: "worker-source-b" as never,
        status: "completed",
        outputs: [{ key: "b", summary: "B", valueReference: "output:b" }]
      }
    ]);
    expect(receipt).toEqual({
      version: 1,
      strategy: "ordered-manifest-v1",
      stepKey: "aggregate",
      status: "partial",
      inputs: expect.arrayContaining([
        expect.objectContaining({ sourceStepKey: "source-a" }),
        expect.objectContaining({ sourceStepKey: "source-b" }),
        expect.objectContaining({ sourceStepKey: "source-c" })
      ]),
      producedOutputs: [
        { key: "a", summary: "A", valueReference: "output:a" },
        { key: "b", summary: "B", valueReference: "output:b" }
      ],
      missingRequiredOutputKeys: ["c"]
    });
    expect(receipt.inputs.map((input) => input.sourceStepKey)).toEqual([
      "source-a",
      "source-b",
      "source-c"
    ]);

    expect(() =>
      aggregateMissionOutputs(graph(), "aggregate", [
        {
          sourceStepKey: "source-a",
          workerId: "worker-source-a" as never,
          status: "completed",
          outputs: [{ key: "invented", summary: "No", valueReference: "output:no" }]
        },
        {
          sourceStepKey: "source-b",
          workerId: "worker-source-b" as never,
          status: "completed",
          outputs: []
        },
        {
          sourceStepKey: "source-c",
          workerId: "worker-source-c" as never,
          status: "completed",
          outputs: []
        }
      ])
    ).toThrow("declared by their exact source worker");
  });
});
