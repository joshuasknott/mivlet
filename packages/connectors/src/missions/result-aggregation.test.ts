import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  aggregateMissionOutputs,
  compileMissionCoordination
} from "./coordination";
import {
  finalizeMissionGraphResult,
  MissionResultAggregationError,
  type MissionWorkerResult
} from "./result-aggregation";

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

function mission(
  acceptance: Spine.Missions.Mission["acceptance"] = {
    requiresHumanAcceptance: false,
    criteria: [{
      key: "grounded",
      description: "The final brief retains exact evidence.",
      required: true,
      evaluator: "policy",
      evidenceRequired: ["source-1"]
    }]
  }
): Spine.Missions.Mission {
  return {
    ...scope,
    id: "mission-1" as never,
    status: "running",
    executionDepth: "multi-worker",
    outcome: {
      title: "Bounded brief",
      desiredOutcome: "Produce one accepted brief.",
      deliverables: [{
        key: "final",
        description: "the final cited brief",
        required: true
      }]
    },
    scope: { departmentIds: [], context: [] },
    constraints: [],
    acceptance,
    budget: { maxWorkers: 3 },
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
    summary: "Two approaches, one reviewer, and one deterministic manifest.",
    bounds: {
      maxSteps: 4,
      maxDependenciesPerStep: 2,
      maxParallelSteps: 2,
      maxRevisions: 1
    },
    steps: [
      step("a", "produce", [], "draft-a"),
      step("b", "produce", [], "draft-b"),
      step("review", "review", ["a", "b"], "final"),
      step("aggregate", "coordinate", ["review"], "final")
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
    expectedOutputs: [{
      key: outputKey,
      description: outputKey,
      required: true,
      format: "text/markdown"
    }],
    acceptanceCriterionKeys: key === "review" ? ["grounded"] : [],
    optional: false
  };
}

function worker(stepKey: string, outputKey: string): Spine.Missions.Worker {
  return {
    ...scope,
    id: `worker-${stepKey}` as never,
    runId: "run-1" as never,
    status: "completed",
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
      slots: [{
        key: outputKey,
        description: outputKey,
        required: true,
        format: "text/markdown"
      }],
      includeEvidence: stepKey === "review",
      includeUncertainty: true,
      delivery: "run-result"
    }
  };
}

function fixture(
  acceptance?: Spine.Missions.Mission["acceptance"]
) {
  const selectedMission = mission(acceptance);
  const workers = [
    worker("a", "draft-a"),
    worker("b", "draft-b"),
    worker("review", "final")
  ];
  const graph = compileMissionCoordination({
    mission: selectedMission,
    planRevision: plan(),
    workers,
    joins: [{
      joinKey: "review-any",
      targetStepKey: "review",
      sourceStepKeys: ["a", "b"],
      strategy: "any",
      allowFailedWorkers: false
    }],
    aggregations: [{
      stepKey: "aggregate",
      sourceStepKeys: ["review"],
      strategy: "ordered-manifest-v1"
    }]
  });
  return { selectedMission, workers, graph };
}

function runResult(
  workerId: string,
  outcome: Spine.Missions.RunOutcomeKind,
  outputs: readonly Spine.Missions.ProducedOutput[],
  evaluations: readonly Spine.Missions.EvaluationResult[] = []
): Spine.Missions.RunResult {
  return {
    outcome,
    summary: `${workerId} ${outcome}`,
    outputs,
    acceptance: [],
    evaluations,
    usage: [{
      usageKey: `usage-${workerId}`,
      runId: "run-1" as never,
      workerId: workerId as never,
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: 0,
      costs: [],
      measuredAt: "2026-07-23T10:01:00.000Z"
    }],
    ...(outcome === "failed" ? {
      error: {
        code: "worker-failed",
        category: "provider" as const,
        message: "The worker failed.",
        retryable: false
      }
    } : {}),
    completedAt: "2026-07-23T10:01:00.000Z"
  };
}

function successfulResults(): MissionWorkerResult[] {
  const evaluation: Spine.Missions.EvaluationResult = {
    evaluationKey: "evaluation-grounded",
    target: { kind: "worker", workerId: "worker-review" as never },
    verdict: "pass",
    criteria: [{
      criterionKey: "grounded",
      passed: true,
      summary: "Exact source evidence is retained.",
      evidenceRefs: ["source-1"]
    }],
    summary: "The policy check passed.",
    evaluatedAt: "2026-07-23T10:01:00.000Z"
  };
  return [
    {
      workerId: "worker-a" as never,
      result: runResult("worker-a", "succeeded", [{
        key: "draft-a",
        summary: "Approach A",
        valueReference: "output:a"
      }])
    },
    {
      workerId: "worker-b" as never,
      result: runResult("worker-b", "failed", [])
    },
    {
      workerId: "worker-review" as never,
      result: runResult("worker-review", "succeeded", [{
        key: "final",
        summary: "Final cited brief",
        valueReference: "output:final"
      }], [evaluation])
    }
  ];
}

