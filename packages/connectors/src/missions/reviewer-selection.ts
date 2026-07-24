import type { Spine } from "@fable/protocol";

export interface MissionReviewPolicyEvidence {
  policyRef: string;
  risk: "low" | "medium" | "high" | "critical";
  conflictingEvidenceRefs: readonly string[];
}

export interface DecideMissionReviewerInput {
  mission: Spine.Missions.Mission;
  planRevision: Spine.Missions.PlanRevision;
  workers: readonly Spine.Missions.Worker[];
  policy: MissionReviewPolicyEvidence;
}

export type MissionReviewerDecision =
  | {
      status: "not-required";
      reason: "no-declared-justification";
    }
  | {
      status: "revise-plan";
      reason: "missing-review-step" | "missing-reviewer-assignment";
      justification: readonly string[];
      criterionKeys: readonly string[];
    }
  | {
      status: "ready";
      reviewStepKey: string;
      reviewerWorkerId: Spine.Primitives.WorkerId;
      justification: readonly string[];
      criterionKeys: readonly string[];
      authority: "declared-worker-evaluator" | "advisory";
    };

export class MissionReviewerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionReviewerSelectionError";
  }
}

/**
 * Require a reviewer only when selected Plan criteria or immutable policy
 * evidence justify one. This chooses no provider and grants no acceptance beyond
 * the Plan's explicitly worker-evaluated criteria.
 */
export function decideMissionReviewer(
  input: DecideMissionReviewerInput
): MissionReviewerDecision {
  validateAuthority(input.mission, input.planRevision);
  validatePolicy(input.policy);
  const workerCriterionKeys = input.mission.acceptance.criteria
    .filter((criterion) => criterion.evaluator === "worker")
    .map((criterion) => criterion.key);
  const justification = [
    ...(workerCriterionKeys.length > 0 ? ["declared-worker-acceptance"] : []),
    ...(input.policy.risk === "high" || input.policy.risk === "critical"
      ? ["high-risk-policy"]
      : []),
    ...(input.policy.conflictingEvidenceRefs.length > 0
      ? ["conflicting-evidence"]
      : [])
  ];
  const reviewSteps = input.planRevision.steps.filter((step) => step.kind === "review");
  if (reviewSteps.length > 1) {
    throw new MissionReviewerSelectionError(
      "A selected Plan can declare at most one dynamically justified review step."
    );
  }
  if (justification.length === 0) {
    if (reviewSteps.length > 0) {
      throw new MissionReviewerSelectionError(
        "The selected review step has no declared acceptance, risk, or conflict justification."
      );
    }
    return { status: "not-required", reason: "no-declared-justification" };
  }
  const reviewStep = reviewSteps[0];
  if (!reviewStep) {
    return {
      status: "revise-plan",
      reason: "missing-review-step",
      justification,
      criterionKeys: workerCriterionKeys
    };
  }
  const declaredKeys = [...reviewStep.acceptanceCriterionKeys];
  if (
    new Set(declaredKeys).size !== declaredKeys.length ||
    declaredKeys.some((key) => !workerCriterionKeys.includes(key)) ||
    workerCriterionKeys.some((key) => !declaredKeys.includes(key))
  ) {
    throw new MissionReviewerSelectionError(
      "The review step must bind exactly the Mission's worker-evaluated criteria."
    );
  }
  const workersByStep = input.workers.filter(
    (worker) => worker.planStepKey === reviewStep.key
  );
  if (workersByStep.length > 1) {
    throw new MissionReviewerSelectionError(
      "The review step has ambiguous reviewer assignments."
    );
  }
  const reviewer = workersByStep[0];
  if (!reviewer) {
    return {
      status: "revise-plan",
      reason: "missing-reviewer-assignment",
      justification,
      criterionKeys: workerCriterionKeys
    };
  }
  if (
    reviewer.planRevisionId !== input.planRevision.id ||
    reviewer.role.kind !== "reviewer" ||
    !sameScope(input.mission, reviewer) ||
    input.workers.some(
      (worker) =>
        worker.id === reviewer.id && worker.planStepKey !== reviewStep.key
    )
  ) {
    throw new MissionReviewerSelectionError(
      "The reviewer must be one exact scope-matched reviewer worker in the selected Plan."
    );
  }
  return {
    status: "ready",
    reviewStepKey: reviewStep.key,
    reviewerWorkerId: reviewer.id,
    justification,
    criterionKeys: workerCriterionKeys,
    authority:
      workerCriterionKeys.length > 0 ? "declared-worker-evaluator" : "advisory"
  };
}

function validateAuthority(
  mission: Spine.Missions.Mission,
  revision: Spine.Missions.PlanRevision
): void {
  if (
    mission.currentPlanRevisionId !== revision.id ||
    revision.missionId !== mission.id ||
    !sameScope(mission, revision)
  ) {
    throw new MissionReviewerSelectionError(
      "Reviewer selection requires the Mission's exact selected Plan revision and scope."
    );
  }
}

function validatePolicy(policy: MissionReviewPolicyEvidence): void {
  if (
    !policy.policyRef.startsWith("native-policy:") ||
    policy.policyRef.length > 240 ||
    new Set(policy.conflictingEvidenceRefs).size !==
      policy.conflictingEvidenceRefs.length ||
    policy.conflictingEvidenceRefs.length > 32 ||
    policy.conflictingEvidenceRefs.some(
      (reference) =>
        !reference.trim() ||
        reference.length > 240 ||
        [...reference].some((character) => character < " ")
    )
  ) {
    throw new MissionReviewerSelectionError(
      "Reviewer justification requires bounded immutable policy evidence."
    );
  }
}

function sameScope(
  left: Pick<
    Spine.Primitives.ScopedRecordMetadata,
    "workspaceId" | "authority" | "schemaVersion" | "visibility" | "ownerMemberId"
  >,
  right: Pick<
    Spine.Primitives.ScopedRecordMetadata,
    "workspaceId" | "authority" | "schemaVersion" | "visibility" | "ownerMemberId"
  >
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.authority === right.authority &&
    left.schemaVersion === right.schemaVersion &&
    left.visibility === right.visibility &&
    (left.visibility !== "member-private" ||
      (right.visibility === "member-private" &&
        left.ownerMemberId === right.ownerMemberId))
  );
}
