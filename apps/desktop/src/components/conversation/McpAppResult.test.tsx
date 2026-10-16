import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { customMcpConnectorId } from "../../lib/custom-mcp";
import { McpAppResult } from "./McpAppResult";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  frame: vi.fn(),
}));

vi.mock("../../lib/connector-mcp", () => ({
  openConnectorTools: mocks.open,
}));
vi.mock("../../lib/mcp-app-host", () => ({
  toMcpAppCallToolResult: (value: unknown) => value,
}));
vi.mock("./McpAppFrame", () => ({
  McpAppFrame: (props: { toolResult?: unknown }) => {
    mocks.frame(props);
    return null;
  },
}));

const descriptor = (connectorId: string) => ({
  connectorId,
  toolName: "render_result",
  resourceUri: "ui://example/result",
});

function connection() {
  return {
    transport: {},
    client: { close: vi.fn().mockResolvedValue(undefined) },
    tools: [{ name: "render_result", inputSchema: { type: "object" } }],
    resources: [],
    discovery: { enabledResources: [] },
  };
}

function renderResult(connectorId: string) {
  return render(
    <McpAppResult
      descriptor={descriptor(connectorId)}
      resultId="result-1"
      output={JSON.stringify({
        jsonrpc: "2.0",
        id: "tool-1",
        result: { content: [{ type: "text", text: "saved result" }] },
      })}
      workspaceId="workspace-1"
      conversationId="conversation-1"
      registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
    />,
  );
}

beforeEach(() => {
  mocks.open.mockReset();
  mocks.frame.mockReset();
  mocks.open.mockResolvedValue(connection());
});

it.each([
  [customMcpConnectorId("local.example")!, "local.example"],
  ["vercel", "marketplace-vercel"],
  ["marketplace-vercel", "marketplace-vercel"],
])("reopens saved MCP Apps through the canonical server reference (%s)", async (connectorId, serverId) => {
  renderResult(connectorId);
  fireEvent.click(screen.getByRole("button", { name: "Open interactive result" }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("workspace-1", serverId));
  expect(mocks.frame).toHaveBeenCalledWith(expect.objectContaining({
    toolResult: {
      jsonrpc: "2.0",
      id: "tool-1",
      result: { content: [{ type: "text", text: "saved result" }] },
    },
  }));
});

it("fails closed for an unknown persisted connector reference", async () => {
  renderResult("mcp-invalid");
  fireEvent.click(screen.getByRole("button", { name: "Open interactive result" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "saved MCP App connector reference is no longer valid",
  );
  expect(mocks.open).not.toHaveBeenCalled();
});
