import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import { decideMissionReviewer } from "./reviewer-selection";

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

function mission(withWorkerCriterion = true): Spine.Missions.Mission {
  return {
    ...scope,
    id: "mission-1" as never,
    status: "ready",
    executionDepth: "multi-worker",
    outcome: { title: "Review", desiredOutcome: "Review bounded work.", deliverables: [] },
    scope: { departmentIds: [], context: [] },
    constraints: [],
    acceptance: {
      criteria: withWorkerCriterion
        ? [{
            key: "quality",
            description: "Compare the approaches.",
            required: true,
            evaluator: "worker"
          }]
        : [],
      requiresHumanAcceptance: false
    },
    currentPlanId: "plan-1" as never,
    currentPlanRevisionId: "revision-1" as never
  };
}

function step(
  key: string,
  kind: Spine.Missions.PlanStepKind,
  acceptanceCriterionKeys: readonly string[] = []
): Spine.Missions.PlanStep {
  return {
    key,
    kind,
    title: key,
    objective: key,
    dependsOnStepKeys: [],
    requiredCapabilities: [],
    expectedOutputs: [],
    acceptanceCriterionKeys,
    optional: false
  };
}

function plan(includeReview = true): Spine.Missions.PlanRevision {
  return {
    ...scope,
    id: "revision-1" as never,
    planId: "plan-1" as never,
    missionId: "mission-1" as never,
    planRevisionNumber: 1,
    reason: "initial",
    summary: "Review only when justified.",
    bounds: {
      maxSteps: 2,
      maxDependenciesPerStep: 1,
      maxParallelSteps: 1,
      maxRevisions: 1
    },
    steps: [
      step("produce", "produce"),
      ...(includeReview ? [step("review", "review", ["quality"])] : [])
    ]
  };
}

function reviewer(overrides: Partial<Spine.Missions.Worker> = {}): Spine.Missions.Worker {
  return {
    ...scope,
    id: "reviewer-1" as never,
    runId: "run-1" as never,
    status: "proposed",
    role: {
      kind: "reviewer",
      title: "Reviewer",
      objective: "Compare",
      responsibilities: ["Compare"]
    },
    planRevisionId: "revision-1" as never,
    planStepKey: "review",
    context: [],
    capabilityIds: [],
    capabilityGrantIds: [],
    tools: [],
    budget: { maxAttempts: 1 },
    stopConditions: [],
    outputContract: {
      slots: [],
      includeEvidence: false,
      includeUncertainty: true,
      delivery: "run-result"
    },
    ...overrides
  };
}

const policy = {
  policyRef: "native-policy:mission-review:v1",
  risk: "low" as const,
  conflictingEvidenceRefs: [] as string[]
};

describe("mission reviewer selection", () => {
  it("selects one exact reviewer for declared worker acceptance", () => {
    expect(decideMissionReviewer({
      mission: mission(),
      planRevision: plan(),
      workers: [reviewer()],
      policy
    })).toEqual({
      status: "ready",
      reviewStepKey: "review",
      reviewerWorkerId: "reviewer-1",
      justification: ["declared-worker-acceptance"],
      criterionKeys: ["quality"],
      authority: "declared-worker-evaluator"
    });
  });

  it("requires a Plan revision instead of inventing a missing reviewer step", () => {
    expect(decideMissionReviewer({
      mission: mission(),
      planRevision: plan(false),
      workers: [],
      policy
    })).toMatchObject({ status: "revise-plan", reason: "missing-review-step" });
  });

  it("does not add an ungrounded reviewer", () => {
    const noReviewMission = mission(false);
    expect(decideMissionReviewer({
      mission: noReviewMission,
      planRevision: { ...plan(false), missionId: noReviewMission.id },
      workers: [],
      policy
    })).toEqual({ status: "not-required", reason: "no-declared-justification" });
    expect(() => decideMissionReviewer({
      mission: noReviewMission,
      planRevision: plan(),
      workers: [reviewer()],
      policy
    })).toThrow("no declared acceptance, risk, or conflict justification");
  });

  it("justifies an advisory review from exact high-risk policy evidence", () => {
    const highRiskMission = mission(false);
    const highRiskPlan = {
      ...plan(),
      missionId: highRiskMission.id,
      steps: [step("produce", "produce"), step("review", "review")]
    };
    expect(decideMissionReviewer({
      mission: highRiskMission,
      planRevision: highRiskPlan,
      workers: [reviewer()],
      policy: { ...policy, risk: "high" }
    })).toMatchObject({
      status: "ready",
      justification: ["high-risk-policy"],
      authority: "advisory"
    });
  });

  it("rejects substituted reviewer scope and unbound criteria", () => {
    expect(() => decideMissionReviewer({
      mission: mission(),
      planRevision: {
        ...plan(),
        steps: [step("produce", "produce"), step("review", "review", [])]
      },
      workers: [reviewer()],
      policy
    })).toThrow("bind exactly");
    expect(() => decideMissionReviewer({
      mission: mission(),
      planRevision: plan(),
      workers: [reviewer({ workspaceId: "other" as never })],
      policy
    })).toThrow("scope-matched");
  });
});
