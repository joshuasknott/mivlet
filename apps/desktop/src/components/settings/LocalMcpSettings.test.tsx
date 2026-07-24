import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpFrame, McpNotification, McpRequest, McpTransport } from "@fable/connectors";

const runtime = vi.hoisted(() => ({
  beginAuth: vi.fn(),
  commit: vi.fn(),
  disconnectAuth: vi.fn(),
  inspectAuth: vi.fn(),
  list: vi.fn(),
  prepare: vi.fn(),
  resolve: vi.fn(),
  setEnablement: vi.fn()
}));
const transportFactory = vi.hoisted(() => vi.fn());

vi.mock("../../runtime", () => ({
  beginRuntimeRemoteMcpAuthorization: runtime.beginAuth,
  commitRuntimeMcpServerConfiguration: runtime.commit,
  disconnectRuntimeRemoteMcpAuthorization: runtime.disconnectAuth,
  inspectRuntimeRemoteMcpAuthorization: runtime.inspectAuth,
  listRuntimeMcpServerConfigurations: runtime.list,
  prepareRuntimeMcpServerConfiguration: runtime.prepare,
  resolveRuntimeApprovalRequest: runtime.resolve,
  setRuntimeMcpEnablement: runtime.setEnablement
}));
vi.mock("../../lib/mcp-transport", () => ({
  createDesktopMcpTransport: transportFactory,
  createDesktopRemoteMcpTransport: transportFactory
}));

import { LocalMcpSettings } from "./LocalMcpSettings";

const summary = {
  id: "local-files",
  workspaceId: "workspace-a",
  displayName: "Local files",
  transport: "stdio" as const,
  revision: 1,
  disabled: false,
  createdByInternalUserId: "user-a",
  createdAt: "2026-07-11T18:00:00Z",
  updatedAt: "2026-07-11T18:00:00Z"
};

const approval = {
  id: "approval-1",
  service: "MCP connections",
  action: "configure local MCP server local-files",
  mode: "full-access" as const,
  riskLevel: "critical" as const,
  dataUsed: ["server: Local files", "configuration fingerprint: abc"],
  consequence: "Starts a user-managed local program that can expose tools and resources to Fable.",
  requestedAt: "2026-07-11T18:00:00Z",
  decisions: ["once" as const, "deny" as const],
  confirmationPhrase: "configure local-files"
};

class FixtureTransport implements McpTransport {
  private handler?: (frame: McpFrame) => void;
  async send(frame: McpRequest | McpNotification): Promise<void> {
    if (!("id" in frame)) return;
    const result = frame.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }
      : frame.method === "tools/list"
        ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
        : { resources: [{ uri: "file:///safe", name: "Safe" }] };
    queueMicrotask(() => this.handler?.({ jsonrpc: "2.0", id: frame.id, result }));
  }
  subscribe(handler: (frame: McpFrame) => void): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }
  subscribeClose(): () => void { return () => undefined; }
  async recordDiscovery(): Promise<unknown> {
    return {
      connectionId: "connection-mcp",
      connectionRevision: 2,
      launchReference: "local-files",
      discoveryState: "discovered",
      discoveredTools: ["read"],
      discoveredResources: ["file:///safe"],
      enabledTools: [],
      enabledResources: [],
      capabilityBindings: []
    };
  }
  async close(): Promise<void> {}
}

beforeEach(() => {
  runtime.beginAuth.mockReset().mockResolvedValue({
    status: "connected",
    issuer: "https://auth.example.com",
    scopes: ["files:read"],
    clientRegistrationStrategy: "dynamic-client-registration",
    message: "stored"
  });
  runtime.commit.mockReset().mockResolvedValue(summary);
  runtime.disconnectAuth.mockReset().mockResolvedValue({ status: "disconnected", message: "removed" });
  runtime.inspectAuth.mockReset().mockResolvedValue({
    issuer: "https://auth.example.com",
    pkceMethod: "S256",
    scopes: [],
    clientRegistrationStrategy: "dynamic-client-registration"
  });
  runtime.list.mockReset().mockResolvedValue([]);
  runtime.prepare.mockReset().mockResolvedValue({ configurationFingerprint: "abc", approval });
  runtime.resolve.mockReset().mockResolvedValue({ persisted: true });
  runtime.setEnablement.mockReset().mockImplementation(async (_workspace, _connection, revision, tools, resources, bindings) => ({
    connectionId: "connection-mcp", connectionRevision: revision + 1, launchReference: "local-files",
    discoveryState: "discovered", discoveredTools: ["read"], discoveredResources: ["file:///safe"],
    enabledTools: tools, enabledResources: resources, capabilityBindings: bindings.map(
      (binding: { capabilityId: string; toolName: string }) => ({
        ...binding,
        contractVersion: "fable.connected-source-search.v1",
        consequence: "read",
        trust: "untrusted"
      })
    )
  }));
  transportFactory.mockReset().mockResolvedValue(new FixtureTransport());
});

