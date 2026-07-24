import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "@fable/connectors";

const mocks = vi.hoisted(() => ({
  createPlan: vi.fn(),
  createRun: vi.fn(),
  prepareWorkers: vi.fn(),
  listRoutes: vi.fn(),
  readProgress: vi.fn(),
  advance: vi.fn(),
  getRun: vi.fn(),
  readOutput: vi.fn(),
  executeGraph: vi.fn()
}));

vi.mock("../runtime", () => ({
  createRuntimeMissionPlan: mocks.createPlan,
  createRuntimeMissionRun: mocks.createRun,
  prepareRuntimeMissionWorkers: mocks.prepareWorkers,
  listRuntimeNativeProviderRoutes: mocks.listRoutes,
  readRuntimeMissionProgress: mocks.readProgress,
  advanceRuntimeMissionCoordination: mocks.advance,
  getRuntimeMissionRun: mocks.getRun,
  readRuntimeMissionWorkerOutput: mocks.readOutput
}));

vi.mock("./runtime-mission-graph", () => ({
  executeRuntimeProviderMissionGraph: mocks.executeGraph
}));

import {
  executeGeneralMission,
  parseGeneralMissionDraft
} from "./general-mission";

const progress = {
  version: 1,
  state: "waiting",
  summary: "Three drafts are ready for review.",
  runStatus: "running",
  completedSteps: 3,
  totalSteps: 3,
  runningWorkers: 0,
  readyWorkers: 0,
  waitingSteps: 0,
  blockedSteps: 0,
  steps: [],
  usage: {
    records: 3,
    inputTokens: 30,
    outputTokens: 12,
    toolCalls: 0,
    durationMs: 100,
    costObservations: []
  },
  budget: {
    maxDurationMs: 180_000,
    maxInputTokens: 64_000,
    maxOutputTokens: 6_144,
    maxToolCalls: 1,
    maxWorkers: 3,
    maxAttempts: 2
  },
  acceptance: [],
  humanReview: {
    runId: "mission-run-4",
    expectedRunRevision: 10,
    expectedLastSequence: 10,
    criteria: []
  },
  nextAction: "Review the drafts."
} as const;

const route = {
  id: "route-1",
  workspaceId: "workspace-1",
  providerFamily: "openai",
  modelOrRuntimeReference: "gpt-5",
  boundaries: {
    providerBoundaryId: "provider-openai",
    billingBoundaryId: "billing-openai",
    privacyBoundaryId: "privacy-openai",
    placementBoundaryId: "placement-local"
  }
};

const backend = {
  providerId: "openai",
  backend: { backendType: "native-api" },
  capabilities: [],
  run: vi.fn(),
  cancel: vi.fn(async () => {})
} as unknown as AgentBackend;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRoutes.mockResolvedValue([route]);
  mocks.createPlan.mockResolvedValue({ mission: { id: "mission-1" } });
  mocks.createRun.mockResolvedValue({ run: { id: "mission-run-4" }, events: [] });
  mocks.prepareWorkers.mockResolvedValue({});
  mocks.readProgress.mockResolvedValue(progress);
  mocks.executeGraph.mockResolvedValue({
    status: "complete",
    launchedWorkerIds: ["worker-1", "worker-2", "worker-3"],
    settledJoinKeys: [],
    recordedAggregationStepKeys: []
  });
  mocks.advance.mockResolvedValue({ progress });
  mocks.getRun.mockResolvedValue({
    run: { id: "mission-run-4" },
    events: [
      completion("task-1", "output-1"),
      completion("task-2", "output-2"),
      completion("task-3", "output-3")
    ]
  });
  mocks.readOutput.mockImplementation(async (reference: string) => ({
    receipt: { text: `Draft for ${reference}` }
  }));
});

