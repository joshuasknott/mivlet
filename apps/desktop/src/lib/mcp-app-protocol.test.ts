import { describe, expect, it, vi } from "vitest";
import { App, PostMessageTransport as AppPostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpAppHostSession } from "./mcp-app-host";
import type { DesktopMcpTransportHandle } from "./mcp-transport-contract";

/** Two small window-like peers let the official SDK run without giving the
 * test a parent DOM or a network. This exercises the same AppBridge attach,
 * initialize, message and tool-call path used by McpAppFrame. */
class PeerWindow {
  peer?: PeerWindow;
  private readonly listeners = new Set<(event: { data: unknown; source: PeerWindow; origin: string }) => void>();

  addEventListener(type: string, listener: (event: { data: unknown; source: PeerWindow; origin: string }) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data: unknown; source: PeerWindow; origin: string }) => void) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(data: unknown) {
    const source = this.peer;
    this.listeners.forEach((listener) => listener({ data, source: source!, origin: "null" }));
  }
}


const tool = {
  name: "sdk_fixture",
  description: "MCP Apps SDK protocol fixture",
  inputSchema: { type: "object", properties: {} },
  _meta: { ui: { resourceUri: "ui://sdk-fixture/view.html" } },
} satisfies Tool;

function transport() {
  const approval = {
    id: "mcp-app-approval",
    service: "MCP tool",
    action: "run the approved MCP App tool",
    mode: "read-only",
    riskLevel: "medium",
    dataUsed: [],
    consequence: "Runs the exact MCP App request",
    requestedAt: "2026-10-08T00:00:00.000Z",
    decisions: ["once", "deny"],
  } as never;
  return {
    sessionId: "sdk-fixture-session",
    prepareResourceRead: vi.fn().mockResolvedValue({
      proposal: { operation: "resource", toolName: "resources/read", arguments: { uri: "ui://sdk-fixture/view.html" } },
      prepared: { approval },
    }),
    prepareToolCall: vi.fn().mockResolvedValue({
      proposal: { operation: "tool", toolName: "save_result", arguments: { value: "draft" } },
      prepared: { approval },
    }),
    authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "permit-once", expiresInSeconds: 30 }),
    executeAuthorizedToolCall: vi.fn().mockImplementation(async (proposal: { operation?: string }) =>
      proposal.operation === "resource"
        ? { content: [{ kind: "embedded-text", uri: "ui://sdk-fixture/view.html", mimeType: "text/html;profile=mcp-app", text: "<p>SDK example</p>" }] }
        : { content: [{ kind: "text", text: "saved" }] }),
    subscribeClose: vi.fn(() => () => undefined),
  } as unknown as DesktopMcpTransportHandle;
}

function installMessageWindow(peer: PeerWindow, realWindow: Window) {
  Object.defineProperty(realWindow, "addEventListener", { configurable: true, value: peer.addEventListener.bind(peer) });
  Object.defineProperty(realWindow, "removeEventListener", { configurable: true, value: peer.removeEventListener.bind(peer) });
}

describe("official MCP Apps SDK lifecycle", () => {
  it("performs ui/initialize, message and approved tool calls through the production host session", async () => {
    const hostPeer = new PeerWindow();
    const appPeer = new PeerWindow();
    hostPeer.peer = appPeer;
    appPeer.peer = hostPeer;
    const messages: unknown[] = [];
    const approvals = vi.fn().mockResolvedValue({ request: {}, decision: "once", decidedAt: "2026-10-08T00:00:00.000Z" });
    const mcpTransport = transport();
    const session = new McpAppHostSession({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      resultId: "result-a",
      generation: 4,
      transport: mcpTransport,
      tool,
      requestApproval: approvals,
      onMessage: (message) => messages.push(message),
      isCurrent: () => true,
    });
    await session.loadResource();

    const app = new App({ name: "sdk-fixture-app", version: "1.0.0" }, {}, { autoResize: false, strict: true });
    const iframe = { contentWindow: appPeer, src: "about:blank" } as unknown as HTMLIFrameElement;
    const originalWindow = globalThis.window;
    const originalAddEventListener = originalWindow.addEventListener;
    const originalRemoveEventListener = originalWindow.removeEventListener;
    try {
      installMessageWindow(hostPeer, originalWindow);
      const hostAttached = session.attach(iframe, "mcp-app://localhost/example/index.html");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      installMessageWindow(appPeer, originalWindow);
      const appConnected = app.connect(new AppPostMessageTransport(hostPeer as unknown as Window, hostPeer as unknown as Window));
      await Promise.all([hostAttached, appConnected]);

      await app.sendMessage({ role: "user", content: [{ type: "text", text: "hello from the SDK" }] });
      expect(messages).toHaveLength(1);
      await expect(app.callServerTool({ name: "save_result", arguments: { value: "draft" } })).resolves.toMatchObject({ content: [{ text: "saved" }] });
      expect(approvals).toHaveBeenCalledTimes(2);
      expect(mcpTransport.authorizeToolCall).toHaveBeenCalledTimes(2);
      expect(mcpTransport.executeAuthorizedToolCall).toHaveBeenCalledTimes(2);
      await session.dispose("test teardown");
      expect(session.snapshot().status).toBe("closed");
    } finally {
      Object.defineProperty(originalWindow, "addEventListener", { configurable: true, value: originalAddEventListener });
      Object.defineProperty(originalWindow, "removeEventListener", { configurable: true, value: originalRemoveEventListener });
    }
  });
});
