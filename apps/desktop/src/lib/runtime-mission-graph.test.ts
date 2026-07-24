import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  executeRuntimeMissionGraph,
  executeRuntimeProviderMissionGraph,
  resumeInterruptedRuntimeProviderMissions
} from "./runtime-mission-graph";

const mocks = vi.hoisted(() => ({
  lifecycle: null as Record<string, unknown> | null,
  journal: null as Record<string, unknown> | null,
  advance: vi.fn(),
  cancel: vi.fn(),
  createCheckpoint: vi.fn(),
  listRoutes: vi.fn(),
  recoverGeneral: vi.fn(),
  restoreCheckpoint: vi.fn(),
  startWorker: vi.fn()
}));

vi.mock("../runtime", () => ({
  getRuntimeMissionRun: vi.fn(async () => mocks.journal),
  getRuntimeMissionPlan: vi.fn(async () => mocks.lifecycle),
  advanceRuntimeMissionCoordination: mocks.advance,
  createRuntimeMissionCheckpoint: mocks.createCheckpoint,
  requestRuntimeMissionRunCancellation: mocks.cancel,
  recoverRuntimeInterruptedGeneralMissions: mocks.recoverGeneral,
  restoreRuntimeMissionCheckpoint: mocks.restoreCheckpoint,
  listRuntimeNativeProviderRoutes: mocks.listRoutes,
  startRuntimeMissionWorker: mocks.startWorker
}));

const providerRoute = {
  id: "provider-route-openai-gpt5",
  recordType: "provider-route",
  connectionId: "connection-openai",
  kind: "api-model",
  displayName: "OpenAI GPT-5",
  providerFamily: "openai",
  modelOrRuntimeReference: "gpt-5",
  state: "available",
  health: { state: "healthy" },
  placement: {
    allowedKinds: ["local-desktop"],
    requiresCredentialHoldingNode: true
  },
  boundaries: {
    privacyBoundary: "member-private",
    billingBoundary: "account-owned-provider",
    providerBoundary: "openai",
    placementBoundary: "local-credential-egress"
  },
  credentialBinding: {
    custody: "os-secure-store",
    state: "available",
    refreshSupported: false
  },
  workspaceId: "workspace-1",
  visibility: "member-private",
  ownerMemberId: "member-1",
  authority: "local",
  schemaVersion: 1,
  revision: 1,
  createdByInternalUserId: "user-1",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z"
};

function metadata() {
  return {
    workspaceId: "workspace-1",
    visibility: "member-private",
    ownerMemberId: "member-1",
    authority: "local",
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "user-1",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z"
  } as const;
}

function worker(id: string, stepKey: string): Spine.Missions.Worker {
  return {
    ...metadata(),
    id: id as Spine.Primitives.WorkerId,
    runId: "run-1" as Spine.Primitives.RunId,
    status: "proposed",
    role: {
      kind: "specialist",
      title: stepKey,
      objective: `Complete ${stepKey}.`,
      responsibilities: [`Complete ${stepKey}.`]
    },
    planRevisionId: "revision-1" as Spine.Primitives.PlanRevisionId,
    planStepKey: stepKey,
    context: [],
    capabilityIds: [],
    capabilityGrantIds: [],
    tools: [],
    routePreference: {
      policy: "require",
      providerRouteIds: ["provider-route-openai-gpt5"],
      allowFallback: false
    },
    placementPreference: {
      policy: "require",
      executionNodeIds: ["local-desktop"],
      locality: "local",
      allowTransfer: false
    },
    budget: {
      maxDurationMs: 30_000,
      maxInputTokens: 4_000,
      maxOutputTokens: 1_024,
      maxToolCalls: 1,
      maxAttempts: 1
    },
    stopConditions: [],
    outputContract: {
      slots: [{
        key: stepKey,
        description: stepKey,
        required: true,
        format: "text/markdown"
      }],
      includeEvidence: false,
      includeUncertainty: true,
      delivery: "run-result"
    }
  } as unknown as Spine.Missions.Worker;
}

