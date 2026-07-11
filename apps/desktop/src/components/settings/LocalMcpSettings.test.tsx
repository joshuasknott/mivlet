import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpFrame, McpNotification, McpRequest, McpTransport } from "@fable/connectors";

const runtime = vi.hoisted(() => ({
  commit: vi.fn(),
  list: vi.fn(),
  prepare: vi.fn(),
  resolve: vi.fn()
}));
const transportFactory = vi.hoisted(() => vi.fn());

vi.mock("../../runtime", () => ({
  commitRuntimeMcpServerConfiguration: runtime.commit,
  listRuntimeMcpServerConfigurations: runtime.list,
  prepareRuntimeMcpServerConfiguration: runtime.prepare,
  resolveRuntimeApprovalRequest: runtime.resolve
}));
vi.mock("../../lib/mcp-transport", () => ({
  createDesktopMcpTransport: transportFactory
}));

import { LocalMcpSettings } from "./LocalMcpSettings";

const summary = {
  id: "local-files",
  workspaceId: "workspace-a",
  displayName: "Local files",
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
  async close(): Promise<void> {}
}

beforeEach(() => {
  runtime.commit.mockReset().mockResolvedValue(summary);
  runtime.list.mockReset().mockResolvedValue([]);
  runtime.prepare.mockReset().mockResolvedValue({ configurationFingerprint: "abc", approval });
  runtime.resolve.mockReset().mockResolvedValue({ persisted: true });
  transportFactory.mockReset().mockResolvedValue(new FixtureTransport());
});

describe("LocalMcpSettings", () => {
  it("requires exact confirmation before saving an approved local server", async () => {
    runtime.list.mockResolvedValueOnce([]).mockResolvedValueOnce([summary]);
    const status = vi.fn();
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={status} />);
    fireEvent.click(screen.getByText("Manage local tool servers"));
    await screen.findByText("No local tool servers saved.");

    fireEvent.click(screen.getByText("Add a server"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local files" } });
    fireEvent.change(screen.getByLabelText("Program path"), { target: { value: "C:\\tools\\mcp.exe" } });
    fireEvent.change(screen.getByLabelText(/Arguments/), { target: { value: "--stdio\nC:\\work" } });
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));

    const dialog = await screen.findByRole("dialog", { name: "Allow Local files to run?" });
    const save = within(dialog).getByRole("button", { name: "Save server" });
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
    expect(screen.getByText("Saved locally · No tools enabled")).toBeInTheDocument();
  });

  it("checks discovery without authorizing a tool call", async () => {
    runtime.list.mockResolvedValue([summary]);
    const status = vi.fn();
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={status} />);
    fireEvent.click(screen.getByText("Manage local tool servers"));
    fireEvent.click(await screen.findByRole("button", { name: "Check server" }));
    await waitFor(() => expect(status).toHaveBeenCalledWith(
      "Local files responded with 1 tool and 1 resource. Nothing was enabled."
    ));
  });

  it("states that browser preview cannot configure local programs", async () => {
    runtime.list.mockResolvedValue(null);
    render(<LocalMcpSettings workspaceId="workspace-a" onStatus={vi.fn()} />);
    fireEvent.click(screen.getByText("Manage local tool servers"));
    expect(await screen.findByText("Local tool servers are available only in the desktop app.")).toBeInTheDocument();
  });
});
