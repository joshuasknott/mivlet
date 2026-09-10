import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import type { McpFrame, McpNotification, McpRequest } from "@fable/connectors";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";
import { buildToolApproval } from "@fable/connectors/native-api/approvals";

describe("computer authority across approvals", () => {
  const args = '{"path":"report.txt","content":"draft"}';
  const approval = () => buildToolApproval("Mivlet", "write-file", args);
  const computer = () => ({ workspaceId: "workspace-a", agentId: "agent-a", ready: true, generation: 4, controller: "agent" as const });
  it("prepares a new computer before binding the exact tool approval", async () => {
    runtime.executeTool.mockResolvedValue({ ok: true, output: "Saved" });
    const current = { ...computer(), ready: false };
    const queueApproval = vi.fn();
    const prepareLocalComputer = vi.fn(async () => { current.ready = true; current.generation = 5; });
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, {
      localComputer: { ...current }, localComputerCurrent: () => current, prepareLocalComputer, queueApproval,
    });
    await expect(execute(approval(), args)).resolves.toBe("Saved");
    expect(prepareLocalComputer).toHaveBeenCalledWith("write-file");
    expect(queueApproval).toHaveBeenCalledWith(expect.objectContaining({ dataUsed: expect.arrayContaining(["Computer generation: 5"]) }), "write-file", args);
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({ computerGeneration: 5 }));
  });
  it("does not queue or execute an action when first-use preparation fails", async () => {
    runtime.executeTool.mockClear();
    const queueApproval = vi.fn();
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, {
      localComputer: { ...computer(), ready: false }, queueApproval,
      prepareLocalComputer: async () => { throw new Error("Enable Computer Use in Plugins."); },
    });
    await expect(execute(approval(), args)).rejects.toThrow("Enable Computer Use");
    expect(queueApproval).not.toHaveBeenCalled();
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
  it("rejects approval granted after takeover and return without replaying the action", async () => {
    runtime.executeTool.mockClear();
    const current = computer();
    const execute = createDesktopToolExecutor({ waitForDecision: async () => { current.generation += 2; return "granted"; } }, {
      localComputer: current, localComputerCurrent: () => current,
    });
    await expect(execute(approval(), args)).rejects.toThrow("control changed");
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
  it("binds a valid native call to the generation captured before approval", async () => {
    runtime.executeTool.mockResolvedValue({ ok: true, output: "Saved" });
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, { localComputer: computer() });
    await expect(execute(approval(), args)).resolves.toBe("Saved");
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({ computerGeneration: 4, workspaceId: "workspace-a", agentId: "agent-a" }));
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      approval: expect.objectContaining({ decision: "once", confirmationText: "approve write-file" }),
    }));
  });
  it("discards an in-flight result after a scope/control change", async () => {
    const current = computer();
    runtime.executeTool.mockImplementationOnce(async () => { current.generation++; return { ok: true, output: "old private result" }; });
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, { localComputer: current, localComputerCurrent: () => current });
    await expect(execute(approval(), args)).rejects.toThrow("control changed");
  });
  it("does not execute when cancellation arrives during approval", async () => {
    runtime.executeTool.mockClear();
    let cancelled = false;
    const execute = createDesktopToolExecutor({ waitForDecision: async () => { cancelled = true; return "granted"; } }, { localComputer: computer(), shouldCancel: () => cancelled });
    await expect(execute(approval(), args)).rejects.toThrow("cancelled");
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});

describe("native connector chat tools", () => {
  it("passes an approved Drive read to the scoped native boundary", async () => {
    runtime.executeTool.mockResolvedValue({ ok: true, output: "live result" });
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, { workspaceId: "workspace-1", connectorAccessCurrent: (id) => id === "google-drive" });
    const args = '{"operation":"search","query":""}';
    expect(await execute(buildToolApproval("Codex", "google-drive-read", args), args)).toBe("live result");
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "google-drive-read", workspaceId: "workspace-1", arguments: { operation: "search", query: "" } }));
  });
  it("rechecks connector access after approval and before egress", async () => {
    runtime.executeTool.mockClear();
    let allowed = true;
    const execute = createDesktopToolExecutor({ waitForDecision: async () => { allowed = false; return "granted"; } }, { workspaceId: "workspace-1", connectorAccessCurrent: () => allowed });
    await expect(execute(buildToolApproval("Codex", "gmail-read", "{}"), "{}")).rejects.toThrow("Mention this connected app");
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
  it("routes Slack search through the async connector boundary", async () => {
    runtime.executeTool.mockResolvedValue({ ok: true, output: '{"items":[{"title":"Updates","trust":"untrusted"}]}' });
    const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, { workspaceId: "workspace-1", connectorAccessCurrent: () => true });
    const result = await execute(buildToolApproval("Codex", "search-slack", '{"query":"launch"}'), '{"query":"launch"}');
    expect(result).toContain('"trust":"untrusted"');
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "search-slack", workspaceId: "workspace-1", arguments: { query: "launch" } }));
  });
});

