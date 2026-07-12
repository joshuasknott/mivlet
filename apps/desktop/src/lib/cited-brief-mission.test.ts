import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeCitedBriefMission, isCitedBriefMissionPrompt } from "./cited-brief-mission";

const mocks = vi.hoisted(() => ({
  executeLocalWorker: vi.fn(), buildToolApproval: vi.fn(), desktopExecutor: vi.fn(),
  prepareGrant: vi.fn(), commitGrant: vi.fn(), createPlan: vi.fn(), createRun: vi.fn(),
  createWorker: vi.fn(), startWorker: vi.fn(), getRun: vi.fn(), readOutput: vi.fn(), resolveMcpRoute: vi.fn()
}));
vi.mock("@fable/connectors", () => ({ executeLocalWorker: mocks.executeLocalWorker, buildToolApproval: mocks.buildToolApproval }));
vi.mock("./desktop-tool-runtime", () => ({ createDesktopToolExecutor: mocks.desktopExecutor }));
vi.mock("../runtime", () => ({
  prepareRuntimeCapabilityGrant: mocks.prepareGrant,
  commitRuntimeCapabilityGrant: mocks.commitGrant,
  createRuntimeMissionPlan: mocks.createPlan,
  createRuntimeMissionRun: mocks.createRun,
  createRuntimeMissionWorker: mocks.createWorker,
  startRuntimeMissionWorker: mocks.startWorker,
  getRuntimeMissionRun: mocks.getRun,
  readRuntimeMissionWorkerOutput: mocks.readOutput,
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

describe("cited brief mission composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-1" } });
    mocks.resolveMcpRoute.mockResolvedValue(null);
    mocks.createPlan.mockResolvedValue({ mission: {} });
    mocks.createRun.mockResolvedValue(journal(2, 1, []));
    mocks.createWorker.mockResolvedValue(journal(3, 2, [{ type: "worker-created", payload: { worker } }]));
    mocks.startWorker.mockResolvedValue(journal(5, 4, [{ type: "worker-created", payload: { worker } }]));
    mocks.buildToolApproval.mockReturnValue({ id: "base", service: "openai", action: "connection-read", mode: "read-only", riskLevel: "medium", dataUsed: [], consequence: "Search", requestedAt: "t", decisions: ["once", "deny"] });
    mocks.desktopExecutor.mockReturnValue(vi.fn().mockResolvedValue(JSON.stringify({ result: { citations: [{ citationId: "source-1" }] } })));
    mocks.executeLocalWorker.mockResolvedValue({ status: "completed", events: [], text: "Brief", usage: {}, retryable: false });
    mocks.getRun
      .mockResolvedValueOnce(journal(6, 5, [{ id: "event-13", type: "tool-call-completed", payload: { result: { outputReference: "mission-tool:v1:evidence" } } }]))
      .mockResolvedValueOnce(journal(10, 9, [], { status: "completed", terminalResult: { outputs: [{ valueReference: "mission-output:v1:brief" }] } }));
    mocks.readOutput.mockResolvedValue({ receipt: { text: "Trustworthy brief [source-1]." } });
  });

  it("routes only an explicit connected-source cited-brief request", () => {
    expect(isCitedBriefMissionPrompt("Search my connected work sources and produce a trustworthy cited brief.")).toBe(true);
    expect(isCitedBriefMissionPrompt("Write a brief about our work.")).toBe(false);
    expect(isCitedBriefMissionPrompt("Search the web and cite a brief.")).toBe(false);
  });

  it("uses separate mission-bound search and final writing turns", async () => {
    let counter = 0;
    mocks.resolveMcpRoute.mockResolvedValue({ connectionId: "mcp-connection-1" });
    const gate = { register: vi.fn().mockReturnValue(true), waitForDecision: vi.fn() } as never;
    const result = await executeCitedBriefMission({
      query: "What changed?", workspaceId: "local-workspace", missionScopeWorkspaceId: "hosted-workspace",
      backend: { providerId: "openai" } as never, model: "gpt-5", approvalGate: gate,
      queueApproval: vi.fn(), createId: (prefix) => `${prefix}-${++counter}`
    });

    expect(result.text).toBe("Trustworthy brief [source-1].");
    expect(mocks.executeLocalWorker).toHaveBeenCalledTimes(1);
    expect(mocks.executeLocalWorker.mock.calls[0][0]).toMatchObject({
      toolSpecs: [], missionToolEvidence: { result: { citations: [{ citationId: "source-1" }] } },
      missionWorkerExecution: {
        runId: "mission-run-4", workerId: "worker-5", workerStartedEventId: "event-11",
        toolEvidence: { toolEventId: "event-13", outputReference: "mission-tool:v1:evidence" },
        expectedRunRevision: 6, expectedLastSequence: 5
      }
    });
    expect(mocks.desktopExecutor).toHaveBeenCalledWith(gate, expect.objectContaining({
      missionWorkerToolExecution: expect.objectContaining({ toolEventId: "event-13", callKey: "native-mission-run-4-call-14" })
    }));
    expect(mocks.createWorker).toHaveBeenCalledWith(expect.objectContaining({
      grants: [{ capabilityId: "knowledge.content.search", capabilityGrantId: "grant-1" }]
    }));
    expect(mocks.prepareGrant).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "mcp-connection-1" }));
    expect(mocks.readOutput).toHaveBeenCalledWith("mission-output:v1:brief");
  });
});
