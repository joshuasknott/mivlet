import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeMissionCheckpoint,
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  getRuntimeMissionPlan,
  getRuntimeCitedMissionPlanSummary,
  getRuntimeMissionRun,
  latestRuntimeCitedApproval,
  listRuntimePendingCitedApprovals,
  listRuntimeNativeProviderRoutes,
  prepareRuntimeCitedMissionRetry,
  readRuntimeCitedMissionReceipts,
  readRuntimeCitedMissionPlanSummaries,
  readRuntimeMissionWorkerOutput,
  recoverRuntimeInterruptedCitedMissions,
  requestRuntimeMissionRunCancellation,
  restoreRuntimeMissionCheckpoint,
  startRuntimeMissionWorker
} from "./runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("mission runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
  });

  it("does not simulate mission durability outside Tauri", async () => {
    await expect(getRuntimeMissionPlan("mission-1")).resolves.toBeNull();
    await expect(getRuntimeCitedMissionPlanSummary("mission-1")).resolves.toBeNull();
    await expect(getRuntimeMissionRun("run-1")).resolves.toBeNull();
    await expect(readRuntimeMissionWorkerOutput("mission-output:v1:ref")).resolves.toBeNull();
    await expect(readRuntimeCitedMissionReceipts("thread-1", ["message-1"])).resolves.toBeNull();
    await expect(readRuntimeCitedMissionPlanSummaries("thread-1", ["message-1"])).resolves.toBeNull();
    await expect(listRuntimeNativeProviderRoutes()).resolves.toBeNull();
    await expect(recoverRuntimeInterruptedCitedMissions()).resolves.toBeNull();
    await expect(prepareRuntimeCitedMissionRetry("run-1")).resolves.toBeNull();
    await expect(listRuntimePendingCitedApprovals("thread-1")).resolves.toEqual({
      approvals: [], unavailableCount: 0, truncated: false
    });
    await expect(restoreRuntimeMissionCheckpoint({
      runId: "run-1", eventId: "event-restore", idempotencyKey: "restore-1",
      expectedRunRevision: 5, expectedLastSequence: 4, newAttemptNumber: 2
    })).resolves.toBeNull();
    await expect(createRuntimeMissionCheckpoint({
      runId: "run-1", eventId: "event-checkpoint", idempotencyKey: "checkpoint-1",
      expectedRunRevision: 4, expectedLastSequence: 3, attemptNumber: 1,
      durableThroughSequence: 3, resumeAfterEventId: "event-tool"
    })).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("selects one deterministic newest dormant cited approval", () => {
    const approval = (runId: string, requestedAt: string) => ({
      runId, missionId: `mission-${runId}`, waitKey: `wait-${runId}`, requestedAt,
      expectedRunRevision: 4, expectedLastSequence: 8,
      valueReference: `mission-output:v1:${runId}`, draft: "Draft", plan: {}
    });
    expect(latestRuntimeCitedApproval([
      approval("run-b", "2026-07-13T12:00:00.000Z"),
      approval("run-old", "2026-07-12T12:00:00.000Z"),
      approval("run-a", "2026-07-13T12:00:00.000Z")
    ])?.runId).toBe("run-b");
    expect(latestRuntimeCitedApproval([])).toBeUndefined();
  });

  it("accepts only the bounded native pending-approval projection", async () => {
    setNative(true);
    const approval = {
      runId: "run-1", missionId: "mission-1", waitKey: "wait-1",
      requestedAt: "2026-07-13T12:00:00.000Z", expectedRunRevision: 4,
      expectedLastSequence: 8, valueReference: "mission-output:v1:run-1",
      draft: "Draft", plan: {}
    };
    mocks.invoke.mockResolvedValueOnce({ approvals: [approval], unavailableCount: 1, truncated: true });
    await expect(listRuntimePendingCitedApprovals("thread-1")).resolves.toEqual({
      approvals: [approval], unavailableCount: 1, truncated: true
    });
    mocks.invoke.mockResolvedValueOnce({ approvals: [approval], unavailableCount: -1, truncated: false });
    await expect(listRuntimePendingCitedApprovals("thread-1")).rejects.toThrow("Malformed cited approval projection");
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_cited_approval_pending_list", { threadId: "thread-1" }],
      ["mission_cited_approval_pending_list", { threadId: "thread-1" }]
    ]);
  });

  it("composes only the authenticated native mission commands", async () => {
    setNative(true);
    mocks.invoke.mockResolvedValue({});
    const plan = {
      missionId: "mission-1", planId: "plan-1", planRevisionId: "revision-1",
      executionDepth: "delegated" as const,
      outcome: { summary: "Brief", deliverables: [{ key: "brief", description: "Brief", required: true }] },
      missionScope: { workspaceId: "display-only" }, constraints: [],
      acceptance: { requiresHumanAcceptance: false, criteria: [{ key: "cited", description: "Cited", required: true, evaluator: "policy" }] },
      summary: "Search connected work", bounds: { maxSteps: 1, maxDependenciesPerStep: 0, maxParallelSteps: 1 },
      steps: [{ key: "search", kind: "investigate", title: "Search", objective: "Produce a cited brief", dependsOnStepKeys: [], requiredCapabilities: ["knowledge.content.search"], expectedOutputs: [{ key: "brief", description: "Brief", required: true }], acceptanceCriterionKeys: ["cited"], optional: false }]
    };
    const run = { missionId: "mission-1", runId: "run-1", eventId: "event-create", idempotencyKey: "create-1" };
    const worker = { runId: "run-1", eventId: "event-worker", idempotencyKey: "worker-1", expectedRunRevision: 2, expectedLastSequence: 1, workerId: "worker-1", stepKey: "search", context: [], grants: [{ capabilityId: "knowledge.content.search", capabilityGrantId: "grant-1" }] };
    const start = { runId: "run-1", workerId: "worker-1", runStartEventId: "event-run-start", workerStartedEventId: "event-worker-start", routeSelectedEventId: "event-route", providerId: "openai", modelReference: "gpt-5", routeSelection: { providerRouteId: "route-1" as never, selectedAt: "2026-07-13T00:00:00Z", reason: "Selected route.", boundaryPolicyRef: "boundary:test" }, idempotencyKey: "start-1", expectedRunRevision: 3, expectedLastSequence: 2 };

    await createRuntimeMissionPlan(plan);
    await createRuntimeMissionRun(run);
    await createRuntimeMissionWorker(worker);
    await startRuntimeMissionWorker(start);
    await getRuntimeMissionPlan("mission-1");
    await getRuntimeCitedMissionPlanSummary("mission-1");
    await getRuntimeMissionRun("run-1");
    const cancel = { runId: "run-1", eventId: "event-cancel", requestKey: "stop-1", expectedRunRevision: 3, expectedLastSequence: 2, mode: "cooperative" as const, reason: "User requested stop." };
    await requestRuntimeMissionRunCancellation(cancel);
    await readRuntimeMissionWorkerOutput("mission-output:v1:ref");
    await readRuntimeCitedMissionReceipts("thread-1", ["message-1"]);
    await readRuntimeCitedMissionPlanSummaries("thread-1", ["message-1"]);
    await listRuntimeNativeProviderRoutes();
    await recoverRuntimeInterruptedCitedMissions();
    await prepareRuntimeCitedMissionRetry("run-1");
    const restore = {
      runId: "run-1", eventId: "event-restore", idempotencyKey: "restore-1",
      expectedRunRevision: 5, expectedLastSequence: 4, newAttemptNumber: 2
    };
    await restoreRuntimeMissionCheckpoint(restore);
    const checkpoint = {
      runId: "run-1", eventId: "event-checkpoint", idempotencyKey: "checkpoint-1",
      expectedRunRevision: 4, expectedLastSequence: 3, attemptNumber: 1,
      durableThroughSequence: 3, resumeAfterEventId: "event-tool"
    };
    await createRuntimeMissionCheckpoint(checkpoint);

    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_plan_create", { input: plan }],
      ["mission_run_create", { input: run }],
      ["mission_worker_create", { input: worker }],
      ["mission_worker_start", { input: start }],
      ["mission_plan_get", { missionId: "mission-1" }],
      ["mission_plan_cited_summary_get", { missionId: "mission-1" }],
      ["mission_run_get", { runId: "run-1" }],
      ["mission_run_request_cancellation", { input: cancel }],
      ["mission_worker_output_read", { valueReference: "mission-output:v1:ref" }],
      ["mission_worker_cited_receipts_read", { input: { threadId: "thread-1", messageIds: ["message-1"] } }],
      ["mission_plan_cited_summaries_read", { input: { threadId: "thread-1", messageIds: ["message-1"] } }],
      ["list_native_provider_routes"],
      ["mission_run_recover_interrupted_cited"],
      ["mission_run_prepare_cited_retry", { input: { runId: "run-1" } }],
      ["mission_run_restore_checkpoint", { input: restore }],
      ["mission_run_create_checkpoint", { input: checkpoint }]
    ]);
  });
});
