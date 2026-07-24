import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLocalWorker } from "@fable/connectors";
import {
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  finalizeRuntimeMissionRunCancellation,
  finalizeRuntimeParallelApproaches,
  getRuntimeMissionRun,
  listRuntimeNativeProviderRoutes,
  openRuntimeParallelApproachesJoin,
  prepareRuntimeParallelApproachesReviewer,
  readRuntimeMissionProgress,
  recoverRuntimeParallelApproachesReviewers,
  requestRuntimeMissionRunCancellation,
  startRuntimeMissionWorker
} from "../runtime";
import {
  executeParallelApproachesMission,
  isParallelApproachesMissionPrompt,
  isReviewedParallelApproachesMissionPrompt,
  resumeReviewedParallelApproachesMissions
} from "./parallel-approaches-mission";

vi.mock("@fable/connectors", () => ({
  catalogueCapabilities: vi.fn(() => ({ tools: true, contextWindow: 128_000 })),
  selectMissionProviderRoute: vi.fn((_request: unknown, candidates: Array<{ route: { id: string } }>) => ({
    selection: {
      providerRouteId: candidates[0].route.id,
      selectedAt: "2026-07-13T10:00:00Z",
      reason: "Pinned route",
      fallbackUsed: false,
      boundaryReference: "boundary-1"
    }
  })),
  executeLocalWorker: vi.fn()
}));

vi.mock("../runtime", () => ({
  createRuntimeMissionPlan: vi.fn(),
  createRuntimeMissionRun: vi.fn(),
  createRuntimeMissionWorker: vi.fn(),
  finalizeRuntimeMissionRunCancellation: vi.fn(),
  finalizeRuntimeParallelApproaches: vi.fn(),
  getRuntimeMissionRun: vi.fn(),
  listRuntimeNativeProviderRoutes: vi.fn(),
  openRuntimeParallelApproachesJoin: vi.fn(),
  prepareRuntimeParallelApproachesReviewer: vi.fn(),
  readRuntimeMissionProgress: vi.fn(),
  recoverRuntimeParallelApproachesReviewers: vi.fn(),
  requestRuntimeMissionRunCancellation: vi.fn(),
  startRuntimeMissionWorker: vi.fn()
}));