const runtime = vi.hoisted(() => ({
  prepareGrant: vi.fn(),
  commitGrant: vi.fn(),
  executeTool: vi.fn(),
  searchConnector: vi.fn(),
  prepareHosted: vi.fn(),
  launchHosted: vi.fn(),
  inspectHosted: vi.fn(),
  prepareBrowser: vi.fn(),
  navigateBrowser: vi.fn(),
  prepareBrowserAction: vi.fn(),
  actBrowser: vi.fn(),
  resolveRoute: vi.fn()
}));
const mcpFactory = vi.hoisted(() => vi.fn());

vi.mock("../runtime", () => ({
  searchRuntimeConnector: runtime.searchConnector,
  prepareRuntimeCapabilityGrant: runtime.prepareGrant,
  commitRuntimeCapabilityGrant: runtime.commitGrant,
  executeRuntimeToolCall: runtime.executeTool,
  prepareRuntimeHostedProcess: runtime.prepareHosted,
  launchRuntimeHostedProcess: runtime.launchHosted,
  inspectRuntimeHostedProcess: runtime.inspectHosted,
  prepareRuntimeHostedBrowser: runtime.prepareBrowser,
  navigateRuntimeHostedBrowser: runtime.navigateBrowser,
  prepareRuntimeHostedBrowserAction: runtime.prepareBrowserAction,
  actRuntimeHostedBrowser: runtime.actBrowser,
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

describe("hosted computer shell execution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a distinct cloud confirmation and returns bounded remote output", async () => {
    const sourceApproval: ApprovalRequest = {
      id: "native-run-cloud-shell",
      service: "openai",
      action: "run-shell command: pwd",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["command: pwd"],
      consequence: "Execute the run-shell tool via openai with the given arguments.",
      requestedAt: "2026-08-24T12:00:00.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "approve run-shell"
    };
    const cloudApproval: ApprovalRequest = {
      id: "approval-hosted-process-a",
      service: "Mivlet cloud computer",
      action: "Run sh on this agent's cloud computer",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["program: sh", "argument 1: -lc", "argument 2: pwd"],
      consequence: "Runs the exact displayed program on the agent cloud computer.",
      requestedAt: "2026-08-24T12:00:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "run on cloud computer"
    };
    const proposal = {
      requestKey: "process-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      runId: "hosted-native-run-cloud-shell",
      argv: ["sh", "-lc", "pwd"] as [string, ...string[]],
      cwd: "/workspace",
      timeoutMs: 900_000
    };
    runtime.prepareHosted.mockResolvedValue({
      proposal,
      proposalFingerprint: "fingerprint-a",
      approval: cloudApproval
    });
    runtime.launchHosted.mockResolvedValue({
      requestKey: "process-a",
      runId: proposal.runId,
      lifecycle: "completed",
      processId: "sandbox-process-a",
      exitCode: 0,
      stdout: "/workspace\n"
    });
    const queueApproval = vi.fn();
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, {
      workspaceId: "workspace-local",
      hostedComputer: {
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        ready: true
      },
      queueApproval
    });

    await expect(executor(sourceApproval, JSON.stringify({ command: "pwd", location: "hosted" }))).resolves.toBe("/workspace");
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(1, sourceApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, cloudApproval);
    expect(queueApproval).toHaveBeenCalledWith(
      cloudApproval,
      "cloud-computer",
      JSON.stringify({ command: "pwd", computer: "agent-research" })
    );
    expect(runtime.launchHosted).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: cloudApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});

describe("local computer tool isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects local shell execution before approval or native dispatch", async () => {
    const shellApproval: ApprovalRequest = {
      id: "native-local-shell-blocked",
      service: "openai",
      action: "run-shell command: pwd",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["command: pwd"],
      consequence: "Run a command.",
      requestedAt: "2026-08-27T12:00:00.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "approve run-shell"
    };
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, {
      workspaceId: "workspace-local",
      localComputer: { workspaceId: "workspace-local", agentId: "agent-research", ready: true, generation: 1, controller: "agent" }
    });
    await expect(executor(shellApproval, JSON.stringify({ command: "pwd" }))).rejects.toThrow("explicitly configured hosted computer");
    expect(gate.waitForDecision).not.toHaveBeenCalled();
    expect(runtime.executeTool).not.toHaveBeenCalled();
    expect(runtime.launchHosted).not.toHaveBeenCalled();
  });

  it("binds file tools to the active agent scope", async () => {
    const fileApproval: ApprovalRequest = {
      id: "native-local-file-read",
      service: "openai",
      action: "read-file path: notes.txt",
      mode: "read-only",
      riskLevel: "low",
      dataUsed: ["path: notes.txt"],
      consequence: "Read a file.",
      requestedAt: "2026-08-27T12:00:00.000Z",
      decisions: ["once", "deny"]
    };
    runtime.executeTool.mockResolvedValue({ ok: true, output: "private notes" });
    const executor = createDesktopToolExecutor(
      { waitForDecision: async () => "granted" },
      {
        workspaceId: "workspace-local",
        localComputer: { workspaceId: "workspace-local", agentId: "agent-research", ready: true, generation: 1, controller: "agent" }
      }
    );

    await expect(executor(fileApproval, JSON.stringify({ path: "notes.txt" })))
      .resolves.toBe("private notes");
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: "read-file",
      workspaceId: "workspace-local",
      agentId: "agent-research"
    }));
  });

  it("routes approved native application observation to the active agent without exposing a frame", async () => {
    const browserApproval: ApprovalRequest = {
      id: "native-local-app-observe",
      service: "openai",
      action: "local-app-observe ",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [""],
      consequence: "Observe the selected application.",
      requestedAt: "2026-08-27T12:00:00.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "approve local-app-observe"
    };
    const output = JSON.stringify({
      computerId: "local-opaque",
      currentUrl: "https://example.com/",
      title: "Example Domain",
      updatedAt: "2026-08-27T12:00:01.000Z"
    });
    runtime.executeTool.mockResolvedValue({ ok: true, output });
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, {
      workspaceId: "workspace-local",
      localComputer: { workspaceId: "workspace-local", agentId: "agent-research", ready: true, generation: 1, controller: "agent" }
    });

    await expect(executor(browserApproval, JSON.stringify({})))
      .resolves.toBe(output);
    expect(gate.waitForDecision).toHaveBeenCalledWith({ ...browserApproval, dataUsed: [...browserApproval.dataUsed,
      "Computer workspace: workspace-local", "Computer agent: agent-research", "Computer generation: 1"] });
    expect(runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: "local-app-observe",
      workspaceId: "workspace-local",
      agentId: "agent-research",
      arguments: {}
    }));
    expect(output).not.toContain("data:image");
  });

  it("rejects native application observation before approval when the agent computer is not set up", async () => {
    const browserApproval: ApprovalRequest = {
      id: "native-local-app-observe-missing",
      service: "openai",
      action: "local-app-observe ",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [""],
      consequence: "Observe the selected application.",
      requestedAt: "2026-08-27T12:00:00.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "approve local-app-observe"
    };
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate);

    await expect(executor(browserApproval, JSON.stringify({})))
      .rejects.toThrow(/control changed or is paused/i);
    expect(gate.waitForDecision).not.toHaveBeenCalled();
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});

