import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "@fable/connectors";

const mocks = vi.hoisted(() => ({
  createPlan: vi.fn(),
  createRun: vi.fn(),
  prepareWorkers: vi.fn(),
  openJoin: vi.fn(),
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
  openRuntimeMissionJoin: mocks.openJoin,
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
  mocks.prepareWorkers.mockResolvedValue({
    run: { revision: 5, eventHead: { lastSequence: 5, lastEventId: "worker-created-3" } },
    events: []
  });
  mocks.openJoin.mockResolvedValue({
    run: { revision: 6, eventHead: { lastSequence: 6, lastEventId: "join-open" } },
    events: []
  });
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

  it("accepts one explicit bounded all or any continuation", () => {
    expect(parseGeneralMissionDraft([
      "Launch readiness",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step"
    ].join("\n"))).toEqual({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief", "Identify the main risks"],
      join: {
        strategy: "all",
        task: "Recommend the next step"
      }
    });
    expect(parseGeneralMissionDraft([
      "Fallback brief",
      "- Check source A",
      "- Check source B",
      "any: Write from the available evidence"
    ].join("\n"))?.join?.strategy).toBe("any");
    expect(parseGeneralMissionDraft([
      "Too large",
      ...Array.from({ length: 6 }, (_, index) => `- Task ${index + 1}`),
      "all: Combine"
    ].join("\n"))).toBeNull();
  });

  it("accepts an explicit fan-in followed by a bounded sequential chain", () => {
    expect(parseGeneralMissionDraft([
      "Launch readiness",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "then: Turn the recommendation into a checklist"
    ].join("\n"))).toEqual({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief", "Identify the main risks"],
      join: {
        strategy: "all",
        task: "Recommend the next step",
        then: ["Turn the recommendation into a checklist"]
      }
    });
    expect(parseGeneralMissionDraft([
      "Invalid chain",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "then: Recommend the next step"
    ].join("\n"))).toBeNull();
    expect(parseGeneralMissionDraft([
      "Invalid branch",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "any: Replace the declared continuation"
    ].join("\n"))).toBeNull();
  });

  it("accepts exactly one declared advisory review and revision pass", () => {
    expect(parseGeneralMissionDraft([
      "Launch readiness",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "review: Check the recommendation against both drafts",
      "revise: Apply the review once and produce the final recommendation"
    ].join("\n"))).toEqual({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief", "Identify the main risks"],
      join: {
        strategy: "all",
        task: "Recommend the next step",
        review: {
          task: "Check the recommendation against both drafts",
          revise: "Apply the review once and produce the final recommendation"
        }
      }
    });
    expect(parseGeneralMissionDraft([
      "Missing revision",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "review: Check the recommendation"
    ].join("\n"))).toBeNull();
    expect(parseGeneralMissionDraft([
      "Missing review",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "revise: Revise the recommendation"
    ].join("\n"))).toBeNull();
    expect(parseGeneralMissionDraft([
      "Review after a declared chain",
      "- Prepare the launch brief",
      "- Identify the main risks",
      "all: Recommend the next step",
      "then: Turn the recommendation into a checklist",
      "review: Check the checklist",
      "revise: Apply the review once"
    ].join("\n"))).toEqual({
      title: "Review after a declared chain",
      tasks: ["Prepare the launch brief", "Identify the main risks"],
      join: {
        strategy: "all",
        task: "Recommend the next step",
        then: ["Turn the recommendation into a checklist"],
        review: {
          task: "Check the checklist",
          revise: "Apply the review once"
        }
      }
    });
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

  it("opens an explicit dependency join before provider execution", async () => {
    const ids = [
      "mission-1",
      "plan-2",
      "plan-revision-3",
      "mission-run-4",
      "event-5",
      "run-create-6",
      "join-open-7",
      "join-open-key-8"
    ];
    mocks.getRun.mockResolvedValue({
      run: { id: "mission-run-4" },
      events: [
        completion("task-1", "output-1"),
        completion("task-2", "output-2"),
        completion("joined-result", "output-final")
      ]
    });
    const result = await executeGeneralMission({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief.", "Identify the main risks."],
      join: {
        strategy: "all",
        task: "Recommend the next step from both drafts."
      },
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend,
      model: "gpt-5",
      resolveBackend: async () => backend,
      createId: () => ids.shift()!
    });

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      constraints: [expect.objectContaining({
        key: "native:general-declared-graph:v1"
      })],
      bounds: expect.objectContaining({
        maxSteps: 3,
        maxDependenciesPerStep: 2,
        maxParallelSteps: 2
      }),
      steps: [
        expect.objectContaining({ key: "task-1", dependsOnStepKeys: [] }),
        expect.objectContaining({ key: "task-2", dependsOnStepKeys: [] }),
        expect.objectContaining({
          key: "joined-result",
          dependsOnStepKeys: ["task-1", "task-2"]
        })
      ]
    }));
    expect(mocks.openJoin).toHaveBeenCalledWith({
      runId: "mission-run-4",
      targetStepKey: "joined-result",
      strategy: "all",
      allowFailedWorkers: false,
      eventId: "join-open-7",
      idempotencyKey: "join-open-key-8",
      expectedRunRevision: 5,
      expectedLastSequence: 5
    });
    expect(mocks.openJoin.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.executeGraph.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ outcome: "awaiting-review" });
    expect(result.text).toContain("## Recommend the next step from both drafts");
  });

  it("composes a short multi-stage chain without inferring another join", async () => {
    const ids = [
      "mission-1",
      "plan-2",
      "plan-revision-3",
      "mission-run-4",
      "event-5",
      "run-create-6",
      "join-open-7",
      "join-open-key-8"
    ];
    mocks.getRun.mockResolvedValue({
      run: { id: "mission-run-4" },
      events: [
        completion("task-1", "output-1"),
        completion("task-2", "output-2"),
        completion("joined-result", "output-joined"),
        completion("continued-result-1", "output-final")
      ]
    });
    const result = await executeGeneralMission({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief.", "Identify the main risks."],
      join: {
        strategy: "all",
        task: "Recommend the next step from both drafts.",
        then: ["Turn the recommendation into a checklist."]
      },
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend,
      model: "gpt-5",
      resolveBackend: async () => backend,
      createId: () => ids.shift()!
    });

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      bounds: expect.objectContaining({
        maxSteps: 4,
        maxDependenciesPerStep: 2,
        maxParallelSteps: 2
      }),
      outcome: expect.objectContaining({
        deliverables: expect.arrayContaining([
          expect.objectContaining({ key: "joined-result", required: false }),
          expect.objectContaining({ key: "continued-result-1", required: true })
        ])
      }),
      steps: [
        expect.objectContaining({ key: "task-1", dependsOnStepKeys: [] }),
        expect.objectContaining({ key: "task-2", dependsOnStepKeys: [] }),
        expect.objectContaining({
          key: "joined-result",
          dependsOnStepKeys: ["task-1", "task-2"]
        }),
        expect.objectContaining({
          key: "continued-result-1",
          dependsOnStepKeys: ["joined-result"]
        })
      ]
    }));
    expect(mocks.openJoin).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "awaiting-review" });
    expect(result.text).toContain("## Turn the recommendation into a checklist");
  });

  it("runs one declared advisory review and one revision with explicit joins", async () => {
    const ids = [
      "mission-1",
      "plan-2",
      "plan-revision-3",
      "mission-run-4",
      "event-5",
      "run-create-6",
      "join-open-7",
      "join-open-key-8",
      "join-open-9",
      "join-open-key-10"
    ];
    mocks.openJoin
      .mockResolvedValueOnce({
        run: { revision: 6, eventHead: { lastSequence: 6, lastEventId: "join-open-7" } },
        events: []
      })
      .mockResolvedValueOnce({
        run: { revision: 7, eventHead: { lastSequence: 7, lastEventId: "join-open-9" } },
        events: []
      });
    mocks.getRun.mockResolvedValue({
      run: { id: "mission-run-4" },
      events: [
        completion("task-1", "output-1"),
        completion("task-2", "output-2"),
        completion("joined-result", "output-draft"),
        completion("review-result", "output-review"),
        completion("revised-result", "output-final")
      ]
    });

    const result = await executeGeneralMission({
      title: "Launch readiness",
      tasks: ["Prepare the launch brief.", "Identify the main risks."],
      join: {
        strategy: "all",
        task: "Recommend the next step from both drafts.",
        review: {
          task: "Check the recommendation against both drafts.",
          revise: "Apply the review once and produce the final recommendation."
        }
      },
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend,
      model: "gpt-5",
      resolveBackend: async () => backend,
      createId: () => ids.shift()!
    });

    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      budget: expect.objectContaining({ maxWorkers: 5 }),
      bounds: expect.objectContaining({
        maxSteps: 5,
        maxDependenciesPerStep: 2,
        maxParallelSteps: 2
      }),
      outcome: expect.objectContaining({
        deliverables: expect.arrayContaining([
          expect.objectContaining({ key: "joined-result", required: false }),
          expect.objectContaining({ key: "review-result", required: false }),
          expect.objectContaining({ key: "revised-result", required: true })
        ])
      }),
      steps: [
        expect.objectContaining({ key: "task-1", kind: "produce", dependsOnStepKeys: [] }),
        expect.objectContaining({ key: "task-2", kind: "produce", dependsOnStepKeys: [] }),
        expect.objectContaining({
          key: "joined-result", kind: "produce",
          dependsOnStepKeys: ["task-1", "task-2"]
        }),
        expect.objectContaining({
          key: "review-result", kind: "review",
          dependsOnStepKeys: ["joined-result"]
        }),
        expect.objectContaining({
          key: "revised-result", kind: "produce",
          dependsOnStepKeys: ["joined-result", "review-result"]
        })
      ]
    }));
    expect(mocks.openJoin).toHaveBeenNthCalledWith(1, expect.objectContaining({
      targetStepKey: "joined-result",
      strategy: "all",
      expectedRunRevision: 5,
      expectedLastSequence: 5
    }));
    expect(mocks.openJoin).toHaveBeenNthCalledWith(2, expect.objectContaining({
      targetStepKey: "revised-result",
      strategy: "all",
      expectedRunRevision: 6,
      expectedLastSequence: 6
    }));
    expect(result).toMatchObject({ outcome: "awaiting-review" });
    expect(result.text).toContain(
      "## Apply the review once and produce the final recommendation"
    );
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
