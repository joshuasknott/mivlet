import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const runtime = vi.hoisted(() => ({
  prepareGrant: vi.fn(),
  commitGrant: vi.fn(),
  executeTool: vi.fn()
}));

vi.mock("../runtime", () => ({
  prepareRuntimeCapabilityGrant: runtime.prepareGrant,
  commitRuntimeCapabilityGrant: runtime.commitGrant,
  executeRuntimeToolCall: runtime.executeTool
}));

const approval: ApprovalRequest = {
  id: "acp-copilot-session-tool",
  service: "copilot",
  action: "acp-permission Edit src/app.ts",
  mode: "full-access",
  riskLevel: "high",
  dataUsed: ["kind: edit", "path: src/app.ts"],
  consequence:
    "Allow copilot to run the provider action once. Fable only returns the permission decision.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "modify", "deny"],
  confirmationPhrase: "approve copilot action"
};

describe("desktop ACP permission execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("waits for Fable's gate but does not dispatch the provider-owned tool to Rust", async () => {
    const executor = createDesktopToolExecutor({
      waitForDecision: async () => "granted"
    });
    await expect(executor(approval, JSON.stringify({ path: "src/app.ts" }))).resolves.toBe(
      "ACP permission granted once."
    );
  });

  it("fails closed when the Fable approval gate denies", async () => {
    const executor = createDesktopToolExecutor({
      waitForDecision: async () => "denied"
    });
    await expect(executor(approval, "{}")).rejects.toThrow(/denied/i);
  });
});

const connectionApproval: ApprovalRequest = {
  id: "connection-search-once",
  service: "openai",
  action: "connection-read capability: knowledge.content.search",
  mode: "read-only",
  riskLevel: "medium",
  dataUsed: ["capability: knowledge.content.search"],
  consequence: "Search connected work sources once.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "session", "rule", "modify", "deny"]
};

const grantApproval: ApprovalRequest = {
  id: "capability-first-use",
  service: "Connected sources",
  action: "capability-grant knowledge.content.search",
  mode: "full-access",
  riskLevel: "high",
  dataUsed: [
    "capability: Search connected work sources (knowledge.content.search)",
    "Connection: Work Notion (connection-1)",
    "consequence: read",
    "scope: workspace: workspace-1",
    "uses: no fixed limit",
    "expiry: until revoked"
  ],
  consequence:
    "Allows Fable to search this Connection in the named scope. Every search still requires its own exact-action approval.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "deny"],
  confirmationPhrase: "allow connected source search"
};

describe("desktop semantic capability grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.commitGrant.mockResolvedValue({ id: "grant-1" });
    runtime.executeTool.mockResolvedValue({ ok: true, output: "cited results" });
  });

  it("confirms first use, commits standing capability authority, then executes the separately approved search", async () => {
    runtime.prepareGrant.mockResolvedValue({
      status: "confirmation-required",
      proposalFingerprint: "fingerprint",
      target: {},
      approval: grantApproval
    });
    const queued: ApprovalRequest[] = [];
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      {
        workspaceId: "workspace-1",
        queueApproval: (request) => queued.push(request)
      }
    );

    await expect(
      executor(
        connectionApproval,
        JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
      )
    ).resolves.toBe("cited results");

    expect(queued).toEqual([grantApproval]);
    expect(runtime.commitGrant).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        projectId: undefined,
        capabilityId: "knowledge.content.search"
      },
      expect.objectContaining({
        request: grantApproval,
        decision: "once",
        confirmationText: "allow connected source search"
      })
    );
    expect(runtime.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "connection-read",
        workspaceId: "workspace-1"
      })
    );
  });

  it("uses an existing capability grant without another first-use prompt", async () => {
    runtime.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-1" } });
    const queueApproval = vi.fn();
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      { workspaceId: "workspace-1", queueApproval }
    );
    await executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    );
    expect(queueApproval).not.toHaveBeenCalled();
    expect(runtime.commitGrant).not.toHaveBeenCalled();
    expect(runtime.executeTool).toHaveBeenCalledOnce();
  });
});
