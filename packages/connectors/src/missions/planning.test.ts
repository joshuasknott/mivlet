import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  MissionPlanValidationError,
  createMissionPlan,
  reviseMissionPlan,
  sizeMissionPlan,
  validateGeneratedPlan,
  type GeneratedPlanDraft
} from "./planning";

const id = <Kind extends string>(value: string) => value as Spine.Primitives.FableId<Kind>;

function mission(
  overrides: Partial<Omit<Spine.Missions.Mission, "visibility" | "ownerMemberId">> = {}
): Spine.Missions.Mission {
  return {
    id: id<"mission">("mission-1"),
    workspaceId: id<"workspace">("workspace-1"),
    visibility: "member-private",
    ownerMemberId: id<"member">("member-1"),
    authority: "local",
    schemaVersion: 1,
    revision: 4,
    createdByInternalUserId: id<"internal-user">("user-1"),
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    status: "planning",
    executionDepth: "multi-worker",
    outcome: {
      title: "Trustworthy brief",
      desiredOutcome: "Search connected work sources and produce a trustworthy cited brief.",
      deliverables: [{ key: "brief", description: "Cited brief", required: true }]
    },
    scope: { departmentIds: [], context: [] },
    constraints: [],
    acceptance: {
      requiresHumanAcceptance: false,
      criteria: [{ key: "cited", description: "Claims are cited", required: true, evaluator: "policy" }]
    },
    budget: { maxWorkers: 2, maxToolCalls: 10 },
    ...overrides
  };
}

function draft(overrides: Partial<GeneratedPlanDraft> = {}): GeneratedPlanDraft {
  return {
    summary: "Search independently, then synthesize the evidence.",
    bounds: { maxSteps: 4, maxDependenciesPerStep: 2, maxParallelSteps: 2, maxRevisions: 3 },
    steps: [
      {
        key: "search-drive",
        kind: "investigate",
        title: "Search Drive",
        objective: "Find relevant evidence in Drive.",
        dependsOnStepKeys: [],
        requiredCapabilities: [id<"capability">("connected-source.search")],
        expectedOutputs: [],
        acceptanceCriterionKeys: [],
        optional: false
      },
      {
        key: "search-mcp",
        kind: "investigate",
        title: "Search MCP source",
        objective: "Find relevant evidence through MCP.",
        dependsOnStepKeys: [],
        requiredCapabilities: [id<"capability">("connected-source.search")],
        expectedOutputs: [],
        acceptanceCriterionKeys: [],
        optional: false
      },
      {
        key: "write-brief",
        kind: "produce",
        title: "Write cited brief",
        objective: "Synthesize only supported claims.",
        dependsOnStepKeys: ["search-drive", "search-mcp"],
        requiredCapabilities: [],
        expectedOutputs: [{ key: "brief", description: "Cited brief", required: true }],
        acceptanceCriterionKeys: ["cited"],
        optional: false
      }
    ],
    ...overrides
  };
}

describe("mission generated-plan lifecycle", () => {
  it("sizes useful independent work within mission and plan budgets", () => {
    expect(sizeMissionPlan(mission(), draft())).toEqual({
      executionDepth: "multi-worker",
      workerLimit: 2,
      parallelWidth: 2,
      reasons: ["2 independent steps are available within the 2-worker budget."]
    });
    expect(
      sizeMissionPlan(mission({ executionDepth: "delegated", budget: { maxWorkers: 1 } }), draft())
    ).toMatchObject({ executionDepth: "delegated", workerLimit: 1 });
  });

  it("creates one selected immutable initial revision and advances mission state", () => {
    const result = createMissionPlan({
      mission: mission(),
      planId: id<"plan">("plan-1"),
      revisionId: id<"plan-revision">("plan-revision-1"),
      draft: draft(),
      now: "2026-07-11T01:00:00.000Z"
    });

    expect(result.mission).toMatchObject({
      status: "ready",
      currentPlanId: "plan-1",
      currentPlanRevisionId: "plan-revision-1",
      revision: 5
    });
    expect(result.plan).toMatchObject({ status: "current", currentRevisionNumber: 1, revision: 1 });
    expect(result.currentRevision).toMatchObject({
      reason: "initial",
      planRevisionNumber: 1,
      planId: "plan-1"
    });
    expect(Object.isFrozen(result.currentRevision)).toBe(false);
  });

  it("selects an immutable replacement revision with optimistic concurrency", () => {
    const initial = createMissionPlan({
      mission: mission(),
      planId: id<"plan">("plan-1"),
      revisionId: id<"plan-revision">("revision-1"),
      draft: draft(),
      now: "2026-07-11T01:00:00.000Z"
    });
    const revised = reviseMissionPlan({
      mission: initial.mission,
      plan: initial.plan,
      currentRevision: initial.currentRevision,
      revisionId: id<"plan-revision">("revision-2"),
      reason: "new-evidence",
      draft: draft({ summary: "Use newly connected source evidence." }),
      now: "2026-07-11T02:00:00.000Z",
      expectedPlanRevision: 1
    });

    expect(revised.currentRevision).toMatchObject({
      id: "revision-2",
      supersedesRevisionId: "revision-1",
      planRevisionNumber: 2,
      reason: "new-evidence"
    });
    expect(revised.plan).toMatchObject({ currentRevisionId: "revision-2", currentRevisionNumber: 2, revision: 2 });
    expect(initial.currentRevision.id).toBe("revision-1");
    expect(() => reviseMissionPlan({
      mission: initial.mission,
      plan: initial.plan,
      currentRevision: initial.currentRevision,
      revisionId: id<"plan-revision">("revision-stale"),
      reason: "recovery",
      draft: draft(),
      now: "2026-07-11T03:00:00.000Z",
      expectedPlanRevision: 2
    })).toThrow("changed before this revision");
  });

  it("rejects cycles, missing required outcomes, and excess parallelism", () => {
    const invalid = draft({
      bounds: { maxSteps: 4, maxDependenciesPerStep: 2, maxParallelSteps: 1 },
      steps: [
        { ...draft().steps[0], dependsOnStepKeys: ["search-mcp"] },
        { ...draft().steps[1], dependsOnStepKeys: ["search-drive"] }
      ]
    });
    const issues = validateGeneratedPlan(mission(), invalid);
    expect(issues).toContain("Generated plan dependencies must be acyclic.");
    expect(issues).toContain("Required acceptance criterion cited is not covered by the plan.");
    expect(issues).toContain("Required deliverable brief is not produced by the plan.");
    expect(() => sizeMissionPlan(mission(), invalid)).toThrow(MissionPlanValidationError);
  });

  it("does not silently change a mission from delegated to multi-worker", () => {
    expect(() => createMissionPlan({
      mission: mission({ executionDepth: "delegated" }),
      planId: id<"plan">("plan-1"),
      revisionId: id<"plan-revision">("revision-1"),
      draft: draft(),
      now: "2026-07-11T01:00:00.000Z"
    })).toThrow("does not match generated plan sizing");
  });
});
