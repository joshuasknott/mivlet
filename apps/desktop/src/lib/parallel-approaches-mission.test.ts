import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeLocalWorker } from "@fable/connectors";
import {
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  finalizeRuntimeParallelApproaches,
  getRuntimeMissionRun,
  listRuntimeNativeProviderRoutes,
  openRuntimeParallelApproachesJoin,
  requestRuntimeMissionRunCancellation,
  startRuntimeMissionWorker
} from "../runtime";
import { executeParallelApproachesMission, isParallelApproachesMissionPrompt } from "./parallel-approaches-mission";

vi.mock("@fable/connectors", () => ({
  catalogueCapabilities: vi.fn(() => ({ tools: true, contextWindow: 128_000 })),
  selectMissionProviderRoute: vi.fn(() => ({
    selection: {
      providerRouteId: "route-openai",
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
  finalizeRuntimeParallelApproaches: vi.fn(),
  getRuntimeMissionRun: vi.fn(),
  listRuntimeNativeProviderRoutes: vi.fn(),
  openRuntimeParallelApproachesJoin: vi.fn(),
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
  });

  it("recognizes only an explicit two-approach comparison request", () => {
    expect(isParallelApproachesMissionPrompt("Generate two independent approaches for onboarding and compare the trade-offs")).toBe(true);
    expect(isParallelApproachesMissionPrompt("Give me two approaches")).toBe(false);
    expect(isParallelApproachesMissionPrompt("Compare these ideas")).toBe(false);
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
    const result = await executeParallelApproachesMission({
      prompt: "Generate two independent approaches for onboarding and compare the trade-offs",
      workspaceId: "workspace-1",
      sourceThreadId: "thread-1",
      backend: { providerId: "openai" } as never,
      model: "gpt-5",
      createId: (prefix) => `${prefix}-${++counter}`
    });

    expect(result).toMatchObject({ outcome: "completed", artifactId: "artifact-1" });
    expect(openRuntimeParallelApproachesJoin).toHaveBeenCalledOnce();
    expect(executeLocalWorker).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(2);
    expect(finalizeRuntimeParallelApproaches).toHaveBeenCalledOnce();
    const planInput = vi.mocked(createRuntimeMissionPlan).mock.calls[0][0];
    expect(planInput).toMatchObject({ executionDepth: "multi-worker", budget: { maxWorkers: 2 } });
    expect((planInput.steps as Array<{ key: string }>).map((step) => step.key))
      .toEqual(["approach-a", "approach-b", "compare"]);
  });

  it("aborts both workers immediately and retries a stale durable stop head", async () => {
    vi.mocked(executeLocalWorker).mockImplementation(async (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve({
          status: "cancelled", text: "", events: [],
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, costUsd: 0, costUnknown: true },
          retryable: false
        }), { once: true });
      }));
    vi.mocked(getRuntimeMissionRun).mockResolvedValue({
      run: { status: "running", revision: 12, eventHead: { lastSequence: 11, lastEventId: "worker-head" } },
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
      backend: { providerId: "openai", cancel: backendCancel } as never,
      model: "gpt-5",
      createId: (prefix) => `${prefix}-${++counter}`,
      onCancellationReady: (callback) => { cancel = callback; ready(); }
    });
    await cancellationReady;

    const stopping = cancel();
    await Promise.resolve();
    expect(backendCancel).toHaveBeenCalledWith(expect.stringMatching(/^mission-run-/));
    rejectStale(new Error("The mission run changed."));
    await stopping;

    await expect(execution).rejects.toThrow("cancelled");
    expect(getRuntimeMissionRun).toHaveBeenCalledTimes(2);
    expect(requestRuntimeMissionRunCancellation).toHaveBeenCalledTimes(2);
    expect(finalizeRuntimeParallelApproaches).not.toHaveBeenCalled();
  });
});
