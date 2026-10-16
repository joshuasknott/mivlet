import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";

const bridgeInstances: Array<Record<string, unknown>> = [];

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => {
  class FakeBridge {
    oncalltool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    onreadresource?: (params: { uri: string }) => Promise<unknown>;
    onmessage?: (params: { content: unknown[] }) => Promise<unknown>;
    onupdatemodelcontext?: (params: Record<string, unknown>) => Promise<unknown>;
    onopenlink?: (params: { url: string }) => Promise<unknown>;
    onrequestdisplaymode?: (params: { mode: string }) => Promise<unknown>;
    onrequestteardown?: () => void;
    oninitialized?: () => void;
    onsizechange?: (size: { width?: number; height?: number }) => void;
    onloggingmessage?: () => void;
    constructor(...args: unknown[]) { bridgeInstances.push({ bridge: this as unknown as Record<string, unknown>, args }); }
    async connect() { this.oninitialized?.(); return undefined; }
    getAppVersion() { return { name: "sdk-fixture", version: "1" }; }
    async sendToolInput() { return undefined; }
    async sendToolResult() { return undefined; }
    async sendToolCancelled() { return undefined; }
    async teardownResource() { return {}; }
  }
  return {
    AppBridge: FakeBridge,
    buildAllowAttribute: (permissions: Record<string, unknown> | undefined) => Object.keys(permissions ?? {}).join(";"),
    getToolUiResourceUri: (tool: Tool) => {
      const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
      return meta?.ui?.resourceUri;
    },
  };
});
import { McpAppHostSession, toMcpAppCallToolResult } from "./mcp-app-host";
import type { DesktopMcpTransportHandle } from "./mcp-transport-contract";

const tool = {
  name: "sdk_fixture",
  description: "MCP Apps test fixture",
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: "ui://sdk-fixture/view.html" } },
} satisfies Tool;

function transportFor(result: unknown) {
  const approval = {
    id: "approval-resource",
    service: "MCP resources",
    action: "read enabled MCP resource",
    mode: "read-only",
    riskLevel: "medium",
    dataUsed: [],
    consequence: "Reads the resource",
    requestedAt: "2026-10-08T00:00:00.000Z",
    decisions: ["once", "deny"],
  } as never;
  return {
    prepareResourceRead: vi.fn().mockResolvedValue({ proposal: { operation: "resource", toolName: "resources/read", arguments: { uri: "ui://sdk-fixture/view.html" } }, prepared: { approval } }),
    prepareToolCall: vi.fn().mockResolvedValue({ proposal: { operation: "tool", toolName: "save_result", arguments: { value: "draft" } }, prepared: { approval } }),
    authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "permit-once" }),
    executeAuthorizedToolCall: vi.fn().mockResolvedValue(result),
    subscribeClose: vi.fn(() => () => undefined),
  } as unknown as DesktopMcpTransportHandle;
}

async function attachForTest(session: McpAppHostSession) {
  await session.loadResource();
  const iframe = {
    contentWindow: new EventTarget(),
    src: "about:blank",
  } as unknown as HTMLIFrameElement;
  await session.attach(iframe, "mcp-app://localhost/token/index.html");
  return bridgeInstances.at(-1)?.bridge as Record<string, unknown>;
}