describe("parseGeneralMissionDraft", () => {
  it("accepts a bounded title and numbered or bulleted independent tasks", () => {
    expect(parseGeneralMissionDraft([
      "Launch readiness",
      "1. Prepare the launch brief",
      "- Identify the main risks",
      "* Recommend the next step"
    ].join("\n"))).toEqual({
      title: "Launch readiness",
      tasks: [
        "Prepare the launch brief",
        "Identify the main risks",
        "Recommend the next step"
      ]
    });
  });

  it("rejects one task, duplicate tasks, prose lines, and more than six tasks", () => {
    expect(parseGeneralMissionDraft("Title\n- Only one")).toBeNull();
    expect(parseGeneralMissionDraft("Title\n- Same\n- same")).toBeNull();
    expect(parseGeneralMissionDraft("Title\nFirst\n- Second")).toBeNull();
    expect(parseGeneralMissionDraft([
      "Title",
      ...Array.from({ length: 7 }, (_, index) => `- Task ${index + 1}`)
    ].join("\n"))).toBeNull();
  });
});

describe("executeGeneralMission", () => {
  it("composes arbitrary bounded independent workers through the native graph", async () => {
    const ids = [
      "mission-1",
      "plan-2",
      "plan-revision-3",
      "mission-run-4",
      "event-5",
      "run-create-6"
    ];
    const onRunReady = vi.fn();
    const onProgress = vi.fn();
    const result = await executeGeneralMission({
      title: "Launch readiness",
      tasks: [
        "Prepare the launch brief.",
        "Identify the main risks.",
        "Recommend the next step."
      ],
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      projectId: "project-1",
      backend,
      model: "gpt-5",
      resolveBackend: async () => backend,
      createId: () => ids.shift()!,
      onRunReady,
      onProgress
    });

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      missionId: "mission-1",
      planId: "plan-2",
      planRevisionId: "plan-revision-3",
      executionDepth: "multi-worker",
      missionScope: expect.objectContaining({
        workspaceId: "workspace-1",
        sourceThreadId: "thread-1",
        projectId: "project-1"
      }),
      dataBoundary: {
        allowedProviderRouteIds: ["route-1"],
        allowedExecutionNodeIds: ["local-desktop"]
      },
      bounds: expect.objectContaining({
        maxSteps: 3,
        maxDependenciesPerStep: 0,
        maxParallelSteps: 3
      }),
      acceptance: expect.objectContaining({
        requiresHumanAcceptance: true,
        criteria: expect.arrayContaining([
          expect.objectContaining({
            evaluator: "human",
            evidenceFromStepOutputs: true
          })
        ])
      }),
      steps: [
        expect.objectContaining({ key: "task-1", dependsOnStepKeys: [] }),
        expect.objectContaining({ key: "task-2", dependsOnStepKeys: [] }),
        expect.objectContaining({ key: "task-3", dependsOnStepKeys: [] })
      ]
    }));
    expect(mocks.prepareWorkers).toHaveBeenCalledWith("mission-run-4");
    expect(mocks.executeGraph).toHaveBeenCalledWith(expect.objectContaining({
      runId: "mission-run-4"
    }));
    expect(onRunReady).toHaveBeenCalledWith("mission-run-4", progress);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      missionId: "mission-1",
      runId: "mission-run-4",
      outcome: "awaiting-review"
    });
    expect(result.text).toContain("# Launch readiness");
    expect(result.text).toContain("## Prepare the launch brief");
    expect(result.text).toContain("Draft for output-3");
  });

  it("fails before mutation when the selected provider route is unavailable", async () => {
    mocks.listRoutes.mockResolvedValue([]);
    await expect(executeGeneralMission({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief.", "Identify the main risks."],
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend,
      model: "gpt-5",
      resolveBackend: async () => backend
    })).rejects.toThrow("authorized Mission route");
    expect(mocks.createPlan).not.toHaveBeenCalled();
  });
});

function completion(key: string, valueReference: string) {
  return {
    type: "worker-completed",
    payload: {
      outputs: [{ key, valueReference }]
    }
  };
}
