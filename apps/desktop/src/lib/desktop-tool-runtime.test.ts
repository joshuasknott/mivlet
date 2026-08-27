import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import type { McpFrame, McpNotification, McpRequest } from "@fable/connectors";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const runtime = vi.hoisted(() => ({
  attestMissionMcp: vi.fn(),
  prepareGrant: vi.fn(),
  commitGrant: vi.fn(),
  executeTool: vi.fn(),
  prepareHosted: vi.fn(),
  launchHosted: vi.fn(),
  inspectHosted: vi.fn(),
  prepareBrowser: vi.fn(),
  navigateBrowser: vi.fn(),
  prepareBrowserAction: vi.fn(),
  actBrowser: vi.fn(),
  prepareSchedule: vi.fn(),
  createSchedule: vi.fn(),
  prepareScheduleCancel: vi.fn(),
  cancelSchedule: vi.fn(),
  prepareScheduleControl: vi.fn(),
  controlSchedule: vi.fn(),
  prepareAgentRoutine: vi.fn(),
  createAgentRoutine: vi.fn(),
  prepareAgentRoutineCancel: vi.fn(),
  cancelAgentRoutine: vi.fn(),
  prepareAgentRoutineControl: vi.fn(),
  controlAgentRoutine: vi.fn(),
  resolveRoute: vi.fn()
}));
const mcpFactory = vi.hoisted(() => vi.fn());