describe("parallel approaches mission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let revision = 2;
    let sequence = 1;
    const events: Array<Record<string, unknown>> = [{ id: "run-created", type: "run-created" }];
    const journal = () => ({
      run: { revision, eventHead: { lastSequence: sequence, lastEventId: String(events.at(-1)?.id) } },
      events: [...events]
    });
    vi.mocked(createRuntimeMissionPlan).mockResolvedValue({ mission: {}, plan: {}, currentRevision: {} });
    vi.mocked(createRuntimeMissionRun).mockImplementation(async () => journal());
    vi.mocked(createRuntimeMissionWorker).mockImplementation(async (input) => {
      revision += 1; sequence += 1;
      events.push({
        id: input.eventId,
        type: "worker-created",
        payload: {
          worker: {
            id: input.workerId,
            runId: input.runId,
            status: "proposed",
            role: { objective: input.stepKey === "approach-a" ? "Objective A" : "Objective B" },
            budget: { maxDurationMs: 90_000, maxInputTokens: 16_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxAttempts: 1 },
            tools: [],
            outputContract: { slots: [{ key: input.stepKey, required: true, format: "text/markdown" }], includeEvidence: false, includeUncertainty: true, delivery: "run-result" }
          }
        }
      });
      return journal();
    });
    vi.mocked(startRuntimeMissionWorker).mockImplementation(async (input) => {
      if (input.runStartEventId) { revision += 1; sequence += 1; events.push({ id: input.runStartEventId, type: "status-transitioned" }); }
      revision += 1; sequence += 1;
      events.push({ id: input.workerStartedEventId, type: "worker-started", payload: { workerId: input.workerId } });
      revision += 1; sequence += 1;
      events.push({ id: input.routeSelectedEventId, type: "route-selected", payload: { workerId: input.workerId } });
      return journal();
    });
    vi.mocked(openRuntimeParallelApproachesJoin).mockImplementation(async () => {
      revision += 1; sequence += 1;
      events.push({ id: "join-open", type: "join-opened" });
      return journal();
    });
    vi.mocked(listRuntimeNativeProviderRoutes).mockResolvedValue([{
      id: "route-openai",
      workspaceId: "workspace-1",
      providerFamily: "openai",
      modelOrRuntimeReference: "gpt-5",
      boundaries: {},
      state: "available",
      health: "healthy"
    } as never]);
    vi.mocked(finalizeRuntimeParallelApproaches).mockResolvedValue({
      missionId: "mission-1",
      runId: "mission-run-1",
      outcome: "completed",
      text: "# Two approaches",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      journal: journal()
    });
    vi.mocked(readRuntimeMissionProgress).mockResolvedValue({
      version: 1,
      state: "running",
      summary: "Mission work is progressing within its declared limits.",
      runStatus: "running",
      completedSteps: 0,
      totalSteps: 3,
      runningWorkers: 2,
      readyWorkers: 0,
      waitingSteps: 1,
      blockedSteps: 0,
      steps: [],
      usage: { records: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0, costObservations: [] },
      budget: { maxWorkers: 2 },
      acceptance: [],
      nextAction: "Wait for current bounded work to settle."
    });
  });

  it("recognizes only an explicit two-approach comparison request", () => {
    expect(isParallelApproachesMissionPrompt("Generate two independent approaches for onboarding and compare the trade-offs")).toBe(true);
    expect(isParallelApproachesMissionPrompt("Give me two approaches")).toBe(false);
    expect(isParallelApproachesMissionPrompt("Compare these ideas")).toBe(false);
  });

  it("creates reviewer intent only from an explicit judge or reviewer request", () => {
    expect(isReviewedParallelApproachesMissionPrompt(
      "Generate two independent approaches, compare them, then have an independent reviewer assess them"
    )).toBe(true);
    expect(isReviewedParallelApproachesMissionPrompt(
      "Create two different approaches and ask a judge to recommend one after the comparison"
    )).toBe(true);
    expect(isReviewedParallelApproachesMissionPrompt(
      "Generate two independent approaches and compare the trade-offs"
    )).toBe(false);
    expect(isReviewedParallelApproachesMissionPrompt("Have a reviewer assess this draft")).toBe(false);
  });

  it("opens the durable join before concurrently executing both bounded workers", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(executeLocalWorker).mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) release();
      await barrier;
      active -= 1;
      return { status: "completed", text: "Approach", events: [], usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, costUsd: 0, costUnknown: true }, retryable: false };
    });
    let counter = 0;
    const onProgress = vi.fn();
    const result = await executeParallelApproachesMission({
      prompt: "Generate two independent approaches for onboarding and compare the trade-offs",
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend: { providerId: "openai", backend: { backendType: "native-api" } } as never,
      model: "gpt-5",
      createId: (prefix) => `${prefix}-${++counter}`,
      onProgress
    });

    expect(result).toMatchObject({ outcome: "completed", artifactId: "artifact-1" });
    expect(openRuntimeParallelApproachesJoin).toHaveBeenCalledOnce();
    expect(executeLocalWorker).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
    expect(finalizeRuntimeParallelApproaches).toHaveBeenCalledOnce();
    expect(readRuntimeMissionProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
    const planInput = vi.mocked(createRuntimeMissionPlan).mock.calls[0][0];
    expect(planInput).toMatchObject({ executionDepth: "multi-worker", budget: { maxWorkers: 2 } });
    expect((planInput.steps as Array<{ key: string }>).map((step) => step.key))
      .toEqual(["approach-a", "approach-b", "compare"]);
  });

  it("keeps a non-OpenAI native provider pinned through both workers", async () => {
    vi.mocked(listRuntimeNativeProviderRoutes).mockResolvedValue([{
      id: "route-anthropic",
      workspaceId: "workspace-1",
      providerFamily: "anthropic",
      modelOrRuntimeReference: "claude-sonnet-4-5",
      boundaries: {},
      state: "available",
      health: "healthy"
    } as never]);
    vi.mocked(executeLocalWorker).mockResolvedValue({
      status: "completed", text: "Approach", events: [],
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, costUsd: 0, costUnknown: true },
      retryable: false
    });
    let counter = 0;
    await executeParallelApproachesMission({
      prompt: "Generate two independent approaches for onboarding and compare the trade-offs",
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend: {
        providerId: "anthropic",
        backend: { backendType: "native-api" }
      } as never,
      model: "claude-sonnet-4-5",
      createId: (prefix) => `${prefix}-${++counter}`
    });
    expect(vi.mocked(startRuntimeMissionWorker).mock.calls).toHaveLength(2);
    for (const [input] of vi.mocked(startRuntimeMissionWorker).mock.calls) {
      expect(input).toMatchObject({
        providerId: "anthropic",
        modelReference: "claude-sonnet-4-5",
        routeSelection: { providerRouteId: "route-anthropic" }
      });
    }
  });

  it("creates a native-derived reviewer only for an explicit reviewed comparison", async () => {
    vi.mocked(executeLocalWorker).mockResolvedValue({
      status: "completed", text: "Output", events: [],
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, costUsd: 0, costUnknown: true },
      retryable: false
    });
    const execution = {
      runId: "mission-run-reviewed", workerId: "worker-review", workerStartedEventId: "review-start",
      routeSelectedEventId: "review-route", usageEventId: "review-usage",
      completionEventId: "review-complete", evaluationEventId: "review-evaluation",
      resultEventId: "review-result", failureEventId: "review-failure",
      idempotencyKey: "review-terminal", expectedRunRevision: 12, expectedLastSequence: 11
    };
    vi.mocked(prepareRuntimeParallelApproachesReviewer).mockResolvedValue({
      missionId: "mission-reviewed", runId: "mission-run-reviewed", workerId: "worker-review",
      providerId: "openai", modelReference: "gpt-5", prompt: "Native prompt with exact A and B outputs.",
      maxOutputTokens: 2_048, alreadyCompleted: false, execution,
      journal: {
        run: { revision: 12, eventHead: { lastSequence: 11, lastEventId: "review-route" } },
        events: [{
          id: "review-created", type: "worker-created", payload: { worker: {
            id: "worker-review", runId: "mission-run-reviewed", status: "running",
            role: { kind: "reviewer", title: "Independent reviewer", objective: "Bounded summary", responsibilities: [] },
            budget: { maxDurationMs: 90_000, maxInputTokens: 32_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxAttempts: 1 },
            tools: [], outputContract: { slots: [{ key: "review", required: true, format: "text/markdown" }], includeEvidence: false, includeUncertainty: true, delivery: "run-result" }
          } }
        }]
      }
    } as never);
    let counter = 0;
    const result = await executeParallelApproachesMission({
      prompt: "Generate two independent approaches, compare them, then have an independent reviewer assess them",
      workspaceId: "workspace-1", sourceThreadId: "thread-1",
      backend: { providerId: "openai", backend: { backendType: "native-api" } } as never, model: "gpt-5",
      createId: (prefix) => `${prefix}-${++counter}`
    });

    expect(result.outcome).toBe("completed");
    expect(prepareRuntimeParallelApproachesReviewer).toHaveBeenCalledOnce();
    expect(executeLocalWorker).toHaveBeenCalledTimes(3);
    expect(vi.mocked(executeLocalWorker).mock.calls[2][0]).toMatchObject({
      prompt: "Native prompt with exact A and B outputs.",
      worker: { id: "worker-review", role: { objective: "Native prompt with exact A and B outputs." } },
      missionWorkerExecution: execution
    });
    const planInput = vi.mocked(createRuntimeMissionPlan).mock.calls[0][0];
    expect(planInput).toMatchObject({
      constraints: [{ key: "native:parallel-approaches:v2" }],
      budget: { maxWorkers: 3, maxDurationMs: 270_000, maxInputTokens: 64_000, maxOutputTokens: 6_144 },
      bounds: { maxSteps: 4, maxDependenciesPerStep: 3, maxParallelSteps: 2 }
    });
    expect((planInput.steps as Array<{ key: string }>).map((step) => step.key))
      .toEqual(["approach-a", "approach-b", "review", "compare"]);
  });

  it("resumes only the native-prepared reviewer after restart and then finalizes", async () => {
    vi.mocked(executeLocalWorker).mockResolvedValue({
      status: "completed", text: "Review", events: [],
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, costUsd: 0, costUnknown: true },
      retryable: false
    });
    vi.mocked(recoverRuntimeParallelApproachesReviewers).mockResolvedValue([{
      missionId: "mission-reviewed", runId: "run-reviewed", workerId: "worker-review",
      providerId: "openai", modelReference: "gpt-5", prompt: "Exact recovered review prompt",
      maxOutputTokens: 2_048, alreadyCompleted: false,
      execution: {
        runId: "run-reviewed", workerId: "worker-review", workerStartedEventId: "review-start",
        routeSelectedEventId: "review-route", usageEventId: "review-usage",
        completionEventId: "review-complete", evaluationEventId: "review-evaluation",
        resultEventId: "review-result", failureEventId: "review-failure",
        idempotencyKey: "review-terminal", expectedRunRevision: 12, expectedLastSequence: 11
      },
      journal: { run: {}, events: [{
        type: "worker-created", payload: { worker: {
          id: "worker-review", role: { objective: "Summary" }, tools: [],
          budget: { maxDurationMs: 90_000, maxInputTokens: 32_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxAttempts: 1 },
          outputContract: { slots: [{ key: "review", required: true, format: "text/markdown" }], includeEvidence: false, includeUncertainty: true, delivery: "run-result" }
        } }
      }] }
    }] as never);

    await expect(resumeReviewedParallelApproachesMissions({
      backend: { providerId: "openai", backend: { backendType: "native-api" }, cancel: vi.fn() } as never
    })).resolves.toEqual({ resumed: 1, finalized: 1 });
    expect(executeLocalWorker).toHaveBeenCalledOnce();
    expect(finalizeRuntimeParallelApproaches).toHaveBeenCalledWith("run-reviewed");
    expect(createRuntimeMissionRun).not.toHaveBeenCalled();
  });

  it("persists cancellation before aborting workers and closes the no-worker window", async () => {
    vi.mocked(executeLocalWorker).mockImplementation(async (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve({
          status: "cancelled", text: "", events: [],
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, costUsd: 0, costUnknown: true },
          retryable: false
        }), { once: true });
      }));
    const running = {
      run: { status: "running", revision: 12, eventHead: { lastSequence: 11, lastEventId: "worker-head" } },
      events: []
    };
    vi.mocked(getRuntimeMissionRun)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({
        run: { status: "cancelling", revision: 13, eventHead: { lastSequence: 12, lastEventId: "cancel-request" } },
        events: []
      })
      .mockResolvedValueOnce({
        run: { status: "cancelled", revision: 14, eventHead: { lastSequence: 13, lastEventId: "cancel-result" } },
        events: []
      });
    let rejectStale!: (error: Error) => void;
    const stale = new Promise<never>((_resolve, reject) => { rejectStale = reject; });
    vi.mocked(requestRuntimeMissionRunCancellation)
      .mockImplementationOnce(async () => stale)
      .mockResolvedValueOnce({ run: { status: "cancelling" }, events: [] });
    const backendCancel = vi.fn(async () => undefined);
    let cancel!: () => Promise<void>;
    let ready!: () => void;
    const cancellationReady = new Promise<void>((resolve) => { ready = resolve; });
    let counter = 0;
    const execution = executeParallelApproachesMission({
      prompt: "Generate two independent approaches for onboarding and compare the trade-offs",
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend: { providerId: "openai", backend: { backendType: "native-api" }, cancel: backendCancel } as never,
      model: "gpt-5",
      createId: (prefix) => `${prefix}-${++counter}`,
      onCancellationReady: (callback) => { cancel = callback; ready(); }
    });
    await cancellationReady;

    const stopping = cancel();
    await Promise.resolve();
    expect(backendCancel).not.toHaveBeenCalled();
    rejectStale(new Error("The mission run changed."));
    await stopping;

    await expect(execution).rejects.toThrow("cancelled");
    expect(backendCancel).toHaveBeenCalledWith(expect.stringMatching(/^mission-run-/));
    expect(getRuntimeMissionRun).toHaveBeenCalledTimes(4);
    expect(requestRuntimeMissionRunCancellation).toHaveBeenCalledTimes(2);
    expect(finalizeRuntimeMissionRunCancellation).toHaveBeenCalledOnce();
    expect(finalizeRuntimeParallelApproaches).toHaveBeenCalledWith(expect.stringMatching(/^mission-run-/));
  });
});