describe("MCP Apps host", () => {
  it("normalizes standard MCP and JSON-RPC tool result envelopes", () => {
    expect(
      toMcpAppCallToolResult({
        jsonrpc: "2.0",
        id: "tool-1",
        result: {
          content: [{ type: "text", text: "standard result" }],
          structuredContent: { answer: 42 },
        },
      }),
    ).toEqual({
      isError: false,
      content: [{ type: "text", text: "standard result" }],
      structuredContent: { answer: 42 },
    });
  });

  it("loads the Apps fixture resource through the existing approval boundary and keeps it opaque", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "2026-10-08T00:00:00.000Z" });
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html;profile=mcp-app", text: "<script>parent.postMessage({secret:document.cookie}, '*')</script>", metadata: { ui: { csp: { connectDomains: [] } } } }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, requestApproval });
    const resource = await session.loadResource();
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(resource.uri).toBe("ui://sdk-fixture/view.html");
    expect(resource.csp).toContain("default-src 'none'");
    expect(resource.csp).toContain("navigate-to 'none'");
    expect(resource.html).toContain("parent.postMessage");
    expect(session.snapshot().resource).not.toHaveProperty("html");
  });

  it("rejects stale results before fetching an untrusted resource", async () => {
    const transport = transportFor({ content: [] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, isCurrent: () => false, requestApproval: vi.fn() });
    await expect(session.loadResource()).rejects.toThrow("stale");
    expect(transport.prepareResourceRead).not.toHaveBeenCalled();
  });

  it("selects the approved UI resource from a multi-resource response", async () => {
    const transport = transportFor({
      content: [
        {
          kind: "embedded-text",
          uri: "ui://other/view.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>wrong resource</p>",
        },
        {
          kind: "embedded-text",
          uri: "ui://sdk-fixture/view.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>approved resource</p>",
        },
      ],
    });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }),
      tool,
    });
    const resource = await session.loadResource();
    expect(resource.html).toBe("<p>approved resource</p>");
  });

  it("rejects a resource response that omits the approved UI URI", async () => {
    const transport = transportFor({
      content: [{
        kind: "embedded-text",
        uri: "ui://other/view.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<p>wrong resource</p>",
      }],
    });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }),
      tool,
    });
    await expect(session.loadResource()).rejects.toThrow("requested UI resource");
  });

  it("rejects truncated HTML instead of mounting an incomplete app", async () => {
    const transport = transportFor({
      content: [{
        kind: "embedded-text",
        uri: "ui://sdk-fixture/view.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<script>incomplete",
        truncated: true,
      }],
    });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }),
      tool,
    });
    await expect(session.loadResource()).rejects.toThrow("truncated");
  });

  it("rejects undeclared network origins from resource metadata", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>example</p>", metadata: { ui: { csp: { connectDomains: ["http://insecure.example"] } } } }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }), tool });
    await expect(session.loadResource()).rejects.toThrow("HTTPS");
  });

  it("fails closed when a server asks the guest to create nested frames", async () => {
    const transport = transportFor({
      content: [
        {
          kind: "embedded-text",
          uri: "ui://sdk-fixture/view.html",
          mimeType: "text/html",
          text: "<p>example</p>",
          metadata: {
            ui: { csp: { frameDomains: ["https://safe.example"] } },
          },
        },
      ],
    });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      requestApproval: vi.fn().mockResolvedValue({
        request: {},
        decision: "once",
        decidedAt: "now",
      }),
      tool,
    });
    await expect(session.loadResource()).rejects.toThrow(
      "nested frames are unavailable",
    );
  });

  it("routes app tool calls through the same explicit approval and permit boundary", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" });
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, requestApproval });
    const bridge = await attachForTest(session);
    requestApproval.mockClear();
    vi.mocked(transport.authorizeToolCall).mockClear();
    vi.mocked(transport.executeAuthorizedToolCall).mockClear();
    await (bridge.oncalltool as (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>)({ name: "save_result", arguments: { value: "draft" } });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp-app", toolName: "save_result", arguments: { value: "draft" } }));
    expect(transport.prepareToolCall).toHaveBeenCalledWith("save_result", { value: "draft" });
    expect(transport.authorizeToolCall).toHaveBeenCalledOnce();
    expect(transport.executeAuthorizedToolCall).toHaveBeenCalledOnce();
  });

  it("bounds concurrent app actions and returns an actionable busy result", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] });
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      tool,
      requestApproval,
    });
    const bridge = await attachForTest(session);
    requestApproval.mockClear().mockImplementation(
      () => new Promise<ApprovalResolutionRequest | null>(() => undefined),
    );
    const oncalltool = bridge.oncalltool as (params: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    const actions = Array.from({ length: 9 }, () => oncalltool({ name: "save_result", arguments: { value: "draft" } }));
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(8));
    const overflow = await actions[8];
    expect(overflow.isError).toBe(true);
    expect(overflow.content[0]?.text).toContain("too many actions");
    expect(transport.prepareToolCall).toHaveBeenCalledTimes(8);
    await session.dispose("test teardown");
  });

  it("bounds concurrent external resource reads per app session", async () => {
    const resolutions: Array<(value: ApprovalResolutionRequest | null) => void> = [];
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport: transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] }),
      tool,
      requestApproval,
    });
    const bridge = await attachForTest(session);
    resolutions.length = 0;
    requestApproval.mockClear().mockImplementation(
      () => new Promise<ApprovalResolutionRequest | null>((resolve) => resolutions.push(resolve)),
    );
    const reads = Array.from({ length: 5 }, (_, index) =>
      (bridge.onreadresource as (params: { uri: string }) => Promise<unknown>)({ uri: `ui://external/resource-${index}` }),
    );
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(4));
    const overflow = await reads[4];
    expect(overflow).toEqual({ contents: [] });
    expect(resolutions).toHaveLength(4);
    for (const resolve of resolutions)
      resolve({ request: {}, decision: "deny", decidedAt: "now" } as ApprovalResolutionRequest);
    await Promise.all(reads.slice(0, 4));
    await session.dispose("test teardown");
  });

  it("does not execute an app action when the host approval is denied", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] });
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, requestApproval });
    const bridge = await attachForTest(session);
    requestApproval.mockClear().mockResolvedValue(null);
    vi.mocked(transport.authorizeToolCall).mockClear();
    vi.mocked(transport.executeAuthorizedToolCall).mockClear();
    const result = await (bridge.oncalltool as (params: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }> )({ name: "save_result", arguments: { value: "draft" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("denied");
    expect(transport.authorizeToolCall).not.toHaveBeenCalled();
    expect(transport.executeAuthorizedToolCall).not.toHaveBeenCalled();
  });

  it("does not authorize a pending app action after the result is disposed", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] });
    let resolveApproval: (value: ApprovalResolutionRequest | null) => void = () => undefined;
    const approvalPending = new Promise<ApprovalResolutionRequest | null>((resolve) => {
      resolveApproval = resolve;
    });
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" });
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport,
      tool,
      requestApproval,
    });
    const bridge = await attachForTest(session);
    requestApproval.mockClear().mockReturnValue(approvalPending);
    vi.mocked(transport.authorizeToolCall).mockClear();
    vi.mocked(transport.executeAuthorizedToolCall).mockClear();
    const running = (bridge.oncalltool as (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>)({ name: "save_result", arguments: { value: "draft" } });
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
    await session.dispose("Stop requested");
    resolveApproval({ request: {}, decision: "once", decidedAt: "now" } as ApprovalResolutionRequest);

    const result = await running as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("closed");
    expect(transport.authorizeToolCall).not.toHaveBeenCalled();
    expect(transport.executeAuthorizedToolCall).not.toHaveBeenCalled();
  });

  it("does not advertise optional app capabilities without an explicit host policy", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>example</p>" }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }) });
    await session.loadResource();
    const iframe = { contentWindow: new EventTarget(), src: "about:blank" } as unknown as HTMLIFrameElement;
    await session.attach(iframe, "mcp-app://localhost/token/index.html");
    const last = bridgeInstances.at(-1)?.args as unknown[];
    const capabilities = last[2] as Record<string, unknown>;
    const options = last[3] as { hostContext?: { availableDisplayModes?: string[] } };
    expect(capabilities.openLinks).toBeUndefined();
    expect(capabilities.message).toBeUndefined();
    expect(capabilities.updateModelContext).toBeUndefined();
    expect(options.hostContext?.availableDisplayModes).toEqual(["inline"]);
    await session.dispose();
  });

  it("rejects a stale app teardown before touching the host callback", async () => {
    const onRequestTeardown = vi.fn();
    let current = true;
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 3,
      transport: transportFor({ content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html", text: "<p>app</p>" }] }),
      isCurrent: () => current,
      onRequestTeardown,
      requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }),
      tool,
    });
    const bridge = await attachForTest(session);
    current = false;
    expect(() => (bridge.onrequestteardown as () => void)()).toThrow("stale");
    expect(onRequestTeardown).not.toHaveBeenCalled();
  });
});
