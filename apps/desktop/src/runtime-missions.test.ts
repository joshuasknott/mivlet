import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceRuntimeMissionCoordination,
  cancelRuntimeMissionApproval,
  cancelRuntimeMissionHumanInput,
  createRuntimeMissionCheckpoint,
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  finalizeRuntimeMissionCoordination,
  getRuntimeMissionPlan,
  getRuntimeCitedMissionPlanSummary,
  getRuntimeMissionRun,
  latestRuntimeCitedApproval,
  latestRuntimeMissionApproval,
  latestRuntimeMissionHumanInput,
  latestRuntimePendingMissionWait,
  listRuntimePendingCitedApprovals,
  listRuntimePendingMissionApprovals,
  listRuntimePendingMissionHumanInputs,
  listRuntimeThreadMissionProgress,
  listRuntimeNativeProviderRoutes,
  openRuntimeMissionJoin,
  openRuntimeParallelApproachesJoin,
  prepareRuntimeMissionWorkers,
  prepareRuntimeParallelApproachesReviewer,
  recoverRuntimeParallelApproachesReviewers,
  finalizeRuntimeParallelApproaches,
  recoverRuntimeCompletedParallelApproaches,
  prepareRuntimeCitedMissionRetry,
  recordRuntimeMissionAggregation,
  receiveRuntimeMissionHumanInput,
  verifiedLatestRuntimePendingMissionWait,
  readRuntimeCitedMissionReceipts,
  readRuntimeCitedMissionPlanSummaries,
  readRuntimeMissionProgress,
  recordRuntimeMissionHumanEvaluation,
  readRuntimeMissionWorkerOutput,
  recoverRuntimeInterruptedCitedMissions,
  recoverRuntimeInterruptedGeneralMissions,
  requestRuntimeMissionRunCancellation,
  requestRuntimeMissionApproval,
  requestRuntimeMissionHumanInput,
  resolveRuntimeMissionJoin,
  resolveRuntimeMissionApproval,
  restoreRuntimeMissionCheckpoint,
  startRuntimeArtifactRevisionBrief,
  startRuntimeStructuredIntake,
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
    await expect(readRuntimeMissionProgress("run-1")).resolves.toBeNull();
    await expect(listRuntimeThreadMissionProgress("thread-1")).resolves.toEqual({
      progress: [], unavailableCount: 0, truncated: false
    });
    await expect(recordRuntimeMissionHumanEvaluation({
      runId: "run-1", criterionKey: "review", passed: true,
      expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toBeNull();
    await expect(advanceRuntimeMissionCoordination("run-1")).resolves.toBeNull();
    await expect(finalizeRuntimeMissionCoordination("run-1")).resolves.toBeNull();
    await expect(listRuntimeNativeProviderRoutes()).resolves.toBeNull();
    await expect(recoverRuntimeInterruptedCitedMissions()).resolves.toBeNull();
    await expect(recoverRuntimeInterruptedGeneralMissions()).resolves.toBeNull();
    await expect(openRuntimeMissionJoin({
      runId: "run-1", targetStepKey: "combine", strategy: "all",
      allowFailedWorkers: false, eventId: "event-join-open", idempotencyKey: "join-open-1",
      expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toBeNull();
    await expect(resolveRuntimeMissionJoin({
      runId: "run-1", joinKey: "mission_join_1", eventId: "event-join-resolve",
      idempotencyKey: "join-resolve-1", expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toBeNull();
    await expect(recordRuntimeMissionAggregation({
      runId: "run-1", targetStepKey: "combine", eventId: "event-aggregation",
      idempotencyKey: "aggregation-1", expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toBeNull();
    await expect(openRuntimeParallelApproachesJoin({
      runId: "run-1", expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toBeNull();
    await expect(prepareRuntimeParallelApproachesReviewer("run-1")).resolves.toBeNull();
    await expect(recoverRuntimeParallelApproachesReviewers()).resolves.toBeNull();
    await expect(finalizeRuntimeParallelApproaches("run-1")).resolves.toBeNull();
    await expect(recoverRuntimeCompletedParallelApproaches()).resolves.toBeNull();
    await expect(prepareRuntimeCitedMissionRetry("run-1")).resolves.toBeNull();
    await expect(listRuntimePendingCitedApprovals("thread-1")).resolves.toEqual({
      approvals: [], unavailableCount: 0, truncated: false
    });
    await expect(listRuntimePendingMissionApprovals("thread-1")).resolves.toEqual({
      approvals: [], unavailableCount: 0, truncated: false
    });
    await expect(requestRuntimeMissionApproval({
      runId: "run-1", requestKey: "publish-1",
      expectedRunRevision: 4, expectedLastSequence: 3,
      actionSummary: "Publish one reviewed update.", proposalHash: "a".repeat(64),
      effect: {
        effectKey: "publish:update-1", idempotencyKey: "publish:update-1",
        targetSummary: "One reviewed update"
      }
    })).resolves.toBeNull();
    await expect(listRuntimePendingMissionHumanInputs("thread-1")).resolves.toEqual({
      requests: [], unavailableCount: 0, truncated: false
    });
    await expect(requestRuntimeMissionHumanInput({
      runId: "run-1", requestKey: "input-1", expectedRunRevision: 4, expectedLastSequence: 3,
      prompt: "Choose a region.",
      fields: [{ key: "region", label: "Region", kind: "choice", required: true, sensitive: false, choices: ["UK", "EU"] }]
    })).resolves.toBeNull();
    await expect(startRuntimeStructuredIntake({
      sourceThreadId: "thread-1", subject: "Launch", startKey: "start-1"
    })).resolves.toBeNull();
    await expect(startRuntimeArtifactRevisionBrief({
      sourceThreadId: "thread-1", focus: "Launch memo", startKey: "start-2"
    })).resolves.toBeNull();
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

  it("validates and normalizes parallel mission settlement responses", async () => {
    setNative(true);
    const journal = { run: { id: "run-1", status: "completed" }, events: [] };
    const completed = {
      missionId: "mission-1", runId: "run-1", outcome: "completed", text: "Comparison",
      artifactId: "artifact-1", artifactVersionId: "artifact-version-1", journal
    };
    mocks.invoke
      .mockResolvedValueOnce(journal)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce([{ ...completed, artifactId: null, outcome: "partial", artifactVersionId: null }]);
    await expect(openRuntimeParallelApproachesJoin({
      runId: "run-1", expectedRunRevision: 4, expectedLastSequence: 3
    })).resolves.toEqual(journal);
    await expect(finalizeRuntimeParallelApproaches("run-1")).resolves.toEqual(completed);
    await expect(recoverRuntimeCompletedParallelApproaches()).resolves.toEqual([{
      missionId: "mission-1", runId: "run-1", outcome: "partial", text: "Comparison", journal
    }]);
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_parallel_approaches_join_open", { input: {
        runId: "run-1", expectedRunRevision: 4, expectedLastSequence: 3
      } }],
      ["mission_parallel_approaches_finalize", { runId: "run-1" }],
      ["mission_parallel_approaches_recover_completed"]
    ]);

    mocks.invoke.mockResolvedValueOnce({ ...completed, outcome: "partial" });
    await expect(finalizeRuntimeParallelApproaches("run-1"))
      .rejects.toThrow("Malformed parallel mission result response");
  });

  it("accepts only an exact native reviewer preparation", async () => {
    setNative(true);
    const journal = { run: { id: "run-1", status: "running" }, events: [] };
    const preparation = {
      missionId: "mission-1", runId: "run-1", workerId: "worker-review",
      providerId: "openai", modelReference: "gpt-5", prompt: "Native review prompt",
      maxOutputTokens: 2_048, alreadyCompleted: false,
      execution: {
        runId: "run-1", workerId: "worker-review", workerStartedEventId: "event-start",
        routeSelectedEventId: "event-route", usageEventId: "event-usage",
        completionEventId: "event-complete", evaluationEventId: "event-evaluation",
        resultEventId: "event-result", failureEventId: "event-failure",
        idempotencyKey: "review-terminal", expectedRunRevision: 12, expectedLastSequence: 11
      },
      journal
    };
    mocks.invoke.mockResolvedValueOnce(preparation).mockResolvedValueOnce([preparation]);
    await expect(prepareRuntimeParallelApproachesReviewer("run-1")).resolves.toEqual(preparation);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "mission_parallel_approaches_reviewer_prepare", { input: { runId: "run-1" } }
    );
    await expect(recoverRuntimeParallelApproachesReviewers()).resolves.toEqual([preparation]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("mission_parallel_approaches_reviewer_recover");

    mocks.invoke.mockResolvedValueOnce({ ...preparation, providerId: "anthropic" });
    await expect(prepareRuntimeParallelApproachesReviewer("run-1"))
      .resolves.toEqual({ ...preparation, providerId: "anthropic" });
    mocks.invoke.mockResolvedValueOnce({ ...preparation, providerId: "unknown/provider" });
    await expect(prepareRuntimeParallelApproachesReviewer("run-1"))
      .rejects.toThrow("Malformed parallel reviewer preparation response");
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

  it("selects one deterministic newest dormant human-input wait", () => {
    const request = (runId: string, requestedAt: string) => ({
      runId, missionId: `mission-${runId}`, sourceThreadId: "thread-1", waitKey: `wait-${runId}`,
      requestKey: `request-${runId}`, prompt: "Choose.", fields: [{
        key: "choice", label: "Choice", kind: "choice" as const, required: true,
        sensitive: false as const, choices: ["A", "B"]
      }], requestedAt, runRevision: 4, lastSequence: 8
    });
    expect(latestRuntimeMissionHumanInput([
      request("run-b", "2026-07-13T12:00:00.000Z"),
      request("run-old", "2026-07-12T12:00:00.000Z"),
      request("run-a", "2026-07-13T12:00:00.000Z")
    ])?.runId).toBe("run-b");
    expect(latestRuntimeMissionHumanInput([])).toBeUndefined();

    const approval = {
      runId: "approval-run", missionId: "approval-mission", waitKey: "approval-wait",
      requestedAt: "2026-07-13T12:00:00.000Z", expectedRunRevision: 4,
      expectedLastSequence: 8, valueReference: "mission-output:v1:approval", draft: "Draft", plan: {}
    };
    const newest = request("input-run", "2026-07-13T13:00:00.000Z");
    const approvalList = { approvals: [approval], unavailableCount: 0, truncated: false };
    const inputList = { requests: [newest], unavailableCount: 0, truncated: false };
    const effectApproval = {
      runId: "effect-run", missionId: "effect-mission", sourceThreadId: "thread-1",
      planRevisionId: "revision-1",
      waitKey: `mission-approval-wait:v1:${"a".repeat(64)}`, requestKey: "publish-1",
      actionSummary: "Publish one update.", proposalHash: "b".repeat(64),
      effect: {
        effectKey: "publish:update-1", idempotencyKey: "publish:update-1",
        targetSummary: "One update"
      },
      requestedAt: "2026-07-13T14:00:00.000Z", runRevision: 6, lastSequence: 5
    };
    const effectList = {
      approvals: [effectApproval],
      unavailableCount: 0,
      truncated: false
    };
    expect(latestRuntimeMissionApproval([
      { ...effectApproval, runId: "effect-a" },
      effectApproval,
      { ...effectApproval, runId: "effect-old", requestedAt: "2026-07-12T14:00:00.000Z" }
    ])?.runId).toBe("effect-run");
    expect(latestRuntimePendingMissionWait(approvalList, inputList)).toEqual({
      kind: "human-input", request: newest
    });
    expect(latestRuntimePendingMissionWait(approvalList, inputList, effectList)).toEqual({
      kind: "effect-approval", request: effectApproval
    });
    expect(latestRuntimePendingMissionWait(approvalList, { ...inputList, requests: [] })).toEqual({
      kind: "approval", request: approval
    });
    expect(latestRuntimePendingMissionWait(
      { ...approvalList, truncated: true }, inputList
    )).toBeUndefined();
    expect(latestRuntimePendingMissionWait(
      approvalList, { ...inputList, unavailableCount: 1 }
    )).toBeUndefined();
    expect(latestRuntimePendingMissionWait(
      approvalList, inputList, { ...effectList, truncated: true }
    )).toBeUndefined();
    expect(() => verifiedLatestRuntimePendingMissionWait(
      { status: "fulfilled", value: approvalList },
      { status: "fulfilled", value: { ...inputList, truncated: true } }
    )).toThrow("nothing was stopped");
    expect(() => verifiedLatestRuntimePendingMissionWait(
      { status: "rejected", reason: new Error("offline") },
      { status: "fulfilled", value: inputList }
    )).toThrow("nothing was stopped");
    expect(() => verifiedLatestRuntimePendingMissionWait(
      { status: "fulfilled", value: approvalList },
      { status: "fulfilled", value: inputList },
      { status: "rejected", reason: new Error("offline") }
    )).toThrow("nothing was stopped");
  });

  it("lists secret-safe Mission progress for one conversation", async () => {
    setNative(true);
    mocks.invoke.mockResolvedValueOnce({
      progress: [{
        runId: "run-1",
        progress: {
          version: 1,
          state: "running",
          summary: "Mission work is progressing within its declared limits.",
          runStatus: "running",
          completedSteps: 0,
          totalSteps: 1,
          runningWorkers: 1,
          readyWorkers: 0,
          waitingSteps: 0,
          blockedSteps: 0,
          steps: [],
          usage: {
            records: 0, inputTokens: 0, outputTokens: 0,
            toolCalls: 0, durationMs: 0, costObservations: []
          },
          budget: { maxWorkers: 1 },
          acceptance: [],
          nextAction: "Wait for current bounded work to settle."
        }
      }],
      unavailableCount: 0,
      truncated: false
    });

    await expect(listRuntimeThreadMissionProgress("thread-1", 12)).resolves.toEqual(
      expect.objectContaining({ unavailableCount: 0, truncated: false })
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "mission_coordination_progress_list",
      { input: { sourceThreadId: "thread-1", limit: 12 } }
    );
  });

  it("rejects malformed general Mission approval identities before cancellation", async () => {
    setNative(true);
    await expect(cancelRuntimeMissionApproval({
      runId: "run-approval", missionId: "mission-approval", sourceThreadId: "thread-1",
      planRevisionId: "revision-1", waitKey: "mission-approval-wait:v1:not-a-digest",
      requestKey: "publish-1", actionSummary: "Publish one update.",
      proposalHash: "b".repeat(64),
      effect: {
        effectKey: "publish:update-1", idempotencyKey: "publish:update-1",
        targetSummary: "One update"
      },
      requestedAt: "2026-07-23T12:00:00Z", runRevision: 6, lastSequence: 5
    })).rejects.toThrow("identity is invalid");
    expect(mocks.invoke).not.toHaveBeenCalled();
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

  it("composes exact provider-neutral Mission approval waits", async () => {
    setNative(true);
    const effect = {
      effectKey: "publish:update-1", idempotencyKey: "publish:update-1",
      targetSummary: "One reviewed update"
    };
    const request = {
      runId: "run-1", workerId: "worker-1", requestKey: "publish-1",
      expectedRunRevision: 4, expectedLastSequence: 3,
      actionSummary: "Publish one reviewed update.", proposalHash: "a".repeat(64), effect
    };
    const pending = {
      runId: "run-1", missionId: "mission-1", sourceThreadId: "thread-1",
      planRevisionId: "revision-1", workerId: "worker-1",
      waitKey: `mission-approval-wait:v1:${"b".repeat(64)}`,
      requestKey: "publish-1", actionSummary: request.actionSummary,
      proposalHash: request.proposalHash, effect,
      requestedAt: "2026-07-23T12:00:00.000Z",
      runRevision: 6, lastSequence: 5
    };
    const receipt = {
      runId: "run-1", waitKey: pending.waitKey, decision: "approved",
      proposalHash: request.proposalHash, effect, decidedAt: "2026-07-23T12:01:00.000Z",
      runRevision: 7, lastSequence: 6
    };
    mocks.invoke
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ approvals: [pending], unavailableCount: 0, truncated: false })
      .mockResolvedValueOnce(receipt);
    await expect(requestRuntimeMissionApproval(request)).resolves.toEqual(pending);
    await expect(listRuntimePendingMissionApprovals("thread-1", 20)).resolves.toEqual({
      approvals: [pending], unavailableCount: 0, truncated: false
    });
    await expect(resolveRuntimeMissionApproval(pending, "approved")).resolves.toEqual(receipt);
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_approval_request", { input: request }],
      ["mission_approval_pending_list", { input: { sourceThreadId: "thread-1", limit: 20 } }],
      ["mission_approval_resolve", { input: {
        runId: "run-1", waitKey: pending.waitKey, decision: "approved",
        expectedRunRevision: 6, expectedLastSequence: 5
      } }]
    ]);

    mocks.invoke.mockResolvedValueOnce({ ...pending, proposalHash: "renderer-claim" });
    await expect(requestRuntimeMissionApproval(request))
      .rejects.toThrow("Malformed Mission approval response");
  });

  it("composes and strictly validates the native human-input wait commands", async () => {
    setNative(true);
    const field = {
      key: "region", label: "Region", help: "Choose the accountable region.", kind: "choice" as const,
      required: true, sensitive: false as const, choices: ["UK", "EU"]
    };
    const request = {
      runId: "run-1", missionId: "mission-1", sourceThreadId: "thread-1", waitKey: "human-input-wait:v1:test",
      requestKey: "request-1", prompt: "Choose a region.", fields: [field],
      requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
    const create = {
      runId: "run-1", requestKey: "request-1", expectedRunRevision: 3, expectedLastSequence: 2,
      prompt: "Choose a region.", fields: [field]
    };
    mocks.invoke
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce({ requests: [request], unavailableCount: 0, truncated: false })
      .mockResolvedValueOnce({
        runId: "run-1", waitKey: "human-input-wait:v1:test", status: "received",
        receivedAt: "2026-07-13T12:01:00Z", runRevision: 6, lastSequence: 5
      });
    await expect(requestRuntimeMissionHumanInput(create)).resolves.toEqual(request);
    await expect(listRuntimePendingMissionHumanInputs("thread-1", 20)).resolves.toEqual({
      requests: [request], unavailableCount: 0, truncated: false
    });
    await expect(receiveRuntimeMissionHumanInput(request, [{ fieldKey: "region", value: "UK" }]))
      .resolves.toMatchObject({ status: "received", runRevision: 6 });
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_human_input_request", { input: create }],
      ["mission_human_input_pending_list", { input: { sourceThreadId: "thread-1", limit: 20 } }],
      ["mission_human_input_receive", { input: {
        runId: "run-1", waitKey: "human-input-wait:v1:test", expectedRunRevision: 5,
        expectedLastSequence: 4, values: [{ fieldKey: "region", value: "UK" }]
      } }]
    ]);

    mocks.invoke.mockResolvedValueOnce({
      requests: [{ ...request, fields: [{ ...field, sensitive: true }] }], unavailableCount: 0, truncated: false
    });
    await expect(listRuntimePendingMissionHumanInputs("thread-1"))
      .rejects.toThrow("Malformed human-input wait list");
  });

  it("composes and strictly validates native structured-intake start", async () => {
    setNative(true);
    const request = {
      runId: "run-intake", missionId: "mission-intake", sourceThreadId: "thread-1",
      waitKey: "human-input-wait:v1:intake", requestKey: "structured-intake:v1",
      prompt: "Tell Fable what belongs in this project brief.",
      fields: [{ key: "title", label: "Title", kind: "text" as const, required: true, sensitive: false as const }],
      requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
    mocks.invoke.mockResolvedValueOnce(request);
    await expect(startRuntimeStructuredIntake({
      sourceThreadId: "thread-1", projectId: "project-1", subject: "Launch", startKey: "start-1"
    })).resolves.toEqual(request);
    expect(mocks.invoke).toHaveBeenCalledWith("mission_structured_intake_start", { input: {
      sourceThreadId: "thread-1", projectId: "project-1", subject: "Launch", startKey: "start-1"
    } });

    mocks.invoke.mockResolvedValueOnce({ ...request, fields: [{ ...request.fields[0], sensitive: true }] });
    await expect(startRuntimeStructuredIntake({
      sourceThreadId: "thread-1", subject: "Launch", startKey: "start-2"
    })).rejects.toThrow("Malformed structured-intake wait projection");
  });

  it("composes an artifact revision-brief start and validates exact artifact identities before invoke", async () => {
    setNative(true);
    const fields = [
      { key: "sourceArtifact", label: "Source artifact", kind: "artifact" as const, required: true, sensitive: false as const },
      { key: "objective", label: "Objective", kind: "text" as const, required: true, sensitive: false as const }
    ];
    const request = {
      runId: "run-revision", missionId: "mission-revision", sourceThreadId: "thread-1", projectId: "project-1",
      waitKey: "human-input-wait:v1:revision", requestKey: "artifact-revision-brief:v1",
      prompt: "Choose an artifact.", fields, requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
    mocks.invoke.mockResolvedValueOnce(request).mockResolvedValueOnce({
      runId: "run-revision", waitKey: "human-input-wait:v1:revision", status: "received",
      receivedAt: "2026-07-13T12:01:00Z", runRevision: 6, lastSequence: 5
    });
    const start = { sourceThreadId: "thread-1", projectId: "project-1", focus: "Launch", startKey: "start-1" };
    await expect(startRuntimeArtifactRevisionBrief(start)).resolves.toEqual(request);
    await expect(receiveRuntimeMissionHumanInput(request, [
      { fieldKey: "sourceArtifact", value: { artifactId: "artifact-1", artifactVersionId: "version-2" } },
      { fieldKey: "objective", value: "Clarify the decision." }
    ])).resolves.toMatchObject({ status: "received" });
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_artifact_revision_brief_start", { input: start }],
      ["mission_human_input_receive", { input: {
        runId: "run-revision", waitKey: "human-input-wait:v1:revision",
        expectedRunRevision: 5, expectedLastSequence: 4,
        values: [
          { fieldKey: "sourceArtifact", value: { artifactId: "artifact-1", artifactVersionId: "version-2" } },
          { fieldKey: "objective", value: "Clarify the decision." }
        ]
      } }]
    ]);

    await expect(receiveRuntimeMissionHumanInput(request, [
      { fieldKey: "sourceArtifact", value: {
        artifactId: "artifact-1", artifactVersionId: "version-2", contentHash: "renderer-controlled"
      } as never },
      { fieldKey: "objective", value: "Clarify the decision." }
    ])).rejects.toThrow("do not match");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    mocks.invoke.mockResolvedValueOnce({ ...request, projectId: "" });
    await expect(startRuntimeArtifactRevisionBrief({ ...start, startKey: "start-2" }))
      .rejects.toThrow("Malformed artifact revision-brief wait projection");
  });

  it("accepts the native atomic terminal result when stopping dormant human input", async () => {
    setNative(true);
    const request = {
      runId: "run-1", missionId: "mission-1", sourceThreadId: "thread-1",
      waitKey: "human-input-wait:v1:test", requestKey: "request-1", prompt: "Choose.",
      fields: [{ key: "region", label: "Region", kind: "choice" as const, required: true,
        sensitive: false as const, choices: ["UK", "EU"] }],
      requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
    const settled = { run: { status: "cancelled", revision: 7, eventHead: { lastSequence: 6 } }, events: [] };
    mocks.invoke.mockResolvedValueOnce(settled);
    await expect(cancelRuntimeMissionHumanInput(request)).resolves.toEqual(settled);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("mission_run_request_cancellation", { input: {
      runId: "run-1", eventId: "mission-human-input-cancel-requested-test",
      requestKey: "human-input-stop:v1:test", expectedRunRevision: 5, expectedLastSequence: 4,
      mode: "cooperative", reason: "User requested stop while mission input was pending."
    } });
  });

  it("durably cancels the newest general Mission approval without resolving it as approved", async () => {
    setNative(true);
    const approval = {
      runId: "run-approval", missionId: "mission-approval", sourceThreadId: "thread-1",
      planRevisionId: "revision-1",
      waitKey: `mission-approval-wait:v1:${"a".repeat(64)}`,
      requestKey: "publish-1", actionSummary: "Publish one update.",
      proposalHash: "b".repeat(64),
      effect: {
        effectKey: "publish:update-1", idempotencyKey: "publish:update-1",
        targetSummary: "One update"
      },
      requestedAt: "2026-07-23T12:00:00Z", runRevision: 6, lastSequence: 5
    };
    const requested = {
      run: { status: "cancelling", revision: 8, eventHead: { lastSequence: 7 } },
      events: []
    };
    const settled = {
      run: { status: "cancelled", revision: 9, eventHead: { lastSequence: 8 } },
      events: []
    };
    mocks.invoke.mockResolvedValueOnce(requested).mockResolvedValueOnce(settled);
    await expect(cancelRuntimeMissionApproval(approval)).resolves.toEqual(settled);
    expect(mocks.invoke.mock.calls).toEqual([
      ["mission_run_request_cancellation", { input: {
        runId: "run-approval",
        eventId: `mission-approval-cancel-requested-${"a".repeat(64)}`,
        requestKey: `mission-approval-stop:v1:${"a".repeat(64)}`,
        expectedRunRevision: 6,
        expectedLastSequence: 5,
        mode: "cooperative",
        reason: "User requested stop while a Mission action approval was pending."
      } }],
      ["mission_run_finalize_cancellation", { input: {
        runId: "run-approval",
        eventId: `mission-approval-cancelled-${"a".repeat(64)}`,
        expectedRunRevision: 8,
        expectedLastSequence: 7
      } }]
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
    const join = {
      runId: "run-1", targetStepKey: "combine", strategy: "quorum" as const, quorum: 2,
      allowFailedWorkers: true, deadline: "2026-07-14T00:00:00Z",
      eventId: "event-join-open", idempotencyKey: "join-open-1",
      expectedRunRevision: 4, expectedLastSequence: 3
    };
    const resolveJoin = {
      runId: "run-1", joinKey: "mission_join_1", eventId: "event-join-resolve",
      idempotencyKey: "join-resolve-1", expectedRunRevision: 5, expectedLastSequence: 4
    };
    const aggregation = {
      runId: "run-1", targetStepKey: "combine", eventId: "event-aggregation",
      idempotencyKey: "aggregation-1", expectedRunRevision: 6, expectedLastSequence: 5
    };

    await createRuntimeMissionPlan(plan);
    await createRuntimeMissionRun(run);
    await createRuntimeMissionWorker(worker);
    await startRuntimeMissionWorker(start);
    await openRuntimeMissionJoin(join);
    await resolveRuntimeMissionJoin(resolveJoin);
    await recordRuntimeMissionAggregation(aggregation);
    await readRuntimeMissionProgress("run-1");
    const humanEvaluation = {
      runId: "run-1", criterionKey: "review", passed: true,
      expectedRunRevision: 4, expectedLastSequence: 3
    };
    await recordRuntimeMissionHumanEvaluation(humanEvaluation);
    await prepareRuntimeMissionWorkers("run-1");
    await advanceRuntimeMissionCoordination("run-1");
    await finalizeRuntimeMissionCoordination("run-1");
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
    await recoverRuntimeInterruptedGeneralMissions();
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
      ["mission_coordination_join_open", { input: join }],
      ["mission_coordination_join_resolve", { input: resolveJoin }],
      ["mission_coordination_aggregation_record", { input: aggregation }],
      ["mission_coordination_progress_read", { runId: "run-1" }],
      ["mission_coordination_human_evaluation_record", { input: humanEvaluation }],
      ["mission_coordination_prepare_workers", { runId: "run-1" }],
      ["mission_coordination_advance", { runId: "run-1" }],
      ["mission_coordination_finalize", { runId: "run-1" }],
      ["mission_plan_get", { missionId: "mission-1" }],
      ["mission_plan_cited_summary_get", { missionId: "mission-1" }],
      ["mission_run_get", { runId: "run-1" }],
      ["mission_run_request_cancellation", { input: cancel }],
      ["mission_worker_output_read", { valueReference: "mission-output:v1:ref" }],
      ["mission_worker_cited_receipts_read", { input: { threadId: "thread-1", messageIds: ["message-1"] } }],
      ["mission_plan_cited_summaries_read", { input: { threadId: "thread-1", messageIds: ["message-1"] } }],
      ["list_native_provider_routes"],
      ["mission_run_recover_interrupted_cited"],
      ["mission_run_recover_interrupted_general"],
      ["mission_run_prepare_cited_retry", { input: { runId: "run-1" } }],
      ["mission_run_restore_checkpoint", { input: restore }],
      ["mission_run_create_checkpoint", { input: checkpoint }]
    ]);
  });
});
