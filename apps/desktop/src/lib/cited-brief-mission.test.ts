import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCitedBriefMission, isCitedBriefMissionPrompt, isCitedBriefMissionReceipt, resumeInterruptedCitedBriefMissions } from "./cited-brief-mission";

const mocks = vi.hoisted(() => ({
  executeLocalWorker: vi.fn(), buildToolApproval: vi.fn(), desktopExecutor: vi.fn(),
  prepareGrant: vi.fn(), commitGrant: vi.fn(), createPlan: vi.fn(), getPlanSummary: vi.fn(), createRun: vi.fn(),
  createWorker: vi.fn(), startWorker: vi.fn(), createCheckpoint: vi.fn(), restoreCheckpoint: vi.fn(), recoverCited: vi.fn(), getRun: vi.fn(), readOutput: vi.fn(), resolveMcpRoute: vi.fn(), cancelRun: vi.fn(), finalizeCancellation: vi.fn(), listRoutes: vi.fn()
}));
vi.mock("@fable/connectors", () => ({
  executeLocalWorker: mocks.executeLocalWorker,
  buildToolApproval: mocks.buildToolApproval,
  catalogueCapabilities: () => ({ contextWindow: 400_000, maxOutputTokens: 128_000, tools: true }),
  selectMissionProviderRoute: (_request: unknown, candidates: Array<{ route: { id: string } }>) => ({ selection: { providerRouteId: candidates[0].route.id } })
}));
vi.mock("./desktop-tool-runtime", () => ({ createDesktopToolExecutor: mocks.desktopExecutor }));
vi.mock("../runtime", () => ({
  prepareRuntimeCapabilityGrant: mocks.prepareGrant,
  commitRuntimeCapabilityGrant: mocks.commitGrant,
  createRuntimeMissionPlan: mocks.createPlan,
  getRuntimeCitedMissionPlanSummary: mocks.getPlanSummary,
  createRuntimeMissionRun: mocks.createRun,
  createRuntimeMissionCheckpoint: mocks.createCheckpoint,
  restoreRuntimeMissionCheckpoint: mocks.restoreCheckpoint,
  recoverRuntimeInterruptedCitedMissions: mocks.recoverCited,
  createRuntimeMissionWorker: mocks.createWorker,
  startRuntimeMissionWorker: mocks.startWorker,
  getRuntimeMissionRun: mocks.getRun,
  readRuntimeMissionWorkerOutput: mocks.readOutput,
  requestRuntimeMissionRunCancellation: mocks.cancelRun,
  finalizeRuntimeMissionRunCancellation: mocks.finalizeCancellation,
  listRuntimeNativeProviderRoutes: mocks.listRoutes,
  resolveRuntimeMcpCapabilityRoute: mocks.resolveMcpRoute
}));

const worker = {
  id: "worker-5", runId: "mission-run-4", status: "proposed", role: { title: "Research", objective: "objective", instructions: [] },
  workspaceId: "workspace-1", authority: "local", visibility: "member-private", ownerMemberId: "member-1",
  schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1", createdAt: "t", updatedAt: "t",
  context: [], capabilityIds: ["knowledge.content.search"], capabilityGrantIds: ["grant-1"],
  tools: [{ toolName: "connection-read", access: "read", purpose: "Search", required: true }],
  budget: { maxAttempts: 1, maxDurationMs: 120000, maxOutputTokens: 2048, maxToolCalls: 1 }, stopConditions: [],
  outputContract: { slots: [{ key: "brief", description: "Brief", required: true, format: "text/markdown" }], includeEvidence: true, includeUncertainty: true, delivery: "run-result" }
};
const journal = (revision: number, sequence: number, events: unknown[], extra: Record<string, unknown> = {}) => ({
  run: { id: "mission-run-4", status: "running", revision, eventHead: { lastSequence: sequence, lastEventId: `head-${sequence}` }, ...extra }, events
});
const planSummary = {
  title: "Connected work brief", summary: "What changed?", executionLabel: "One focused research step",
  step: { title: "Research and write", objective: "Search and write.", capability: "Search connected work sources", output: "A trustworthy Markdown brief." },
  acceptance: ["Use only attested citations."],
  budget: { maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2 }
};

