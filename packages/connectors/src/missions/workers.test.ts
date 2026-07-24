import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import { compileWorkerAssignment } from "./workers";

const id = <Kind extends string>(value: string) => value as Spine.Primitives.FableId<Kind>;
const contextRef: Spine.Missions.WorkContextReference = { kind: "connection", connectionId: id<"connection">("connection-1") };

function mission(overrides: Partial<Omit<Spine.Missions.Mission, "visibility" | "ownerMemberId">> = {}): Spine.Missions.Mission {
  return {
    id: id<"mission">("mission-1"), workspaceId: id<"workspace">("workspace-1"),
    visibility: "member-private", ownerMemberId: id<"member">("member-1"), authority: "local",
    schemaVersion: 1, revision: 2, createdByInternalUserId: id<"internal-user">("user-1"),
    createdAt: "t1", updatedAt: "t2", status: "ready", executionDepth: "delegated",
    outcome: { title: "Brief", desiredOutcome: "Produce a brief", deliverables: [{ key: "brief", description: "Brief", required: true }] },
    scope: { departmentIds: [], context: [contextRef] }, constraints: [],
    acceptance: { requiresHumanAcceptance: false, criteria: [{ key: "cited", description: "Cited", required: true, evaluator: "policy" }] },
    budget: { maxDurationMs: 300_000, maxInputTokens: 12_000, maxOutputTokens: 4_000, maxToolCalls: 8, maxAttempts: 2 },
    currentPlanId: id<"plan">("plan-1"), currentPlanRevisionId: id<"plan-revision">("revision-1"),
    ...overrides
  };
}

function revision(overrides: Partial<Spine.Missions.PlanRevision> = {}): Spine.Missions.PlanRevision {
  return {
    id: id<"plan-revision">("revision-1"), planId: id<"plan">("plan-1"), missionId: id<"mission">("mission-1"),
    workspaceId: id<"workspace">("workspace-1"), visibility: "member-private", ownerMemberId: id<"member">("member-1"),
    authority: "local", schemaVersion: 1, revision: 1, createdByInternalUserId: id<"internal-user">("user-1"),
    createdAt: "t1", updatedAt: "t1", planRevisionNumber: 1, reason: "initial", summary: "Write it",
    bounds: { maxSteps: 1, maxDependenciesPerStep: 0, maxParallelSteps: 1 },
    steps: [{
      key: "write", kind: "produce", title: "Write brief", objective: "Write only supported claims.", dependsOnStepKeys: [],
      requiredCapabilities: [id<"capability">("connected-source.search")],
      expectedOutputs: [{ key: "brief", description: "Cited brief", required: true }],
      acceptanceCriterionKeys: ["cited"], optional: false,
      estimatedBudget: { maxDurationMs: 120_000, maxToolCalls: 5 }
    }],
    ...overrides
  } as Spine.Missions.PlanRevision;
}

function input(overrides: Partial<Parameters<typeof compileWorkerAssignment>[0]> = {}): Parameters<typeof compileWorkerAssignment>[0] {
  return {
    mission: mission(), planRevision: revision(), runId: id<"run">("run-1"), workerId: id<"worker">("worker-1"),
    stepKey: "write", now: "t3",
    context: [{ reference: contextRef, purpose: "Search the connected source", required: true, trust: "untrusted", maxCharacters: 20_000 }],
    tools: [{ toolName: "connected-source-search", access: "read", purpose: "Find evidence", required: true }],
    grants: [{ capabilityId: id<"capability">("connected-source.search"), capabilityGrantId: id<"capability-grant">("grant-1") }],
    requestedBudget: { maxDurationMs: 180_000, maxToolCalls: 6 },
    ...overrides
  };
}

describe("bounded worker assignment", () => {
  it("compiles one selected step with explicit grants and the tightest budget", () => {
    const worker = compileWorkerAssignment(input());
    expect(worker).toMatchObject({
      status: "proposed", planStepKey: "write", capabilityIds: ["connected-source.search"],
      capabilityGrantIds: ["grant-1"],
      routePreference: {
        policy: "automatic", providerRouteIds: [], allowFallback: false
      },
      placementPreference: {
        policy: "require", executionNodeIds: ["local-desktop"],
        locality: "local", allowTransfer: false
      },
      budget: { maxDurationMs: 120_000, maxInputTokens: 12_000, maxOutputTokens: 4_000, maxToolCalls: 5, maxAttempts: 1 },
      outputContract: { includeEvidence: true, includeUncertainty: true, delivery: "run-result" }
    });
  });

  it("retains the mission's exact provider-route envelope without fallback", () => {
    const worker = compileWorkerAssignment(input({
      mission: mission({
        dataBoundary: {
          allowedProviderRouteIds: [
            id<"provider-route">("route-1"),
            id<"provider-route">("route-2")
          ],
          allowedExecutionNodeIds: [id<"execution-node">("local-desktop")]
        }
      })
    }));
    expect(worker.routePreference).toMatchObject({
      policy: "require",
      providerRouteIds: ["route-1", "route-2"],
      allowFallback: false
    });
  });

  it("rejects ambiguous route identities and missions that exclude local execution", () => {
    expect(() => compileWorkerAssignment(input({
      mission: mission({
        dataBoundary: {
          allowedProviderRouteIds: [
            id<"provider-route">("route-1"),
            id<"provider-route">("route-1")
          ]
        }
      })
    }))).toThrow("identities must be unique");
    expect(() => compileWorkerAssignment(input({
      mission: mission({
        dataBoundary: {
          allowedExecutionNodeIds: [id<"execution-node">("hosted-node")]
        }
      })
    }))).toThrow("does not permit local desktop execution");
  });

  it("never invents standing authority or accepts unrelated grants", () => {
    expect(() => compileWorkerAssignment(input({ grants: [] }))).toThrow("explicit standing grant");
    expect(() => compileWorkerAssignment(input({ grants: [{ capabilityId: id<"capability">("other"), capabilityGrantId: id<"capability-grant">("grant-2") }] }))).toThrow("exactly once");
  });

  it("rejects hidden context and foreign plan scope", () => {
    expect(() => compileWorkerAssignment(input({ context: [{ reference: { kind: "memory", reference: "hidden" }, purpose: "Hidden", required: true, trust: "trusted" }] }))).toThrow("declared by the mission");
    expect(() => compileWorkerAssignment(input({ planRevision: revision({ workspaceId: id<"workspace">("other") }) }))).toThrow("authority scope");
  });

  it("rejects stale selected revisions and terminal missions", () => {
    expect(() => compileWorkerAssignment(input({ planRevision: revision({ id: id<"plan-revision">("old") }) }))).toThrow("selected plan revision");
    expect(() => compileWorkerAssignment(input({ mission: mission({ status: "completed" }) }))).toThrow("terminal mission");
  });
});
