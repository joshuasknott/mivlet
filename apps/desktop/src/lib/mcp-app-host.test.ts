import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
    onsizechange?: (size: { width?: number; height?: number }) => void;
    onloggingmessage?: () => void;
    constructor() { bridgeInstances.push(this as unknown as Record<string, unknown>); }
    async connect() { return undefined; }
    getAppVersion() { return { name: "official-example", version: "1" }; }
    async sendToolInput() { return undefined; }
    async sendToolResult() { return undefined; }
    async sendToolCancelled() { return undefined; }
    async teardownResource() { return {}; }
  }
  class FakeTransport { async close() { return undefined; } }
  return {
    AppBridge: FakeBridge,
    PostMessageTransport: FakeTransport,
    buildAllowAttribute: (permissions: Record<string, unknown> | undefined) => Object.keys(permissions ?? {}).join(";"),
    getToolUiResourceUri: (tool: Tool) => {
      const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
      return meta?.ui?.resourceUri;
    },
  };
});
import { McpAppHostSession, srcDocForMcpApp } from "./mcp-app-host";

const tool = {
  name: "official_example",
  description: "Official MCP Apps example",
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: "ui://official-example/view.html" } },
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
    prepareResourceRead: vi.fn().mockResolvedValue({ proposal: { operation: "resource", toolName: "resources/read", arguments: { uri: "ui://official-example/view.html" } }, prepared: { approval } }),
    authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "permit-once" }),
    executeAuthorizedToolCall: vi.fn().mockResolvedValue(result),
  } as never;
}

describe("MCP Apps host", () => {
  it("loads the official Apps resource through the existing approval boundary and keeps it opaque", async () => {
    const requestApproval = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "2026-10-08T00:00:00.000Z" });
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://official-example/view.html", mimeType: "text/html;profile=mcp-app", text: "<script>parent.postMessage({secret:document.cookie}, '*')</script>", metadata: { ui: { csp: { connectDomains: [] } } } }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, requestApproval });
    const resource = await session.loadResource();
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(resource.uri).toBe("ui://official-example/view.html");
    expect(srcDocForMcpApp(resource)).toContain("default-src 'none'");
    expect(srcDocForMcpApp(resource)).not.toContain("allow-same-origin");
  });

  it("rejects stale results before fetching an untrusted resource", async () => {
    const transport = transportFor({ content: [] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, tool, isCurrent: () => false, requestApproval: vi.fn() });
    await expect(session.loadResource()).rejects.toThrow("stale");
    expect(transport.prepareResourceRead).not.toHaveBeenCalled();
  });

  it("rejects undeclared network origins from resource metadata", async () => {
    const transport = transportFor({ content: [{ kind: "embedded-text", uri: "ui://official-example/view.html", mimeType: "text/html", text: "<p>example</p>", metadata: { ui: { csp: { connectDomains: ["http://insecure.example"] } } } }] });
    const session = new McpAppHostSession({ workspaceId: "workspace-a", conversationId: "conversation-a", resultId: "result-a", generation: 3, transport, requestApproval: vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "now" }), tool });
    await expect(session.loadResource()).rejects.toThrow("HTTPS");
  });
});