vi.mock("../runtime", () => ({
  attestRuntimeMissionMcpConnectedSearch: runtime.attestMissionMcp,
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
  prepareRuntimeHostedProcessSchedule: runtime.prepareSchedule,
  createRuntimeHostedProcessSchedule: runtime.createSchedule,
  prepareRuntimeHostedProcessScheduleCancel: runtime.prepareScheduleCancel,
  cancelRuntimeHostedProcessSchedule: runtime.cancelSchedule,
  prepareRuntimeHostedProcessScheduleControl: runtime.prepareScheduleControl,
  controlRuntimeHostedProcessSchedule: runtime.controlSchedule,
  prepareRuntimeHostedAgentRoutine: runtime.prepareAgentRoutine,
  createRuntimeHostedAgentRoutine: runtime.createAgentRoutine,
  prepareRuntimeHostedAgentRoutineCancel: runtime.prepareAgentRoutineCancel,
  cancelRuntimeHostedAgentRoutine: runtime.cancelAgentRoutine,
  prepareRuntimeHostedAgentRoutineControl: runtime.prepareAgentRoutineControl,
  controlRuntimeHostedAgentRoutine: runtime.controlAgentRoutine,
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
      service: "Fable cloud computer",
      action: "Run sh on this teammate's cloud computer",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["program: sh", "argument 1: -lc", "argument 2: pwd"],
      consequence: "Runs the exact displayed program on the teammate cloud computer.",
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

    await expect(executor(sourceApproval, JSON.stringify({ command: "pwd" }))).resolves.toBe("/workspace");
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
      service: "Fable cloud computer",
      action: "Open https://example.com/ in this teammate's cloud browser",
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
      service: "Fable cloud computer",
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
      service: "Fable cloud computer",
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

describe("durable hosted process schedules", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses two exact approvals and returns a credential-free schedule projection", async () => {
    const args = {
      scheduleId: "schedule-digest-123",
      runId: "scheduled-digest",
      argv: ["node", "digest.mjs"],
      firstRunAt: "2026-08-25T18:00:00.000Z",
      intervalSeconds: 3600
    };
    const sourceApproval: ApprovalRequest = {
      id: "native-cloud-process-schedule",
      service: "openai",
      action: "cloud-process-schedule scheduleId: schedule-digest-123",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [],
      consequence: "Schedule the program.",
      requestedAt: "2026-08-25T16:00:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-process-schedule"
    };
    const hostedApproval: ApprovalRequest = {
      id: "approval-hosted-schedule-a",
      service: "Fable cloud computer",
      action: "Schedule node on this teammate's cloud computer",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["schedule: schedule-digest-123"],
      consequence: "Runs repeatedly.",
      requestedAt: "2026-08-25T16:00:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "schedule on cloud computer"
    };
    const proposal = {
      requestKey: "schedule-request-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      ...args
    };
    runtime.prepareSchedule.mockResolvedValue({
      proposal,
      proposalFingerprint: "schedule-fingerprint-a",
      approval: hostedApproval
    });
    runtime.createSchedule.mockResolvedValue({
      scheduleId: args.scheduleId,
      requestKey: proposal.requestKey,
      runId: args.runId,
      lifecycle: "active",
      firstRunAt: args.firstRunAt,
      intervalSeconds: args.intervalSeconds,
      nextRunAt: args.firstRunAt,
      generation: 2,
      updatedAt: "2026-08-25T16:00:02.000Z"
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
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, hostedApproval);
    expect(runtime.createSchedule).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: hostedApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(queueApproval).toHaveBeenCalledWith(
      hostedApproval,
      "cloud-process-schedule",
      JSON.stringify({
        scheduleId: args.scheduleId,
        firstRunAt: args.firstRunAt,
        intervalSeconds: args.intervalSeconds,
        computer: "agent-research"
      })
    );
    expect(output).toContain('"lifecycle":"active"');
    expect(output).toContain('"instructionAuthority":"none"');
    expect(output).not.toContain("argv");
  });

  it("cancels future launches through a second exact approval", async () => {
    const scheduleId = "schedule-digest-123";
    const sourceApproval: ApprovalRequest = {
      id: "native-cloud-process-schedule-cancel",
      service: "openai",
      action: `cloud-process-schedule-cancel scheduleId: ${scheduleId}`,
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [`scheduleId: ${scheduleId}`],
      consequence: "Cancel the schedule.",
      requestedAt: "2026-08-25T16:10:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-process-schedule-cancel"
    };
    const cancelApproval: ApprovalRequest = {
      id: "approval-hosted-schedule-cancel-a",
      service: "Fable cloud computer",
      action: `Cancel hosted schedule ${scheduleId}`,
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [`schedule: ${scheduleId}`],
      consequence: "Stops future launches.",
      requestedAt: "2026-08-25T16:10:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "cancel cloud schedule"
    };
    const proposal = {
      requestKey: "schedule-cancel-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      scheduleId
    };
    runtime.prepareScheduleCancel.mockResolvedValue({
      proposal,
      proposalFingerprint: "schedule-cancel-fingerprint-a",
      approval: cancelApproval
    });
    runtime.cancelSchedule.mockResolvedValue({
      scheduleId,
      requestKey: "schedule-request-a",
      runId: "scheduled-digest",
      lifecycle: "cancelled",
      firstRunAt: "2026-08-25T18:00:00.000Z",
      intervalSeconds: 3600,
      generation: 2,
      updatedAt: "2026-08-25T16:10:02.000Z"
    });
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const executor = createDesktopToolExecutor(gate, {
      hostedComputer: {
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        ready: true
      }
    });

    const output = await executor(sourceApproval, JSON.stringify({ scheduleId }));
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(1, sourceApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, cancelApproval);
    expect(runtime.cancelSchedule).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: cancelApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(output).toContain('"lifecycle":"cancelled"');
  });
});

describe("durable hosted agent routines", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses source and exact standing-authority approvals and returns a bounded routine projection", async () => {
    const args = {
      routineId: "routine-research-digest-123",
      runId: "routine-research-digest",
      title: "Research digest",
      instruction: "Review the workspace notes and write a concise weekly digest.",
      firstRunAt: "2026-08-26T18:00:00.000Z",
      intervalSeconds: 86_400,
      capabilities: ["workspace-read", "workspace-write"],
      maxSteps: 6
    };
    const sourceApproval: ApprovalRequest = {
      id: "native-cloud-agent-routine",
      service: "openai",
      action: `cloud-agent-routine routineId: ${args.routineId}`,
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [],
      consequence: "Create the cloud routine.",
      requestedAt: "2026-08-26T16:00:00.000Z",
      decisions: ["once", "modify", "deny"],
      confirmationPhrase: "approve cloud-agent-routine"
    };
    const hostedApproval: ApprovalRequest = {
      id: "approval-hosted-agent-routine-a",
      service: "Fable cloud computer",
      action: `Create hosted routine ${args.title}`,
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: [
        `routine: ${args.routineId}`,
        "standing capability: workspace-read",
        "standing capability: workspace-write"
      ],
      consequence: "Reinterprets the approved instruction on every recurrence.",
      requestedAt: "2026-08-26T16:00:01.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "create cloud routine"
    };
    const proposal = {
      requestKey: "routine-request-a",
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop",
      ...args
    };
    runtime.prepareAgentRoutine.mockResolvedValue({
      proposal,
      proposalFingerprint: "routine-fingerprint-a",
      approval: hostedApproval
    });
    runtime.createAgentRoutine.mockResolvedValue({
      ...proposal,
      lifecycle: "active",
      nextRunAt: args.firstRunAt,
      generation: 1,
      updatedAt: "2026-08-26T16:00:02.000Z"
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
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, hostedApproval);
    expect(runtime.createAgentRoutine).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: hostedApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(queueApproval).toHaveBeenCalledWith(
      hostedApproval,
      "cloud-agent-routine",
      JSON.stringify({ routineId: args.routineId, title: args.title, computer: "agent-research" })
    );
    expect(output).toContain('"lifecycle":"active"');
    expect(output).toContain('"capabilities":["workspace-read","workspace-write"]');
    expect(output).toContain("including while Fable is closed");
    expect(output).not.toContain(args.instruction);
    expect(output).not.toContain("requestKey");
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
      runId: "run-1", workerId: "worker-1", workerStartedEventId: "event-start", routeSelectedEventId: "event-route",
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