function installFixture() {
  const workerA = worker("worker-a", "a");
  const workerB = worker("worker-b", "b");
  mocks.lifecycle = {
    mission: {
      ...metadata(),
      id: "mission-1",
      status: "running",
      executionDepth: "multi-worker",
      outcome: {
        title: "Comparison",
        desiredOutcome: "Compare two options.",
        deliverables: [{ key: "final", description: "Comparison", required: true }]
      },
      scope: { departmentIds: [], context: [] },
      constraints: [],
      acceptance: { criteria: [], requiresHumanAcceptance: false },
      budget: { maxWorkers: 2 },
      currentPlanId: "plan-1",
      currentPlanRevisionId: "revision-1"
    },
    plan: {},
    currentRevision: {
      ...metadata(),
      id: "revision-1",
      planId: "plan-1",
      missionId: "mission-1",
      planRevisionNumber: 1,
      reason: "initial",
      summary: "Run two workers and combine exact outputs.",
      bounds: {
        maxSteps: 3,
        maxDependenciesPerStep: 2,
        maxParallelSteps: 2
      },
      steps: [
        {
          key: "a", kind: "produce", title: "A", objective: "Complete A.",
          dependsOnStepKeys: [], requiredCapabilities: [],
          expectedOutputs: [{ key: "a", description: "A", required: true }],
          acceptanceCriterionKeys: [], optional: false
        },
        {
          key: "b", kind: "produce", title: "B", objective: "Complete B.",
          dependsOnStepKeys: [], requiredCapabilities: [],
          expectedOutputs: [{ key: "b", description: "B", required: true }],
          acceptanceCriterionKeys: [], optional: false
        },
        {
          key: "combine", kind: "coordinate", title: "Combine", objective: "Combine.",
          dependsOnStepKeys: ["a", "b"], requiredCapabilities: [],
          expectedOutputs: [{ key: "final", description: "Comparison", required: true }],
          acceptanceCriterionKeys: [], optional: false
        }
      ]
    }
  };
  mocks.journal = {
    run: {
      ...metadata(),
      id: "run-1",
      status: "running",
      executionDepth: "multi-worker",
      initiator: { kind: "mission", missionId: "mission-1" },
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      parentage: { kind: "root" },
      departmentIds: [],
      planRevisionId: "revision-1",
      budget: { maxWorkers: 2 },
      currentAttemptNumber: 1,
      eventHead: { lastSequence: 3, lastEventId: "join-open" }
    },
    events: [
      { id: "worker-a-created", type: "worker-created", payload: { worker: workerA } },
      { id: "worker-b-created", type: "worker-created", payload: { worker: workerB } },
      {
        id: "join-open",
        type: "join-opened",
        payload: {
          join: {
            joinKey: "join-combine",
            targetStepKey: "combine",
            status: "open",
            strategy: "all",
            workerIds: ["worker-a", "worker-b"],
            quorum: null,
            allowFailedWorkers: false,
            deadline: null,
            satisfiedWorkerIds: [],
            failedWorkerIds: []
          }
        }
      }
    ]
  };
  return { workerA, workerB };
}