describe("cited brief mission composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-1" } });
    mocks.resolveMcpRoute.mockResolvedValue(null);
    mocks.listRoutes.mockResolvedValue([{ id: "provider-route-ui", recordType: "provider-route", connectionId: "connection-openai", kind: "api-model", displayName: "OpenAI GPT-5", providerFamily: "openai", modelOrRuntimeReference: "gpt-5", state: "available", health: { state: "healthy" }, placement: { allowedKinds: ["local-desktop"], requiresCredentialHoldingNode: true }, boundaries: { privacyBoundary: "member-private", billingBoundary: "account-owned-provider", providerBoundary: "openai", placementBoundary: "local-credential-egress" }, credentialBinding: { custody: "os-secure-store", state: "available", refreshSupported: false }, workspaceId: "hosted-workspace", visibility: "member-private", ownerMemberId: "member-1", authority: "local", schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1", createdAt: "t", updatedAt: "t" }]);
    mocks.createPlan.mockResolvedValue({ mission: { budget: { maxDurationMs: 120000, maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxAttempts: 2 } } });
    mocks.getPlanSummary.mockResolvedValue(planSummary);
    mocks.createRun.mockResolvedValue(journal(2, 1, []));
    mocks.createWorker.mockResolvedValue(journal(3, 2, [{ type: "worker-created", payload: { worker } }]));
    mocks.startWorker.mockResolvedValue(journal(6, 5, [{ type: "worker-created", payload: { worker } }, { type: "route-selected", payload: { selection: { providerRouteId: "provider-route-ui" } } }]));
    mocks.createCheckpoint.mockImplementation(async (input: { eventId: string }) => journal(8, 7, [{
      id: input.eventId, type: "checkpoint-created", sequence: 7
    }], { eventHead: { lastSequence: 7, lastEventId: input.eventId } }));
    mocks.buildToolApproval.mockReturnValue({ id: "base", service: "openai", action: "connection-read", mode: "read-only", riskLevel: "medium", dataUsed: [], consequence: "Search", requestedAt: "t", decisions: ["once", "deny"] });
    mocks.desktopExecutor.mockReturnValue(vi.fn().mockResolvedValue(JSON.stringify({ result: { citations: [{ citationId: "source-1" }] } })));
    mocks.executeLocalWorker.mockResolvedValue({ status: "completed", events: [], text: "Brief", usage: {}, retryable: false });
    mocks.getRun
      .mockResolvedValueOnce(journal(7, 6, [{ id: "event-14", type: "tool-call-completed", sequence: 6, payload: { result: { outputReference: "mission-tool:v1:evidence" } } }]))
      .mockResolvedValueOnce(journal(11, 10, [
        { type: "route-selected", payload: { selection: { reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route." } } },
        { type: "usage-recorded", payload: { usage: { inputTokens: 120, outputTokens: 80, toolCalls: 1, durationMs: 1250, attemptNumber: 1, costs: [{ amount: { amount: "0.00095", currencyCode: "USD" }, provenance: "fable-calculated", pricingReference: "official-price|reviewed=2026-07-12" }] } } },
        { id: "head-10", type: "run-completed", payload: { result: { outcome: "succeeded", outputs: [{
          valueReference: "mission-output:v1:brief", artifactId: "mission-artifact-1", artifactVersionId: "mission-artifact-version-1"
        }] } } }
      ], { status: "completed", terminalResult: { outcome: "succeeded", summary: "The cited brief and its required policy acceptance are complete.", outputs: [{
        valueReference: "mission-output:v1:brief", artifactId: "mission-artifact-1", artifactVersionId: "mission-artifact-version-1"
      }] } }));
    mocks.readOutput.mockResolvedValue({ receipt: { text: "Trustworthy brief [source-1].", observedProvider: "openai", requestedModel: "gpt-5", trust: "provider-generated-with-external-evidence", citations: [{ citationId: "source-1" }] } });
  });

  it("routes only an explicit connected-source cited-brief request", () => {
    expect(isCitedBriefMissionPrompt("Search my connected work sources and produce a trustworthy cited brief.")).toBe(true);
    expect(isCitedBriefMissionPrompt("Write a brief about our work.")).toBe(false);
    expect(isCitedBriefMissionPrompt("Search the web and cite a brief.")).toBe(false);
  });

  it("uses separate mission-bound search and final writing turns", async () => {
    let counter = 0;
    let cancelMission: (() => Promise<void>) | undefined;
    mocks.resolveMcpRoute.mockResolvedValue({ connectionId: "mcp-connection-1" });
    const gate = { register: vi.fn().mockReturnValue(true), waitForDecision: vi.fn() } as never;
    const result = await executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace", sourceThreadId: "thread-1",
      backend: { providerId: "openai" } as never, model: "gpt-5", approvalGate: gate,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`,
      onCancellationReady: (cancel) => { cancelMission = cancel; }
    });

    expect(result.text).toBe("Trustworthy brief [source-1].");
    expect(result.outcome).toBe("accepted");
    expect(result.plan).toEqual(planSummary);
    expect(result).toMatchObject({ artifactId: "mission-artifact-1", artifactVersionId: "mission-artifact-version-1" });
    expect(result.receipt).toMatchObject({ acceptanceStatus: "accepted", provider: "openai", model: "gpt-5", inputTokens: 120, outputTokens: 80, toolCalls: 1, durationMs: 1250, attemptNumber: 1, sourceCount: 1, maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2, costAmount: "0.00095", costCurrency: "USD" });
    expect(mocks.createPlan).toHaveBeenCalledWith(expect.objectContaining({
      missionScope: expect.objectContaining({ workspaceId: "hosted-workspace", sourceThreadId: "thread-1" }),
      budget: expect.objectContaining({ maxAttempts: 2 }),
      steps: [expect.objectContaining({ estimatedBudget: expect.objectContaining({ maxAttempts: 1 }) })]
    }));
    expect(mocks.getPlanSummary).toHaveBeenCalledWith("mission-1");
    expect(mocks.executeLocalWorker).toHaveBeenCalledTimes(1);
    expect(mocks.executeLocalWorker.mock.calls[0][0]).toMatchObject({
      toolSpecs: [], missionToolEvidence: { result: { citations: [{ citationId: "source-1" }] } },
      missionWorkerExecution: {
        runId: "mission-run-4", workerId: "worker-5", workerStartedEventId: "event-11", routeSelectedEventId: "event-12",
        toolEvidence: { toolEventId: "event-14", outputReference: "mission-tool:v1:evidence" },
        checkpointEventId: "event-17", expectedRunRevision: 8, expectedLastSequence: 7
      }
    });
    expect(mocks.desktopExecutor).toHaveBeenCalledWith(gate, expect.objectContaining({
      missionWorkerToolExecution: expect.objectContaining({ routeSelectedEventId: "event-12", toolEventId: "event-14", callKey: "native-mission-run-4-call-15" })
    }));
    expect(mocks.createWorker).toHaveBeenCalledWith(expect.objectContaining({
      grants: [{ capabilityId: "knowledge.content.search", capabilityGrantId: "grant-1" }]
    }));
    expect(mocks.createCheckpoint).toHaveBeenCalledWith({
      runId: "mission-run-4", eventId: "event-17", idempotencyKey: "cited-evidence:event-14",
      expectedRunRevision: 7, expectedLastSequence: 6, attemptNumber: 1,
      durableThroughSequence: 6, resumeAfterEventId: "event-14"
    });
    expect(mocks.prepareGrant).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "mcp-connection-1" }));
    expect(mocks.readOutput).toHaveBeenCalledWith("mission-output:v1:brief");
    expect(cancelMission).toBeTypeOf("function");
  });

  it("resumes only the checkpointed final writing turn without repeating search authority", async () => {
    const recovery = {
      status: "resumable" as const,
      runId: "mission-run-4",
      sourceThreadId: "thread-1",
      worker,
      providerId: "openai",
      modelReference: "gpt-5",
      workerStartedEventId: "event-worker-started",
      routeSelectedEventId: "event-route",
      checkpointEventId: "event-checkpoint",
      checkpointRestoreEventId: "event-restore",
      toolEventId: "event-tool",
      outputReference: "mission-tool:v1:evidence",
      evidence: { result: { citations: [{ citationId: "source-1" }] } },
      restoreIdempotencyKey: "restart-restore-1",
      terminalIdempotencyKey: "restart-terminal-1",
      usageEventId: "event-usage",
      completionEventId: "event-completion",
      evaluationEventId: "event-evaluation",
      resultEventId: "event-result",
      failureEventId: "event-failure",
      expectedRunRevision: 8,
      expectedLastSequence: 7,
      newAttemptNumber: 2
    };
    mocks.recoverCited.mockResolvedValue([recovery]);
    mocks.restoreCheckpoint.mockResolvedValue({
      journal: journal(9, 8, [{ id: "event-restore", type: "checkpoint-restored", sequence: 8 }], {
        currentAttemptNumber: 2,
        eventHead: { lastSequence: 8, lastEventId: "event-restore" }
      }),
      checkpoint: {}
    });
    mocks.getRun.mockReset().mockResolvedValue(journal(12, 11, [{
      id: "head-11", type: "run-completed", payload: { result: { outcome: "succeeded", outputs: [{
        valueReference: "mission-output:v1:brief", artifactId: "artifact-1", artifactVersionId: "version-1"
      }] } }
    }], {
      status: "completed",
      terminalResult: { outcome: "succeeded", summary: "Accepted.", outputs: [{
        valueReference: "mission-output:v1:brief", artifactId: "artifact-1", artifactVersionId: "version-1"
      }] }
    }));

    await expect(resumeInterruptedCitedBriefMissions({
      backend: { providerId: "openai" } as never
    })).resolves.toEqual({ resumed: 1, terminalized: 0, failed: 0 });

    expect(mocks.restoreCheckpoint).toHaveBeenCalledWith({
      runId: "mission-run-4", eventId: "event-restore", idempotencyKey: "restart-restore-1",
      expectedRunRevision: 8, expectedLastSequence: 7, newAttemptNumber: 2
    });
    expect(mocks.executeLocalWorker).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5",
      prompt: "objective",
      toolSpecs: [],
      missionToolEvidence: recovery.evidence,
      missionWorkerExecution: expect.objectContaining({
        expectedRunRevision: 9,
        expectedLastSequence: 8,
        checkpointEventId: "event-checkpoint",
        checkpointRestoreEventId: "event-restore",
        toolEvidence: { toolEventId: "event-tool", outputReference: "mission-tool:v1:evidence" }
      })
    }));
    expect(mocks.prepareGrant).not.toHaveBeenCalled();
    expect(mocks.commitGrant).not.toHaveBeenCalled();
    expect(mocks.desktopExecutor).not.toHaveBeenCalled();
    expect(mocks.createPlan).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("lets a durable cancellation win during the resumed provider turn", async () => {
    const cancellation = {
      requestKey: "stop-resume", requestedAt: "2026-07-13T12:00:00.000Z",
      requestedByInternalUserId: "user-1", scope: "run", mode: "cooperative",
      reason: "User requested stop."
    };
    mocks.recoverCited.mockResolvedValue([{
      status: "resumable", runId: "mission-run-4", sourceThreadId: "thread-1", worker,
      providerId: "openai", modelReference: "gpt-5", workerStartedEventId: "event-worker-started",
      routeSelectedEventId: "event-route", checkpointEventId: "event-checkpoint",
      checkpointRestoreEventId: "event-restore", toolEventId: "event-tool",
      outputReference: "mission-tool:v1:evidence", evidence: { result: { citations: [] } },
      restoreIdempotencyKey: "restart-restore-1", terminalIdempotencyKey: "restart-terminal-1",
      usageEventId: "event-usage", completionEventId: "event-completion",
      evaluationEventId: "event-evaluation", resultEventId: "event-result",
      failureEventId: "event-failure", expectedRunRevision: 8, expectedLastSequence: 7,
      newAttemptNumber: 2
    }]);
    const restored = journal(9, 8, [{ id: "event-restore", type: "checkpoint-restored", sequence: 8 }], {
      currentAttemptNumber: 2, eventHead: { lastSequence: 8, lastEventId: "event-restore" }
    });
    const cancelled = journal(11, 10, [{
      id: "event-cancelled", type: "run-cancelled", payload: { cancellation }
    }], { status: "cancelled", cancellation, eventHead: { lastSequence: 10, lastEventId: "event-cancelled" } });
    mocks.restoreCheckpoint.mockResolvedValue({ journal: restored, checkpoint: {} });
    mocks.getRun.mockReset().mockResolvedValueOnce(restored).mockResolvedValueOnce(cancelled);
    const backendCancel = vi.fn().mockResolvedValue(undefined);
    let cancel: (() => Promise<void>) | null = null;
    mocks.executeLocalWorker.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      await cancel?.();
      expect(signal.aborted).toBe(true);
      return { status: "cancelled", events: [], text: "", usage: {}, retryable: false };
    });

    await expect(resumeInterruptedCitedBriefMissions({
      backend: { providerId: "openai", cancel: backendCancel } as never,
      onCancellationReady: (value) => { cancel = value; }
    })).resolves.toEqual({ resumed: 1, terminalized: 0, failed: 0 });

    expect(mocks.cancelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "mission-run-4", expectedRunRevision: 9, expectedLastSequence: 8,
      mode: "cooperative", reason: "User requested stop."
    }));
    expect(backendCancel).toHaveBeenCalledWith("mission-run-4");
    expect(mocks.desktopExecutor).not.toHaveBeenCalled();
    expect(mocks.prepareGrant).not.toHaveBeenCalled();
  });

  it("accepts only the closed secret-safe cited receipt projection", () => {
    const receipt = {
      acceptanceStatus: "accepted", acceptanceSummary: "Accepted", provider: "openai", model: "gpt-5",
      routeReason: "Selected route.", inputTokens: 12, outputTokens: 3, toolCalls: 1, durationMs: 900, attemptNumber: 1, sourceCount: 1,
      trust: "provider-generated-with-external-evidence", maxInputTokens: 100, maxOutputTokens: 50,
      maxToolCalls: 1, maxDurationMs: 1000, maxAttempts: 1,
      costAmount: "0.01", costCurrency: "USD", pricingReference: "official"
    };
    expect(isCitedBriefMissionReceipt(receipt)).toBe(true);
    expect(isCitedBriefMissionReceipt({ ...receipt, credentialBinding: "secret" })).toBe(false);
    expect(isCitedBriefMissionReceipt({ ...receipt, costCurrency: undefined })).toBe(false);
    expect(isCitedBriefMissionReceipt({ ...receipt, inputTokens: -1 })).toBe(false);
    expect(isCitedBriefMissionReceipt({ ...receipt, durationMs: 1001 })).toBe(false);
    expect(isCitedBriefMissionReceipt({ ...receipt, attemptNumber: 2 })).toBe(false);
  });

  it("returns preserved output as an explicit unaccepted partial outcome", async () => {
    let counter = 0;
    mocks.getRun
      .mockReset()
      .mockResolvedValueOnce(journal(7, 6, [{ id: "event-14", type: "tool-call-completed", sequence: 6, payload: { result: { outputReference: "mission-tool:v1:evidence" } } }]))
      .mockResolvedValueOnce(journal(11, 10, [
        { type: "route-selected", payload: { selection: { reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route." } } },
        { type: "usage-recorded", payload: { usage: { inputTokens: 120, outputTokens: 80, toolCalls: 1, durationMs: 1250, attemptNumber: 2, costs: [] } } },
        { id: "head-10", type: "run-failed", payload: {
          error: { code: "policy-acceptance-failed", category: "validation", message: "Not accepted", retryable: false },
          partial: {
            summary: "The cited draft was preserved, but it did not satisfy the required evidence policy.",
            completedOutputs: [{ key: "brief", valueReference: "mission-output:v1:brief" }],
            remainingWork: ["Meet acceptance criterion: Cite evidence"], acceptance: [], recoverable: true, recommendedNextAction: "stop"
          }
        } }
      ], { status: "partially-completed" }));
    const result = await executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace", sourceThreadId: "thread-1",
      backend: { providerId: "openai" } as never, model: "gpt-5", approvalGate: { register: vi.fn(), waitForDecision: vi.fn() } as never,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`
    });

    expect(result.outcome).toBe("partial");
    expect(result.text).toContain("Draft preserved, but not accepted");
    expect(result.text).toContain("Trustworthy brief [source-1].");
    expect(result.receipt).toMatchObject({ acceptanceStatus: "not-accepted", durationMs: 1250, attemptNumber: 2 });
    expect(mocks.readOutput).toHaveBeenCalledWith("mission-output:v1:brief");
  });

  it("surfaces only a durable terminal provider failure", async () => {
    let counter = 0;
    mocks.executeLocalWorker.mockResolvedValue({ status: "failed", events: [], text: "", usage: {}, reason: "renderer reason", retryable: false });
    mocks.getRun
      .mockReset()
      .mockResolvedValueOnce(journal(7, 6, [{ id: "event-14", type: "tool-call-completed", sequence: 6, payload: { result: { outputReference: "mission-tool:v1:evidence" } } }]))
      .mockResolvedValueOnce(journal(10, 9, [{
        id: "head-9", type: "run-failed", payload: { error: {
          code: "native-provider-request-rejected", category: "provider",
          message: "The native provider rejected the request.", retryable: false
        } }
      }], { status: "failed" }));

    await expect(executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace", sourceThreadId: "thread-1",
      backend: { providerId: "openai" } as never, model: "gpt-5", approvalGate: { register: vi.fn(), waitForDecision: vi.fn() } as never,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`
    })).rejects.toThrow("The native provider rejected the request.");
    expect(mocks.readOutput).not.toHaveBeenCalled();
  });

  it("persists a cancellation request, stops provider egress, and trusts only the terminal cancellation fact", async () => {
    let counter = 0;
    let cancelMission: (() => Promise<void>) | undefined;
    const backendCancel = vi.fn().mockResolvedValue(undefined);
    const cancellation = {
      requestKey: "stop-18", requestedAt: "2026-07-13T12:00:00.000Z",
      requestedByInternalUserId: "user-1", scope: "run", mode: "cooperative",
      reason: "User requested stop."
    };
    mocks.getRun
      .mockReset()
      .mockResolvedValueOnce(journal(7, 6, [{ id: "event-14", type: "tool-call-completed", sequence: 6, payload: { result: { outputReference: "mission-tool:v1:evidence" } } }]))
      .mockResolvedValueOnce(journal(8, 7, []))
      .mockResolvedValueOnce(journal(9, 8, [{
        id: "event-19", type: "run-cancelled", payload: { cancellation }
      }], { status: "cancelled", cancellation, eventHead: { lastSequence: 8, lastEventId: "event-19" } }));
    mocks.executeLocalWorker.mockImplementation(async (workerInput: { signal: AbortSignal }) => {
      await cancelMission?.();
      expect(workerInput.signal.aborted).toBe(true);
      // The provider can finish its stream just before the durable settlement
      // observes the already-persisted cancellation request; cancellation wins.
      return { status: "completed", events: [], text: "", usage: {}, retryable: false };
    });

    await expect(executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace", sourceThreadId: "thread-1",
      backend: { providerId: "openai", cancel: backendCancel } as never, model: "gpt-5",
      approvalGate: { register: vi.fn(), waitForDecision: vi.fn() } as never,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`,
      onCancellationReady: (cancel) => { cancelMission = cancel; }
    })).rejects.toThrow("User requested stop.");

    expect(mocks.cancelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "mission-run-4", mode: "cooperative", expectedRunRevision: 8, expectedLastSequence: 7
    }));
    expect(backendCancel).toHaveBeenCalledWith("mission-run-4");
    expect(mocks.readOutput).not.toHaveBeenCalled();
  });

  it("terminalizes cancellation before provider egress starts", async () => {
    let counter = 0;
    let cancelMission: (() => Promise<void>) | undefined;
    const backendCancel = vi.fn().mockResolvedValue(undefined);
    const cancellation = {
      requestKey: "stop-9", requestedAt: "2026-07-13T12:00:00.000Z",
      requestedByInternalUserId: "user-1", scope: "run", mode: "cooperative",
      reason: "User requested stop."
    };
    const cancelling = journal(3, 2, [{
      id: "event-stop", type: "cancellation-requested", payload: { cancellation }
    }], { status: "cancelling", cancellation, eventHead: { lastSequence: 2, lastEventId: "event-stop" } });
    const cancelled = journal(4, 3, [{
      id: "event-terminal", type: "run-cancelled", payload: { cancellation }
    }], { status: "cancelled", cancellation, eventHead: { lastSequence: 3, lastEventId: "event-terminal" } });
    mocks.getRun.mockReset().mockResolvedValueOnce(journal(2, 1, [])).mockResolvedValueOnce(cancelling);
    mocks.finalizeCancellation.mockResolvedValue(cancelled);
    mocks.createWorker.mockImplementationOnce(async () => {
      await cancelMission?.();
      throw new Error("The worker start was interrupted.");
    });

    await expect(executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace", sourceThreadId: "thread-1",
      backend: { providerId: "openai", cancel: backendCancel } as never, model: "gpt-5",
      approvalGate: { register: vi.fn(), waitForDecision: vi.fn() } as never,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`,
      onCancellationReady: (cancel) => { cancelMission = cancel; }
    })).rejects.toThrow("User requested stop.");

    expect(mocks.finalizeCancellation).toHaveBeenCalledWith(expect.objectContaining({
      runId: "mission-run-4", expectedRunRevision: 3, expectedLastSequence: 2
    }));
    expect(backendCancel).toHaveBeenCalledWith("mission-run-4");
    expect(mocks.executeLocalWorker).not.toHaveBeenCalled();
  });
});