describe("hosted cloud browser execution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires source and exact-navigation approvals without returning bearer URLs to the model", async () => {
    const sourceApproval: ApprovalRequest = {
      id: "native-open-cloud-browser",
      service: "openai",
      action: "cloud-browser url: https://example.com/",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["url: https://example.com/"],
      consequence: "Execute cloud-browser via openai.",
      requestedAt: "2026-08-25T12:00:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-browser"
    };
    const browserApproval: ApprovalRequest = {
      id: "approval-hosted-browser-a",
      service: "Mivlet cloud computer",
      action: "Open https://example.com/ in this agent's cloud browser",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["page: https://example.com/"],
      consequence: "Navigates the cloud browser to the exact displayed page.",
      requestedAt: "2026-08-25T12:00:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "open cloud browser"
    };
    const proposal = {
      requestKey: "browser-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      url: "https://example.com/"
    };
    runtime.prepareBrowser.mockResolvedValue({
      proposal,
      proposalFingerprint: "browser-fingerprint-a",
      approval: browserApproval
    });
    runtime.navigateBrowser.mockResolvedValue({
      currentUrl: proposal.url,
      title: "Example Domain",
      observationId: "observation-1234567890abcdef",
      viewport: { scrollX: 0, scrollY: 0, width: 1280, height: 800, documentWidth: 1280, documentHeight: 1600, canScrollUp: false, canScrollDown: true },
      navigation: { canGoBack: false, canGoForward: false },
      controls: [{ ref: "control-1234567890abcdef-1", role: "link", name: "More information" }],
      previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
      liveViewUrl: "https://live.browser.run/ui/token?wss=secret",
      updatedAt: "2026-08-25T12:00:02.000Z"
    });
    const queueApproval = vi.fn();
    const onHostedBrowserSnapshot = vi.fn();
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, {
      hostedComputer: {
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        ready: true
      },
      queueApproval,
      onHostedBrowserSnapshot
    });

    const output = await executor(sourceApproval, JSON.stringify({ url: proposal.url }));
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(1, sourceApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, browserApproval);
    expect(queueApproval).toHaveBeenCalledWith(
      browserApproval,
      "cloud-browser-navigation",
      JSON.stringify({ url: proposal.url, computer: proposal.agentId })
    );
    expect(runtime.navigateBrowser).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: browserApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(onHostedBrowserSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ liveViewUrl: expect.stringContaining("live.browser.run") })
    );
    expect(output).toContain('"title":"Example Domain"');
    expect(output).toContain('"name":"More information"');
    expect(output).toContain('"canScrollDown":true');
    expect(output).toContain('"canGoBack":false');
    expect(output).not.toContain("previewDataUrl");
    expect(output).not.toContain("live.browser.run");
    expect(output).not.toContain("wss=secret");
  });

  it("fails before approval when no cloud computer is ready", async () => {
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const sourceApproval: ApprovalRequest = {
      id: "native-open-cloud-browser",
      service: "openai",
      action: "cloud-browser url: https://example.com/",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["url: https://example.com/"],
      consequence: "Execute cloud-browser via openai.",
      requestedAt: new Date(0).toISOString(),
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-browser"
    };
    const executor = createDesktopToolExecutor(gate);
    await expect(executor(sourceApproval, '{"url":"https://example.com/"}')).rejects.toThrow(
      /set up.*cloud computer/i
    );
    expect(gate.waitForDecision).not.toHaveBeenCalled();
  });

  it("uses an observed control through a second exact approval and returns the next observation", async () => {
    const args = {
      action: "click",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "button",
      controlName: "Continue"
    };
    const sourceApproval: ApprovalRequest = {
      id: "native-browser-action",
      service: "openai",
      action: "cloud-browser-action action: click",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: Object.entries(args).map(([key, value]) => `${key}: ${value}`),
      consequence: "Use one observed control.",
      requestedAt: "2026-08-25T12:01:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-browser-action"
    };
    const actionApproval: ApprovalRequest = {
      id: "approval-hosted-browser-action-a",
      service: "Mivlet cloud computer",
      action: "Click control control-1234567890abcdef-1",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["control name: Continue", "action: click"],
      consequence: "Performs the exact displayed browser interaction.",
      requestedAt: "2026-08-25T12:01:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "act in cloud browser"
    };
    const proposal = {
      requestKey: "browser-action-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      ...args
    };
    runtime.prepareBrowserAction.mockResolvedValue({
      proposal,
      proposalFingerprint: "action-fingerprint-a",
      approval: actionApproval
    });
    runtime.actBrowser.mockResolvedValue({
      currentUrl: "https://example.com/next",
      title: "Next step",
      observationId: "observation-fedcba0987654321",
      viewport: { scrollX: 0, scrollY: 800, width: 1280, height: 800, documentWidth: 1280, documentHeight: 2400, canScrollUp: true, canScrollDown: true },
      navigation: { canGoBack: true, canGoForward: false },
      controls: [{ ref: "control-fedcba0987654321-1", role: "textbox", name: "Search" }],
      previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
      liveViewUrl: "https://live.browser.run/ui/token?wss=private",
      lastDownload: {
        fileName: "report.pdf",
        workspacePath: "/workspace/downloads/action-report.pdf",
        bytesWritten: 4_096
      },
      updatedAt: "2026-08-25T12:01:02.000Z"
    });
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const queueApproval = vi.fn();
    const onHostedBrowserSnapshot = vi.fn();
    const executor = createDesktopToolExecutor(gate, {
      hostedComputer: {
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        ready: true
      },
      queueApproval,
      onHostedBrowserSnapshot
    });

    const output = await executor(sourceApproval, JSON.stringify(args));
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(1, sourceApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, actionApproval);
    expect(runtime.actBrowser).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: actionApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(queueApproval).toHaveBeenCalledWith(
      actionApproval,
      "cloud-browser-control",
      JSON.stringify({ action: "click", controlRole: "button", controlName: "Continue", computer: "agent-research" })
    );
    expect(onHostedBrowserSnapshot).toHaveBeenCalled();
    expect(output).toContain('"observationId":"observation-fedcba0987654321"');
    expect(output).toContain('"instructionAuthority":"none"');
    expect(output).toContain('"workspacePath":"/workspace/downloads/action-report.pdf"');
    expect(output).not.toContain("previewDataUrl");
    expect(output).not.toContain("live.browser.run");
  });

  it("binds a closed page scroll to the current observation and two approvals", async () => {
    const args = {
      action: "scroll",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-0",
      controlRole: "document",
      controlName: "Page",
      value: "page-down"
    } as const;
    const sourceApproval: ApprovalRequest = {
      id: "native-browser-scroll",
      service: "openai",
      action: "cloud-browser-action action: scroll",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: Object.entries(args).map(([key, value]) => `${key}: ${value}`),
      consequence: "Scroll the observed page.",
      requestedAt: "2026-08-25T12:02:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-browser-action"
    };
    const actionApproval: ApprovalRequest = {
      id: "approval-hosted-browser-scroll-a",
      service: "Mivlet cloud computer",
      action: "Scroll the page page-down",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["control name: Page", "action: scroll", "value: page-down"],
      consequence: "Performs the exact displayed browser interaction.",
      requestedAt: "2026-08-25T12:02:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "act in cloud browser"
    };
    const proposal = {
      requestKey: "browser-action-scroll-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      ...args
    };
    runtime.prepareBrowserAction.mockResolvedValue({
      proposal,
      proposalFingerprint: "action-fingerprint-scroll-a",
      approval: actionApproval
    });
    runtime.actBrowser.mockResolvedValue({
      currentUrl: "https://example.com/",
      title: "Example Domain",
      observationId: "observation-fedcba0987654321",
      viewport: { scrollX: 0, scrollY: 800, width: 1280, height: 800, documentWidth: 1280, documentHeight: 1600, canScrollUp: true, canScrollDown: false },
      navigation: { canGoBack: true, canGoForward: false },
      controls: [{ ref: "control-fedcba0987654321-0", role: "document", name: "Page" }],
      previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
      updatedAt: "2026-08-25T12:02:02.000Z"
    });
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const queueApproval = vi.fn();
    const executor = createDesktopToolExecutor(gate, {
      hostedComputer: {
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        ready: true
      },
      queueApproval
    });

    const output = await executor(sourceApproval, JSON.stringify(args));
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(1, sourceApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, actionApproval);
    expect(runtime.actBrowser).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: actionApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(output).toContain('"role":"document"');
    expect(output).toContain('"scrollY":800');
    expect(output).not.toContain("previewDataUrl");
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
    "Allows Mivlet to search this Connection in the named scope. Every search still requires its own exact-action approval.",
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