describe("authenticated runtime Mission graph composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lifecycle = null;
    mocks.journal = null;
    mocks.advance.mockImplementation(async () => {
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const completed = journal.events.filter((event) => event.type === "worker-completed");
      if (completed.length === 2
        && !journal.events.some((event) => event.type === "join-resolved")) {
        journal.events.push({
          id: "join-resolved",
          type: "join-resolved",
          payload: {
            join: {
              joinKey: "join-combine",
              targetStepKey: "combine",
              status: "satisfied",
              strategy: "all",
              workerIds: ["worker-a", "worker-b"],
              quorum: null,
              allowFailedWorkers: false,
              deadline: null,
              satisfiedWorkerIds: ["worker-a", "worker-b"],
              failedWorkerIds: []
            }
          }
        }, {
          id: "aggregation",
          type: "aggregation-recorded",
          payload: {
            aggregation: {
              stepKey: "combine",
              status: "complete",
              producedOutputs: []
            }
          }
        });
      }
      return { journal, progress: {}, appendedEventIds: [] };
    });
    mocks.cancel.mockImplementation(async () => {
      (mocks.journal!.run as Record<string, unknown>).status = "cancelling";
      return mocks.journal;
    });
    mocks.listRoutes.mockResolvedValue([providerRoute]);
    mocks.recoverGeneral.mockResolvedValue([]);
    mocks.createCheckpoint.mockImplementation(async (input: Record<string, unknown>) => {
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const run = journal.run;
      const head = run.eventHead as Record<string, unknown>;
      const sequence = Number(head.lastSequence) + 1;
      const revision = Number(run.revision) + 1;
      journal.events.push({
        id: input.eventId,
        type: "checkpoint-created",
        sequence,
        previousEventId: input.resumeAfterEventId,
        payload: {
          checkpoint: {
            attemptNumber: input.attemptNumber,
            stateStorage: "portable-redacted",
            executionNodeId: "local-desktop",
            replayBoundary: {
              durableThroughSequence: input.durableThroughSequence,
              resumeAfterEventId: input.resumeAfterEventId
            }
          }
        }
      });
      run.revision = revision;
      run.eventHead = { lastSequence: sequence, lastEventId: input.eventId };
      return journal;
    });
    mocks.startWorker.mockImplementation(async (input: Record<string, unknown>) => {
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const run = journal.run;
      const head = run.eventHead as Record<string, unknown>;
      let sequence = Number(head.lastSequence);
      let revision = Number(run.revision);
      if (typeof input.runStartEventId === "string") {
        run.status = "running";
        sequence += 1;
        revision += 1;
      }
      sequence += 1;
      revision += 1;
      journal.events.push({
        id: input.workerStartedEventId,
        type: "worker-started",
        payload: { workerId: input.workerId }
      });
      sequence += 1;
      revision += 1;
      journal.events.push({
        id: input.routeSelectedEventId,
        type: "route-selected",
        payload: { workerId: input.workerId, selection: input.routeSelection }
      });
      run.revision = revision;
      run.eventHead = {
        lastSequence: sequence,
        lastEventId: input.routeSelectedEventId
      };
      return journal;
    });
    mocks.restoreCheckpoint.mockImplementation(async (input: Record<string, unknown>) => {
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const run = journal.run;
      const sequence = Number(input.expectedLastSequence) + 1;
      const revision = Number(input.expectedRunRevision) + 1;
      journal.events.push({
        id: input.eventId,
        type: "checkpoint-restored",
        sequence,
        previousEventId: "checkpoint-general",
        attemptNumber: input.newAttemptNumber,
        payload: {
          checkpointEventId: "checkpoint-general",
          newAttemptNumber: input.newAttemptNumber
        }
      });
      run.revision = revision;
      run.currentAttemptNumber = input.newAttemptNumber;
      run.eventHead = { lastSequence: sequence, lastEventId: input.eventId };
      return { journal, checkpoint: {} };
    });
  });

  it("does not simulate an authenticated graph outside the desktop runtime", async () => {
    await expect(executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker: vi.fn()
    })).resolves.toBeNull();
  });

  it("runs exact durable workers and delegates joins and aggregation back to native", async () => {
    installFixture();
    const executeWorker = vi.fn(async (assigned: Spine.Missions.Worker) => {
      (mocks.journal!.events as Array<Record<string, unknown>>).push({
        id: `${assigned.id}-started`,
        type: "worker-started",
        payload: { workerId: assigned.id }
      }, {
        id: `${assigned.id}-completed`,
        type: "worker-completed",
        payload: {
          workerId: assigned.id,
          outputs: [{
            key: assigned.planStepKey,
            summary: `${assigned.planStepKey} output`,
            valueReference: `mission-output:${assigned.planStepKey}`
          }]
        }
      });
    });
    const result = await executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker
    });
    expect(result).toMatchObject({
      status: "complete",
      launchedWorkerIds: ["worker-a", "worker-b"],
      settledJoinKeys: ["join-combine"],
      recordedAggregationStepKeys: ["combine"]
    });
    expect(executeWorker).toHaveBeenCalledTimes(2);
    expect(mocks.advance).toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("starts a ready provider batch before parallel egress and settles through native facts", async () => {
    installFixture();
    const backendRun = vi.fn((request: {
      missionWorkerExecution?: { workerId: string };
    }) => (async function* () {
      expect(mocks.startWorker).toHaveBeenCalledTimes(2);
      const workerId = request.missionWorkerExecution!.workerId;
      const stepKey = workerId === "worker-a" ? "a" : "b";
      yield { type: "text-delta", text: `${stepKey} output` };
      yield {
        type: "usage",
        inputTokens: 20,
        outputTokens: 4,
        costUsd: 0,
        costUnknown: true
      };
      (mocks.journal!.events as Array<Record<string, unknown>>).push({
        id: `${workerId}-completed`,
        type: "worker-completed",
        payload: {
          workerId,
          outputs: [{
            key: stepKey,
            summary: `${stepKey} output`,
            valueReference: `mission-output:${stepKey}`
          }]
        }
      });
      yield { type: "done", finishReason: "stop" };
    })());
    const backend = {
      providerId: "openai",
      backend: { backendType: "native-api" },
      capabilities: [],
      run: backendRun,
      cancel: vi.fn(async () => {})
    };
    const result = await executeRuntimeProviderMissionGraph({
      runId: "run-1",
      resolveBackend: async () => backend as never
    });
    expect(result).toMatchObject({
      status: "complete",
      launchedWorkerIds: ["worker-a", "worker-b"],
      settledJoinKeys: ["join-combine"],
      recordedAggregationStepKeys: ["combine"]
    });
    expect(mocks.startWorker).toHaveBeenCalledTimes(2);
    expect(backendRun).toHaveBeenCalledTimes(2);
    expect(backendRun.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5",
      missionWorkerExecution: {
        expectedRunRevision: 6,
        expectedLastSequence: 8,
        checkpointEventId: expect.stringMatching(/^mission-general-checkpoint-/)
      }
    });
    expect(backendRun.mock.calls[1]?.[0]).toMatchObject({
      missionWorkerExecution: {
        expectedRunRevision: 6,
        expectedLastSequence: 8,
        checkpointEventId: expect.stringMatching(/^mission-general-checkpoint-/)
      }
    });
    expect(mocks.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(mocks.createCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      expectedRunRevision: 5,
      expectedLastSequence: 7,
      attemptNumber: 1,
      durableThroughSequence: 7
    }));
  });

  it("does not advance the durable graph until every provider sibling settles", async () => {
    installFixture();
    let releaseWorkerA!: () => void;
    let releaseWorkerB!: () => void;
    let workerACompleted!: () => void;
    let bothStarted!: () => void;
    const workerAGate = new Promise<void>((resolve) => { releaseWorkerA = resolve; });
    const workerBGate = new Promise<void>((resolve) => { releaseWorkerB = resolve; });
    const workerACompletion = new Promise<void>((resolve) => { workerACompleted = resolve; });
    const bothStartedPromise = new Promise<void>((resolve) => { bothStarted = resolve; });
    let startedCount = 0;
    const backend = {
      providerId: "openai",
      backend: { backendType: "native-api" },
      capabilities: [],
      run: vi.fn((request: {
        missionWorkerExecution?: { workerId: string };
      }) => (async function* () {
        startedCount += 1;
        if (startedCount === 2) bothStarted();
        const workerId = request.missionWorkerExecution!.workerId;
        await (workerId === "worker-a" ? workerAGate : workerBGate);
        const stepKey = workerId === "worker-a" ? "a" : "b";
        yield { type: "text-delta", text: `${stepKey} output` };
        yield {
          type: "usage",
          inputTokens: 20,
          outputTokens: 4,
          costUsd: 0,
          costUnknown: true
        };
        (mocks.journal!.events as Array<Record<string, unknown>>).push({
          id: `${workerId}-completed`,
          type: "worker-completed",
          payload: {
            workerId,
            outputs: [{
              key: stepKey,
              summary: `${stepKey} output`,
              valueReference: `mission-output:${stepKey}`
            }]
          }
        });
        if (workerId === "worker-a") workerACompleted();
        yield { type: "done", finishReason: "stop" };
      })()),
      cancel: vi.fn(async () => {})
    };
    const execution = executeRuntimeProviderMissionGraph({
      runId: "run-1",
      resolveBackend: async () => backend as never
    });
    await bothStartedPromise;
    const advanceCountBeforeSettlement = mocks.advance.mock.calls.length;
    releaseWorkerA();
    await workerACompletion;
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.advance).toHaveBeenCalledTimes(advanceCountBeforeSettlement);
    releaseWorkerB();
    await expect(execution).resolves.toMatchObject({ status: "complete" });
    expect(mocks.advance.mock.calls.length).toBeGreaterThan(advanceCountBeforeSettlement);
  });

  it("restores and freshly routes an exact interrupted provider batch", async () => {
    const { workerA, workerB } = installFixture();
    (workerA.tools as Array<Spine.Missions.Worker["tools"][number]>).push({
      toolName: "connection-read",
      access: "read",
      purpose: "Search connected sources",
      required: true
    });
    (workerA.capabilityIds as Array<Spine.Missions.Worker["capabilityIds"][number]>)
      .push("knowledge.content.search" as Spine.Missions.Worker["capabilityIds"][number]);
    (workerA.capabilityGrantIds as Array<Spine.Missions.Worker["capabilityGrantIds"][number]>)
      .push("grant-search-1" as Spine.Missions.Worker["capabilityGrantIds"][number]);
    workerA.outputContract.includeEvidence = true;
    const routeSelection = {
      providerRouteId: "provider-route-openai-gpt5",
      selectedAt: "2026-07-23T10:00:00.000Z",
      reason: "Selected the exact available route.",
      boundaryPolicyRef: "boundary:test"
    };
    const journal = mocks.journal as {
      run: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    journal.events.push(
      { id: "start-a", type: "worker-started", sequence: 4, payload: { workerId: workerA.id } },
      { id: "route-a", type: "route-selected", sequence: 5, previousEventId: "start-a",
        payload: { workerId: workerA.id, providerId: "openai", modelReference: "gpt-5", selection: routeSelection } },
      { id: "tool-a", type: "tool-call-completed", sequence: 6, previousEventId: "route-a",
        payload: { result: { workerId: workerA.id, toolName: "connection-read",
          outputReference: "mission-tool:v1:worker-a:evidence" } } },
      { id: "start-b", type: "worker-started", sequence: 7, previousEventId: "tool-a",
        payload: { workerId: workerB.id } },
      { id: "route-b", type: "route-selected", sequence: 8, previousEventId: "start-b",
        payload: { workerId: workerB.id, providerId: "openai", modelReference: "gpt-5", selection: routeSelection } },
      { id: "checkpoint-general", type: "checkpoint-created", sequence: 9, previousEventId: "route-b",
        payload: { checkpoint: { attemptNumber: 1, stateStorage: "portable-redacted",
          executionNodeId: "local-desktop", replayBoundary: {
            durableThroughSequence: 8, resumeAfterEventId: "route-b"
          } } } }
    );
    journal.run.revision = 7;
    journal.run.eventHead = { lastSequence: 9, lastEventId: "checkpoint-general" };
    mocks.recoverGeneral.mockResolvedValue([{
      status: "resumable",
      runId: "run-1",
      planRevisionId: "revision-1",
      checkpointEventId: "checkpoint-general",
      restoreEventId: "restore-general",
      restoreIdempotencyKey: "restore-general-1",
      activeWorkerIds: ["worker-a", "worker-b"],
      activePlanStepKeys: ["a", "b"],
      completedWorkerIds: [],
      completedPlanStepKeys: [],
      committedEffectKeys: [],
      toolEvidence: [{
        workerId: "worker-a",
        toolEventId: "tool-a",
        outputReference: "mission-tool:v1:worker-a:evidence",
        evidence: {
          capabilityId: "knowledge.content.search",
          result: {
            matchedGrantIds: ["grant-search-1"],
            trust: "external-untrusted",
            instructionAuthority: "none"
          }
        }
      }],
      expectedRunRevision: 7,
      expectedLastSequence: 9,
      newAttemptNumber: 2,
      requiresFreshRouteSelection: true
    }]);
    const backendRun = vi.fn((request: {
      missionWorkerExecution?: {
        workerId: string;
        toolEvidence?: { outputReference: string };
      };
      messages?: Array<{ content: string }>;
    }) => (async function* () {
      const workerId = request.missionWorkerExecution!.workerId;
      if (workerId === "worker-a") {
        expect(request.missionWorkerExecution?.toolEvidence).toEqual({
          toolEventId: "tool-a",
          outputReference: "mission-tool:v1:worker-a:evidence"
        });
        expect(request.messages?.[0]?.content).toContain(
          '"instructionAuthority":"none"'
        );
      }
      const stepKey = workerId === "worker-a" ? "a" : "b";
      yield { type: "text-delta", text: `${stepKey} resumed` };
      yield { type: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0, costUnknown: true };
      journal.events.push({
        id: `${workerId}-completed`,
        type: "worker-completed",
        payload: { workerId, outputs: [{ key: stepKey, summary: `${stepKey} resumed`,
          valueReference: `mission-output:${stepKey}` }] }
      });
      yield { type: "done", finishReason: "stop" };
    })());
    const backend = {
      providerId: "openai",
      backend: { backendType: "native-api" },
      capabilities: [],
      run: backendRun,
      cancel: vi.fn(async () => {})
    };

    await expect(resumeInterruptedRuntimeProviderMissions({
      resolveBackend: async () => backend as never
    })).resolves.toEqual({
      resumed: 1,
      dormant: 0,
      waiting: 0,
      terminalized: 0,
      failed: 0
    });

    expect(mocks.restoreCheckpoint).toHaveBeenCalledWith({
      runId: "run-1",
      eventId: "restore-general",
      idempotencyKey: "restore-general-1",
      expectedRunRevision: 7,
      expectedLastSequence: 9,
      newAttemptNumber: 2
    });
    expect(backendRun).toHaveBeenCalledTimes(2);
    for (const [request] of backendRun.mock.calls) {
      expect(request).toMatchObject({
        missionWorkerExecution: {
          expectedRunRevision: 8,
          expectedLastSequence: 10,
          checkpointEventId: "checkpoint-general",
          checkpointRestoreEventId: "restore-general"
        }
      });
    }
    expect(mocks.startWorker).not.toHaveBeenCalled();
  });

  it("rejects tool-bearing general dispatch before any native start", async () => {
    installFixture();
    const created = (mocks.journal!.events as Array<Record<string, unknown>>)
      .find((event) => event.type === "worker-created");
    const assigned = (created!.payload as {
      worker: Spine.Missions.Worker;
    }).worker;
    (assigned.tools as Array<unknown>).push({
      toolName: "connection-read",
      access: "read",
      purpose: "Search"
    });
    await expect(executeRuntimeProviderMissionGraph({
      runId: "run-1",
      resolveBackend: vi.fn()
    })).rejects.toThrow("failed without recording a durable terminal fact");
    expect(mocks.startWorker).not.toHaveBeenCalled();
  });

  it("attests one connected-source search before checkpointed provider egress", async () => {
    const { workerA } = installFixture();
    (workerA.tools as Array<Spine.Missions.Worker["tools"][number]>).push({
      toolName: "connection-read",
      access: "read",
      purpose: "Search connected sources",
      required: true
    });
    (workerA.capabilityIds as Array<Spine.Missions.Worker["capabilityIds"][number]>)
      .push("knowledge.content.search" as Spine.Missions.Worker["capabilityIds"][number]);
    (workerA.capabilityGrantIds as Array<Spine.Missions.Worker["capabilityGrantIds"][number]>)
      .push("grant-search-1" as Spine.Missions.Worker["capabilityGrantIds"][number]);
    workerA.outputContract.includeEvidence = true;
    const executeMissionTool = vi.fn(async (input: {
      worker: Spine.Missions.Worker;
      argumentsJson: string;
      binding: {
        toolEventId: string;
        expectedRunRevision: number;
        expectedLastSequence: number;
      };
    }) => {
      expect(mocks.startWorker).toHaveBeenCalledTimes(1);
      expect(input.worker.id).toBe("worker-a");
      expect(JSON.parse(input.argumentsJson)).toEqual({
        capability: "knowledge.content.search",
        input: { query: "Complete a.", limit: 10 }
      });
      const journal = mocks.journal as {
        run: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
      const outputReference = "mission-tool:v1:worker-a:evidence";
      journal.events.push({
        id: input.binding.toolEventId,
        type: "tool-call-completed",
        sequence: input.binding.expectedLastSequence + 1,
        payload: {
          result: {
            workerId: "worker-a",
            toolName: "connection-read",
            outputReference
          }
        }
      });
      journal.run.revision = input.binding.expectedRunRevision + 1;
      journal.run.eventHead = {
        lastSequence: input.binding.expectedLastSequence + 1,
        lastEventId: input.binding.toolEventId
      };
      return {
        result: {
          matchedGrantIds: ["grant-search-1"],
          trust: "external-untrusted",
          instructionAuthority: "none"
        }
      };
    });
    const backendRun = vi.fn((request: {
      missionWorkerExecution?: {
        workerId: string;
        checkpointEventId?: string;
        toolEvidence?: { outputReference: string };
      };
      messages?: Array<{ content: string }>;
      missionToolEvidence?: unknown;
    }) => (async function* () {
      const workerId = request.missionWorkerExecution!.workerId;
      const stepKey = workerId === "worker-a" ? "a" : "b";
      if (workerId === "worker-a") {
        expect(request.messages?.[0]?.content).toContain(
          '"instructionAuthority":"none"'
        );
        expect(request.missionWorkerExecution?.toolEvidence).toEqual({
          toolEventId: expect.stringMatching(/^mission-tool-/),
          outputReference: "mission-tool:v1:worker-a:evidence"
        });
      } else {
        expect(request.messages?.[0]?.content).not.toContain(
          '"instructionAuthority":"none"'
        );
        expect(request.missionWorkerExecution?.toolEvidence).toBeUndefined();
      }
      yield { type: "text-delta", text: `${stepKey} output` };
      yield {
        type: "usage",
        inputTokens: 20,
        outputTokens: 4,
        costUsd: 0,
        costUnknown: true
      };
      (mocks.journal!.events as Array<Record<string, unknown>>).push({
        id: `${workerId}-completed`,
        type: "worker-completed",
        payload: {
          workerId,
          outputs: [{
            key: stepKey,
            summary: `${stepKey} output`,
            valueReference: `mission-output:${stepKey}`
          }]
        }
      });
      yield { type: "done", finishReason: "stop" };
    })());
    const backend = {
      providerId: "openai",
      backend: { backendType: "native-api" },
      capabilities: [],
      run: backendRun,
      cancel: vi.fn(async () => {})
    };

    await expect(executeRuntimeProviderMissionGraph({
      runId: "run-1",
      resolveBackend: async () => backend as never,
      executeMissionTool
    })).resolves.toMatchObject({ status: "complete" });

    expect(executeMissionTool).toHaveBeenCalledTimes(1);
    expect(mocks.createCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      expectedRunRevision: 6,
      expectedLastSequence: 8,
      durableThroughSequence: 8,
      resumeAfterEventId: expect.stringMatching(/^mission-route-/)
    }));
  });

  it("persists cancellation before it asks the worker callback to abort", async () => {
    installFixture();
    const executeWorker = vi.fn();
    const cancellation = new AbortController();
    cancellation.abort();
    const result = await executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker,
      signal: cancellation.signal
    });
    expect(result?.status).toBe("cancelled");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(executeWorker).not.toHaveBeenCalled();
  });

  it("rejects a changed durable join resolution", async () => {
    installFixture();
    (mocks.journal!.events as Array<Record<string, unknown>>).push({
      id: "join-resolved",
      type: "join-resolved",
      payload: {
        join: {
          joinKey: "join-combine",
          targetStepKey: "other-step",
          status: "satisfied",
          strategy: "all",
          workerIds: ["worker-b", "worker-a"],
          quorum: null,
          allowFailedWorkers: false,
          deadline: null,
          satisfiedWorkerIds: ["worker-a", "worker-b"],
          failedWorkerIds: []
        }
      }
    });
    await expect(executeRuntimeMissionGraph({
      runId: "run-1",
      executeWorker: vi.fn()
    })).rejects.toThrow("stored Mission join changed its target");
  });
});