describe("LocalMcpSettings", () => {
  it("requires exact confirmation before saving an approved local server", async () => {
    runtime.list.mockResolvedValueOnce([]).mockResolvedValueOnce([summary]);
    const status = vi.fn();
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={status} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    await screen.findByText("No tool servers saved.");

    fireEvent.click(screen.getByText("Add a server"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local files" } });
    fireEvent.change(screen.getByLabelText("Program path"), { target: { value: "C:\\tools\\mcp.exe" } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: "--stdio\nC:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));

    const dialog = await screen.findByRole("dialog", { name: "Allow Local files to run?" });
    const save = within(dialog).getByRole("button", { name: "Save server" });
    await waitFor(() => expect(within(dialog).getByLabelText(/Type/)).toHaveFocus());
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type/), { target: { value: "configure local-files" } });
    fireEvent.click(save);

    await waitFor(() => expect(runtime.resolve).toHaveBeenCalledTimes(1));
    expect(runtime.resolve.mock.calls[0]?.[0]).toMatchObject({
      request: approval,
      decision: "once",
      confirmationText: "configure local-files"
    });
    await waitFor(() => expect(runtime.commit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Local files")).toBeInTheDocument();
    expect(screen.getByText("Saved locally · No tools enabled by default")).toBeInTheDocument();
  });

  it("checks discovery without authorizing a tool call", async () => {
    runtime.list.mockResolvedValue([summary]);
    const status = vi.fn();
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={status} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    fireEvent.click(await screen.findByRole("button", { name: "Check server" }));
    await waitFor(() => expect(status).toHaveBeenCalledWith(
      "Local files responded with 1 tool and 1 resource. Nothing was enabled."
    ));
    const access = screen.getByLabelText("Local files access");
    fireEvent.click(within(access).getByLabelText("read"));
    fireEvent.click(within(access).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(runtime.setEnablement).toHaveBeenCalledWith(
      "workspace-a", "connection-mcp", 2, ["read"], [], []
    ));
  });

  it("explicitly binds one enabled tool to connected-source search", async () => {
    runtime.list.mockResolvedValue([summary]);
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={vi.fn()} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    fireEvent.click(await screen.findByRole("button", { name: "Check server" }));
    const access = await screen.findByLabelText("Local files access");
    fireEvent.change(within(access).getByRole("combobox", { name: /Connected-source search tool/ }), {
      target: { value: "read" }
    });
    fireEvent.click(within(access).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(runtime.setEnablement).toHaveBeenCalledWith(
      "workspace-a",
      "connection-mcp",
      2,
      ["read"],
      [],
      [{ capabilityId: "knowledge.content.search", toolName: "read" }]
    ));
  });

  it("states that browser preview cannot configure local programs", async () => {
    runtime.list.mockResolvedValue(null);
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={vi.fn()} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    expect(await screen.findByText("Tool servers are available only in the desktop app.")).toBeInTheDocument();
  });

  it("saves a remote HTTPS server without local command fields", async () => {
    runtime.list.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={vi.fn()} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    await screen.findByText("No tool servers saved.");
    fireEvent.click(screen.getByText("Add a server"));
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "streamable-http" }
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Remote tools" } });
    fireEvent.change(screen.getByLabelText("HTTPS address"), {
      target: { value: "https://tools.example.com/mcp" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByRole("dialog", { name: "Connect to Remote tools?" });
    expect(runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-a",
      displayName: "Remote tools",
      transport: "streamable-http",
      endpoint: "https://tools.example.com/mcp"
    }));
    expect(runtime.prepare.mock.calls.at(-1)?.[0]).not.toHaveProperty("command");
  });

  it("verifies secure sign-in metadata after a remote authorization challenge", async () => {
    const remote = { ...summary, id: "remote-tools", displayName: "Remote tools", transport: "streamable-http" as const };
    runtime.list.mockResolvedValue([remote]);
    transportFactory.mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error("Remote MCP rejected the request with HTTP 401.")),
      subscribe: () => () => undefined,
      subscribeClose: () => () => undefined,
      recordDiscovery: vi.fn(),
      close: vi.fn()
    });
    const status = vi.fn();
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={status} />);
    fireEvent.click(screen.getByText("Manage tool servers"));
    fireEvent.click(await screen.findByRole("button", { name: "Check server" }));
    await waitFor(() => expect(runtime.inspectAuth).toHaveBeenCalledWith("workspace-a", "remote-tools"));
    expect(status.mock.calls.at(-1)?.[0]).toContain("Connecting an account");
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(runtime.beginAuth).toHaveBeenCalledWith("workspace-a", "remote-tools"));
    expect(status).toHaveBeenCalledWith(
      "Remote tools account connected. Check the server before enabling any access."
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect account" }));
    await waitFor(() => expect(runtime.disconnectAuth).toHaveBeenCalledWith("workspace-a", "remote-tools"));
    expect(status).toHaveBeenCalledWith(
      "Remote tools account disconnected. Its saved tool access cannot run until you reconnect and check it again."
    );
  });
});
