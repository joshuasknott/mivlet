import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import type { McpFrame, McpNotification, McpRequest } from "@fable/connectors";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const runtime = vi.hoisted(() => ({
  attestMissionMcp: vi.fn(),
  prepareGrant: vi.fn(),
  commitGrant: vi.fn(),
  executeTool: vi.fn(),
  resolveRoute: vi.fn()
}));
const mcpFactory = vi.hoisted(() => vi.fn());

vi.mock("../runtime", () => ({
  attestRuntimeMissionMcpConnectedSearch: runtime.attestMissionMcp,
  prepareRuntimeCapabilityGrant: runtime.prepareGrant,
  commitRuntimeCapabilityGrant: runtime.commitGrant,
  executeRuntimeToolCall: runtime.executeTool,
  resolveRuntimeMcpCapabilityRoute: runtime.resolveRoute
}));
vi.mock("./mcp-transport", () => ({
  createDesktopMcpTransport: mcpFactory,
  createDesktopRemoteMcpTransport: mcpFactory
}));

class SemanticMcpTransport {
  readonly sessionId = "mcp-session-1";
  private handler?: (frame: McpFrame) => void;
  async send(frame: McpRequest | McpNotification): Promise<void> {
    if (!("id" in frame)) return;
    const result = frame.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "fixture", version: "1" }
        }
      : frame.method === "tools/list"
        ? { tools: [{ name: "search_work", inputSchema: { type: "object" } }] }
        : { resources: [] };
    queueMicrotask(() => this.handler?.({ jsonrpc: "2.0", id: frame.id, result }));
  }
  subscribe(handler: (frame: McpFrame) => void) { this.handler = handler; return () => undefined; }
  subscribeClose() { return () => undefined; }
  async recordDiscovery() {
    return {
      connectionId: "connection-mcp",
      connectionRevision: 3,
      transport: "stdio" as const,
      launchReference: "work-search",
      discoveryState: "discovered",
      discoveredTools: ["search_work"],
      discoveredResources: [],
      enabledTools: ["search_work"],
      enabledResources: [],
      capabilityBindings: [{
        capabilityId: "knowledge.content.search" as const,
        toolName: "search_work",
        contractVersion: "fable.connected-source-search.v1" as const,
        consequence: "read" as const,
        trust: "untrusted" as const
      }]
    };
  }
  async executeAuthorizedToolCall() {
    return {
      trust: "untrusted" as const,
      instructionAuthority: "none" as const,
      isError: false,
      content: [],
      structuredJson: JSON.stringify({
        contractVersion: "fable.connected-source-search.v1",
        query: "Q3",
        citations: [{
          sourceId: "doc-1",
          title: "Q3 plan",
          snippet: "The launch needs a support owner.",
          provenance: "Connected work source",
          freshness: "2026-07-11T20:00:00Z"
        }]
      })
    };
  }
  async close() {}
}

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
    runtime.resolveRoute.mockResolvedValue(null);
    runtime.attestMissionMcp.mockResolvedValue(null);
    mcpFactory.mockReset();
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
        capabilityId: "knowledge.content.search",
        connectionId: undefined
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

  it("substitutes an explicitly bound MCP tool while preserving the cited-search contract", async () => {
    runtime.resolveRoute.mockResolvedValue({
      configurationReference: "work-search",
      transport: "stdio",
      connectionId: "connection-mcp",
      connectionRevision: 2,
      capabilityId: "knowledge.content.search",
      toolName: "search_work"
    });
    runtime.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-mcp" } });
    mcpFactory.mockResolvedValue(new SemanticMcpTransport());
    runtime.executeTool.mockResolvedValue({
      ok: true,
      output: JSON.stringify({
        kind: "mcp-connected-source-search",
        proposal: {
          workspaceId: "workspace-1",
          sessionId: "mcp-session-1",
          toolName: "search_work",
          arguments: {
            contractVersion: "fable.connected-source-search.v1",
            query: "Q3"
          }
        },
        permitId: "permit-1",
        workspaceId: "workspace-1",
        query: "Q3",
        connectionId: "connection-mcp",
        matchedGrantIds: ["grant-mcp"],
        degraded: false,
        degradationReasons: []
      })
    });
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      { workspaceId: "workspace-1" }
    );

    const encoded = await executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    );
    const result = JSON.parse(encoded);
    expect(runtime.prepareGrant).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-mcp"
    }));
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      mcpSessionId: "mcp-session-1"
    }));
    expect(result.result).toMatchObject({
      contractVersion: "fable.connected-source-search.v1",
      capabilityId: "knowledge.content.search",
      scope: { workspaceId: "workspace-1" },
      trust: "external-untrusted",
      instructionAuthority: "none",
      connectionId: "connection-mcp",
      matchedGrantIds: ["grant-mcp"],
      implementation: { kind: "mcp", evidence: "adapter-validated" },
      citations: [{ citationId: "source-1", trust: "external-untrusted" }]
    });
  });

  it("uses the same native mission receipt boundary for an MCP substitution", async () => {
    const missionBinding = {
      runId: "run-1", workerId: "worker-1", workerStartedEventId: "event-start",
      toolEventId: "event-tool", callKey: "connection-search-once", idempotencyKey: "tool-1",
      expectedRunRevision: 4, expectedLastSequence: 3
    };
    runtime.resolveRoute.mockResolvedValue({
      configurationReference: "work-search", transport: "stdio", connectionId: "connection-mcp",
      connectionRevision: 2, capabilityId: "knowledge.content.search", toolName: "search_work"
    });
    runtime.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-mcp" } });
    mcpFactory.mockResolvedValue(new SemanticMcpTransport());
    runtime.executeTool.mockResolvedValue({ ok: true, output: JSON.stringify({
      kind: "mcp-connected-source-search",
      proposal: { workspaceId: "workspace-1", sessionId: "mcp-session-1", toolName: "search_work", arguments: { contractVersion: "fable.connected-source-search.v1", query: "Q3" } },
      permitId: "permit-1", workspaceId: "workspace-1", query: "Q3", connectionId: "connection-mcp",
      matchedGrantIds: ["grant-mcp"], degraded: false, degradationReasons: []
    }) });
    const attested = { capabilityId: "knowledge.content.search", connectionId: "connection-mcp", result: { trust: "external-untrusted" } };
    runtime.attestMissionMcp.mockResolvedValue(attested);
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      { workspaceId: "workspace-1", missionWorkerToolExecution: missionBinding }
    );
    await expect(executor(connectionApproval, JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })))
      .resolves.toBe(JSON.stringify(attested));
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({ missionWorkerToolExecution: missionBinding }));
    expect(runtime.attestMissionMcp).toHaveBeenCalledWith("permit-1");
  });

  it("does not silently fall back to native when the selected MCP route is unavailable", async () => {
    runtime.resolveRoute.mockResolvedValue({
      configurationReference: "work-search",
      transport: "stdio",
      connectionId: "connection-mcp",
      connectionRevision: 2,
      capabilityId: "knowledge.content.search",
      toolName: "search_work"
    });
    runtime.prepareGrant.mockResolvedValue({ status: "granted", grant: { id: "grant-mcp" } });
    mcpFactory.mockRejectedValue(new Error("The selected MCP server is unavailable."));
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      { workspaceId: "workspace-1" }
    );
    await expect(executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    )).rejects.toThrow(/selected MCP server is unavailable/i);
    expect(runtime.executeTool).not.toHaveBeenCalled();
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

  it("turns a missing Connection into actionable, no-fallback search guidance", async () => {
    runtime.prepareGrant.mockRejectedValue(Object.assign(
      new Error("No authorized Connection can provide this capability."),
      { code: "no-eligible-connection", retryable: false }
    ));
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, { workspaceId: "workspace-1" });

    await expect(executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    )).rejects.toThrow(/connect a supported work source or bind an MCP cited-search tool/i);
    await expect(executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    )).rejects.toThrow(/no connected source was searched/i);
    expect(gate.waitForDecision).not.toHaveBeenCalled();
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });

  it("explains degraded Connection failure without silently switching sources", async () => {
    runtime.prepareGrant.mockRejectedValue(Object.assign(
      new Error("The selected Connection is not healthy enough for this capability."),
      { code: "connection-unhealthy", retryable: true }
    ));
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      { workspaceId: "workspace-1" }
    );

    await expect(executor(
      connectionApproval,
      JSON.stringify({ capability: "knowledge.content.search", input: { query: "Q3" } })
    )).rejects.toThrow(/did not silently use a different source/i);
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});
