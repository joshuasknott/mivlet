import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerSettings } from "./McpServerSettings";
import {
  decideMcpClient,
  getMcpServerStatus,
  revokeMcpClient,
  startMcpServer,
  stopMcpServer,
} from "../../runtime/domains/mcp-server";
vi.mock("../../runtime/domains/mcp-server", () => ({
  getMcpServerStatus: vi.fn(),
  decideMcpClient: vi.fn(),
  revokeMcpClient: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
}));
const pending = {
  id: "verify-code",
  clientName: "Outside assistant",
  redirectUri: "https://assistant.example/callback",
  requestedAccess: "request-tasks" as const,
  expiresAt: 9999999999,
};
const base = {
  endpoint: "http://127.0.0.1:39440/mcp",
  pending: [pending],
  grants: [],
  history: [],
  shareableWork: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMcpServerStatus).mockResolvedValue(base);
});
afterEach(() => vi.useRealTimers());
describe("external assistant consent", () => {
  it("requires explicit agents and keeps task access opt-in", async () => {
    render(
      <McpServerSettings
        workspaceId="default"
        agents={[{ id: "a", name: "Aster" }]}
      />,
    );
    expect(await screen.findByText("verify-code")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve access" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Access")).toHaveValue("read-only");
    fireEvent.click(screen.getByRole("checkbox", { name: "Aster" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve access" }));
    await waitFor(() =>
      expect(decideMcpClient).toHaveBeenCalledWith({
        requestId: "verify-code",
        workspaceId: "default",
        approve: true,
        agentIds: ["a"],
        workIds: [],
        access: "read-only",
        lifetimeHours: 8,
      }),
    );
  });
  it("denies without any target selection", async () => {
    render(<McpServerSettings workspaceId="default" agents={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(decideMcpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          approve: false,
          agentIds: [],
          access: "read-only",
        }),
      ),
    );
  });
  it("starts only on a deliberate action and exposes native failures", async () => {
    vi.mocked(getMcpServerStatus).mockResolvedValue({
      ...base,
      endpoint: undefined,
      pending: [],
    });
    vi.mocked(startMcpServer).mockRejectedValue(
      new Error("This port is unavailable."),
    );
    render(<McpServerSettings workspaceId="default" agents={[]} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start MCP server" }),
      ).toBeEnabled(),
    );
    expect(startMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start MCP server" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This port is unavailable.",
    );
  });
  it("locks overlapping actions and consent while Stop is pending", async () => {
    let finishStop!: () => void;
    vi.mocked(stopMcpServer).mockReturnValue(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    render(
      <McpServerSettings
        workspaceId="default"
        agents={[{ id: "a", name: "Aster" }]}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Stop server" }));
    expect(screen.getByRole("status")).toHaveTextContent("Processing request");
    expect(screen.getByRole("button", { name: "Copy URL" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Aster" })).toBeDisabled();
    expect(screen.getByLabelText("Access")).toBeDisabled();
    fireEvent.submit(
      screen.getByRole("button", { name: "Approve access" }).closest("form")!,
    );
    expect(decideMcpClient).not.toHaveBeenCalled();
    vi.mocked(getMcpServerStatus).mockResolvedValue({
      ...base,
      endpoint: undefined,
      pending: [],
    });
    await act(async () => finishStop());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Server stopped. Active tasks requested by clients were stopped.",
    );
    expect(
      screen.queryByRole("button", { name: "Stop server" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start MCP server" }),
    ).toBeEnabled();
  });
  it("pauses stale consent and clears status errors after polling recovers", async () => {
    vi.useFakeTimers();
    vi.mocked(getMcpServerStatus)
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(new Error("Status refresh failed."))
      .mockResolvedValue(base);
    render(
      <McpServerSettings
        workspaceId="default"
        agents={[{ id: "a", name: "Aster" }]}
      />,
    );
    await act(async () => {});
    expect(screen.getByText("Running", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Aster" }));
    expect(
      screen.getByRole("button", { name: "Approve access" }),
    ).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Status refresh failed.",
    );
    expect(
      screen.getByText("Unavailable", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve access" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop server" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Running", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Aster" })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Approve access" }),
    ).toBeEnabled();
  });
  it("revokes the exact grant and shows expiry and bounded audit history", async () => {
    vi.mocked(getMcpServerStatus).mockResolvedValue({
      ...base,
      pending: [],
      grants: [
        {
          id: "grant-one",
          clientId: "client",
          clientName: "Reader",
          redirectUri: "https://example.com",
          resource: base.endpoint,
          workspaceId: "default",
          agentIds: ["a"],
          workIds: [],
          access: "read-only",
          permissionMode: "trusted-scope",
          createdAt: 1,
          expiresAt: 1,
          revoked: false,
        },
      ],
      history: [
        {
          at: 1,
          clientId: "client",
          operation: "consent",
          outcome: "approved",
        },
      ],
    });
    render(
      <McpServerSettings
        workspaceId="default"
        agents={[{ id: "a", name: "Aster" }]}
      />,
    );
    expect(await screen.findByText(/^Expired /)).toBeInTheDocument();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Reader" }),
    );
    await waitFor(() =>
      expect(revokeMcpClient).toHaveBeenCalledWith("grant-one"),
    );
    expect(screen.getByText("Access history (1)")).toBeInTheDocument();
  });
});
