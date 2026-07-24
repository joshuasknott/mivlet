import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import { finalizeLocalWorkerResult, MissionEvaluationError } from "./evaluation";

function mission(overrides: Partial<Spine.Missions.Mission> = {}): Spine.Missions.Mission {
  return {
    id: "mission-1" as never, workspaceId: "workspace-1" as never, visibility: "member-private",
    ownerMemberId: "member-1" as never, authority: "local", schemaVersion: 1, revision: 1,
    createdByInternalUserId: "user-1" as never, createdAt: "t1", updatedAt: "t1", status: "running",
    executionDepth: "delegated", outcome: { title: "Brief", desiredOutcome: "Cited brief", deliverables: [
      { key: "brief", description: "a cited brief", required: true }
    ] }, scope: { departmentIds: [], context: [] }, constraints: [], acceptance: {
      requiresHumanAcceptance: false,
      criteria: [{ key: "cited", description: "Claims are cited", required: true, evaluator: "policy", evidenceRequired: ["source-1"] }]
    }, ...overrides
  };
}

function worker(): Spine.Missions.Worker {
  return {
    id: "worker-1" as never, runId: "run-1" as never, workspaceId: "workspace-1" as never,
    visibility: "member-private", ownerMemberId: "member-1" as never, authority: "local",
    schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1" as never,
    createdAt: "t", updatedAt: "t", status: "running", role: {
      kind: "specialist", title: "Research", objective: "Research", responsibilities: ["Research"]
    }, context: [], capabilityIds: [], capabilityGrantIds: [], tools: [], budget: {}, stopConditions: [],
    outputContract: { slots: [], includeEvidence: true, includeUncertainty: true, delivery: "run-result" }
  };
}

const complete = { status: "completed", text: "Brief", events: [], retryable: false,
  usage: { inputTokens: 10, outputTokens: 5, toolCalls: 1, costUsd: 0.01, costUnknown: false } } as const;
const output = { key: "brief", summary: "Cited brief", valueReference: "artifact:1" };
const evaluation = { evaluationKey: "eval-1", target: { kind: "run", runId: "run-1" as never },
  verdict: "pass", criteria: [{ criterionKey: "cited", passed: true, summary: "Cited", evidenceRefs: ["source-1"] }],
  summary: "Pass", evaluatedAt: "t2" } as const;

describe("mission acceptance and partial outcomes", () => {
  it("succeeds only when declared outputs, evidence, and required criteria are complete", () => {
    const result = finalizeLocalWorkerResult({ mission: mission(), worker: worker(), execution: complete,
      outputs: [output], evaluations: [evaluation], usageKey: "usage-1", completedAt: "t2", modelReference: "model" });
    expect(result).toMatchObject({ outcome: "succeeded", acceptance: [{ criterionKey: "cited", status: "met" }],
      usage: [{ inputTokens: 10, outputTokens: 5, costs: [{ amount: { amount: "0.01", currencyCode: "USD" } }] }] });
    expect(result.partial).toBeUndefined();
  });

  it("preserves useful output as partial when evidence or acceptance is incomplete", () => {
    const result = finalizeLocalWorkerResult({ mission: mission(), worker: worker(), execution: complete,
      outputs: [output], evaluations: [{ ...evaluation, criteria: [{ ...evaluation.criteria[0], evidenceRefs: [] }] }],
      usageKey: "usage-1", completedAt: "t2" });
    expect(result).toMatchObject({ outcome: "partial", acceptance: [{ status: "partially-met" }],
      partial: { completedOutputs: [output], recoverable: true } });
  });

  it("returns a failed result when execution produces no useful work", () => {
    const result = finalizeLocalWorkerResult({ mission: mission(), worker: worker(), execution: {
      ...complete, status: "failed", text: "", reason: "Provider unavailable", retryable: true
    }, outputs: [], evaluations: [], usageKey: "usage-1", completedAt: "t2" });
    expect(result).toMatchObject({ outcome: "failed", error: { category: "provider", retryable: true } });
    expect(result.partial).toBeUndefined();
  });

  it("requires identified human review and never treats backend completion as human acceptance", () => {
    const humanMission = mission({ acceptance: { requiresHumanAcceptance: true, criteria: [
      { key: "approved", description: "Approved by owner", required: true, evaluator: "human" }
    ] } });
    const noReview = finalizeLocalWorkerResult({ mission: humanMission, worker: worker(), execution: complete,
      outputs: [output], evaluations: [], usageKey: "usage-1", completedAt: "t2" });
    expect(noReview).toMatchObject({ outcome: "partial", partial: { recommendedNextAction: "human-review" } });
    expect(() => finalizeLocalWorkerResult({ mission: humanMission, worker: worker(), execution: complete,
      outputs: [output], evaluations: [{ ...evaluation, criteria: [{ criterionKey: "approved", passed: true,
        summary: "Approved", evidenceRefs: [] }] }], usageKey: "usage-1", completedAt: "t2" }))
      .toThrow(MissionEvaluationError);
  });

  it("keeps an identified worker review advisory even when it passes", () => {
    const workerMission = mission({ acceptance: {
      requiresHumanAcceptance: false,
      criteria: [{
        key: "reviewed",
        description: "A declared worker reviews the result.",
        required: true,
        evaluator: "worker"
      }]
    } });
    const result = finalizeLocalWorkerResult({
      mission: workerMission,
      worker: worker(),
      execution: complete,
      outputs: [output],
      evaluations: [{
        ...evaluation,
        reviewerWorkerId: "worker-1" as never,
        criteria: [{
          criterionKey: "reviewed",
          passed: true,
          summary: "The reviewer recommends acceptance.",
          evidenceRefs: []
        }]
      }],
      usageKey: "usage-1",
      completedAt: "t2"
    });
    expect(result).toMatchObject({
      outcome: "partial",
      acceptance: [{
        criterionKey: "reviewed",
        status: "partially-met",
        summary: expect.stringContaining("model opinion remains advisory")
      }],
      partial: { recommendedNextAction: "revise-plan" }
    });
  });

  it("rejects undeclared outputs, foreign targets, and unattested external evaluation", () => {
    expect(() => finalizeLocalWorkerResult({ mission: mission(), worker: worker(), execution: complete,
      outputs: [{ key: "other", summary: "Other" }], evaluations: [], usageKey: "usage-1", completedAt: "t2" }))
      .toThrow("declared deliverables");
    expect(() => finalizeLocalWorkerResult({ mission: mission(), worker: worker(), execution: complete,
      outputs: [output], evaluations: [{ ...evaluation, target: { kind: "run", runId: "other" as never } }],
      usageKey: "usage-1", completedAt: "t2" })).toThrow("target");
    const external = mission({ acceptance: { requiresHumanAcceptance: false, criteria: [
      { key: "external", description: "External check", required: true, evaluator: "external" }
    ] } });
    expect(() => finalizeLocalWorkerResult({ mission: external, worker: worker(), execution: complete,
      outputs: [output], evaluations: [{ ...evaluation, criteria: [{ criterionKey: "external", passed: true,
        summary: "Pass", evidenceRefs: [] }] }], usageKey: "usage-1", completedAt: "t2" }))
      .toThrow("attested evaluator");
  });
});