describe("general mission result aggregation", () => {
  it("accepts an exact aggregate despite a non-required sibling failure", () => {
    const { selectedMission, graph } = fixture();
    const results = successfulResults();
    const receipt = aggregateMissionOutputs(graph, "aggregate", [{
      sourceStepKey: "review",
      workerId: "worker-review" as never,
      status: "completed",
      outputs: results[2]!.result.outputs
    }]);

    const result = finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      aggregationReceipts: [receipt],
      outputSelections: [{
        deliverableKey: "final",
        source: {
          kind: "aggregation",
          stepKey: "aggregate",
          outputKey: "final"
        }
      }],
      completedAt: "2026-07-23T10:02:00.000Z"
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      producingRunIds: ["run-1"],
      outputs: [{
        key: "final",
        valueReference: "output:final"
      }],
      acceptance: [{
        criterionKey: "grounded",
        status: "met",
        evidenceRefs: ["source-1"]
      }]
    });
    expect(result.partial).toBeUndefined();
  });

  it("preserves exact outputs as partial until identified human acceptance", () => {
    const humanAcceptance: Spine.Missions.Mission["acceptance"] = {
      requiresHumanAcceptance: true,
      criteria: [{
        key: "grounded",
        description: "The owner accepts the final brief.",
        required: true,
        evaluator: "human"
      }]
    };
    const { selectedMission, graph } = fixture(humanAcceptance);
    const results = successfulResults().map((value) => ({
      ...value,
      result: { ...value.result, evaluations: [] }
    }));

    const result = finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      outputSelections: [{
        deliverableKey: "final",
        source: {
          kind: "worker",
          workerId: "worker-review" as never,
          outputKey: "final"
        }
      }],
      completedAt: "2026-07-23T10:02:00.000Z"
    });

    expect(result).toMatchObject({
      outcome: "partial",
      partial: {
        recoverable: true,
        recommendedNextAction: "human-review",
        completedOutputs: [{ key: "final" }]
      },
      acceptance: [{ status: "not-evaluated" }]
    });
  });

  it("does not promote a partial worker result into mission success", () => {
    const { selectedMission, graph } = fixture();
    const results = successfulResults();
    results[2] = {
      ...results[2]!,
      result: {
        ...results[2]!.result,
        outcome: "partial"
      }
    };
    const receipt = aggregateMissionOutputs(graph, "aggregate", [{
      sourceStepKey: "review",
      workerId: "worker-review" as never,
      status: "completed",
      outputs: results[2]!.result.outputs
    }]);

    const result = finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      aggregationReceipts: [receipt],
      outputSelections: [{
        deliverableKey: "final",
        source: {
          kind: "aggregation",
          stepKey: "aggregate",
          outputKey: "final"
        }
      }],
      completedAt: "2026-07-23T10:02:00.000Z"
    });

    expect(result).toMatchObject({
      outcome: "partial",
      outputs: [{ key: "final" }]
    });
  });

  it("reports cancellation without inventing useful work", () => {
    const { selectedMission, graph } = fixture();
    const results = ["worker-a", "worker-b", "worker-review"].map(
      (workerId) => ({
        workerId: workerId as Spine.Primitives.WorkerId,
        result: runResult(workerId, "cancelled", [])
      })
    );

    const result = finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    });

    expect(result).toMatchObject({
      outcome: "cancelled",
      outputs: [],
      acceptance: [{ status: "not-evaluated" }]
    });
    expect(result.partial).toBeUndefined();
  });

  it("rejects missing workers, forged receipts, and foreign evaluation authority", () => {
    const { selectedMission, graph } = fixture();
    const results = successfulResults();
    expect(() => finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results.slice(1),
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("every graph worker");

    const receipt = aggregateMissionOutputs(graph, "aggregate", [{
      sourceStepKey: "review",
      workerId: "worker-review" as never,
      status: "completed",
      outputs: results[2]!.result.outputs
    }]);
    expect(() => finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      aggregationReceipts: [{ ...receipt, status: "partial" }],
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("does not match");

    const inventedReceipt = aggregateMissionOutputs(graph, "aggregate", [{
      sourceStepKey: "review",
      workerId: "worker-review" as never,
      status: "completed",
      outputs: [{
        key: "final",
        summary: "Invented final",
        valueReference: "output:invented"
      }]
    }]);
    expect(() => finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      aggregationReceipts: [inventedReceipt],
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("exact durable worker results");

    const forgedResults = successfulResults();
    forgedResults[2] = {
      ...forgedResults[2]!,
      result: {
        ...forgedResults[2]!.result,
        evaluations: [{
          ...forgedResults[2]!.result.evaluations[0]!,
          target: { kind: "worker", workerId: "worker-foreign" as never }
        }]
      }
    };
    expect(() => finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: forgedResults,
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("exact graph worker");
  });

  it("rejects unattested external and unknown worker reviewer claims", () => {
    const workerAcceptance: Spine.Missions.Mission["acceptance"] = {
      requiresHumanAcceptance: false,
      criteria: [{
        key: "grounded",
        description: "A declared reviewer accepts the final brief.",
        required: true,
        evaluator: "worker"
      }]
    };
    const { selectedMission, graph } = fixture(workerAcceptance);
    const results = successfulResults();
    results[2] = {
      ...results[2]!,
      result: {
        ...results[2]!.result,
        evaluations: [{
          ...results[2]!.result.evaluations[0]!,
          reviewerWorkerId: "worker-foreign" as never
        }]
      }
    };
    expect(() => finalizeMissionGraphResult({
      mission: selectedMission,
      graph,
      workerResults: results,
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("exact reviewer");

    const externalAcceptance: Spine.Missions.Mission["acceptance"] = {
      requiresHumanAcceptance: false,
      criteria: [{
        key: "grounded",
        description: "An external system accepts the final brief.",
        required: true,
        evaluator: "external"
      }]
    };
    const externalFixture = fixture(externalAcceptance);
    expect(() => finalizeMissionGraphResult({
      mission: externalFixture.selectedMission,
      graph: externalFixture.graph,
      workerResults: successfulResults(),
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow("attested evaluator");
  });

  it("exposes a specific aggregation error type", () => {
    const { selectedMission, graph } = fixture();
    expect(() => finalizeMissionGraphResult({
      mission: { ...selectedMission, id: "mission-other" as never },
      graph,
      workerResults: successfulResults(),
      outputSelections: [],
      completedAt: "2026-07-23T10:02:00.000Z"
    })).toThrow(MissionResultAggregationError);
  });
});
