import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  getRuntimeMissionPlan,
  getRuntimeMissionRun,
  readRuntimeMissionWorkerOutput,
  requestRuntimeMissionRunCancellation,
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
    await expect(getRuntimeMissionRun("run-1")).resolves.toBeNull();
    await expect(readRuntimeMissionWorkerOutput("mission-output:v1:ref")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
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
    const start = { runId: "run-1", workerId: "worker-1", runStartEventId: "event-run-start", workerStartedEventId: "event-worker-start", routeSelectedEventId: "event-route", providerId: "openai", modelReference: "gpt-5", idempotencyKey: "start-1", expectedRunRevision: 3, expectedLastSequence: 2 };

    await createRuntimeMissionPlan(plan);
    await createRuntimeMissionRun(run);
    await createRuntimeMissionWorker(worker);
    await startRuntimeMissionWorker(start);
    await getRuntimeMissionPlan("mission-1");
    await getRuntimeMissionRun("run-1");
    const cancel = { runId: "run-1", eventId: "event-cancel", requestKey: "stop-1", expectedRunRevision: 3, expectedLastSequence: 2, mode: "cooperative" as const, reason: "User requested stop." };
    await requestRuntimeMissionRunCancellation(cancel);
    await readRuntimeMissionWorkerOutput("mission-output:v1:ref");

    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_plan_create", { input: plan }],
      ["mission_run_create", { input: run }],
      ["mission_worker_create", { input: worker }],
      ["mission_worker_start", { input: start }],
      ["mission_plan_get", { missionId: "mission-1" }],
      ["mission_run_get", { runId: "run-1" }],
      ["mission_run_request_cancellation", { input: cancel }],
      ["mission_worker_output_read", { valueReference: "mission-output:v1:ref" }]
    ]);
  });
});
