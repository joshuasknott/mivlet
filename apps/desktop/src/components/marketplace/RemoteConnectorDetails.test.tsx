import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteConnectorDetails } from "./RemoteConnectorDetails";
import { remoteConnectorFor, remoteConnectors } from "./remote-connectors";
import { findMarketplaceConnector } from "./marketplace-catalog";

const api = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), commit: vi.fn(), resolve: vi.fn(), auth: vi.fn(), disconnect: vi.fn(), enable: vi.fn(), open: vi.fn() }));
vi.mock("../../runtime/domains/mcp", () => ({
listRuntimeMcpServerConfigurations: api.list,
prepareRuntimeMcpServerConfiguration: api.prepare,
commitRuntimeMcpServerConfiguration: api.commit,
beginRuntimeRemoteMcpAuthorization: api.auth,
disconnectRuntimeRemoteMcpAuthorization: api.disconnect,
setRuntimeMcpEnablement: api.enable
}));
vi.mock("../../runtime/domains/approvals", () => ({
resolveRuntimeApprovalRequest: api.resolve
}));
vi.mock("../../lib/connector-mcp", () => ({ openConnectorTools: api.open }));
const approval = { id: "approval-1", confirmationPhrase: "approve", consequence: "Connect to this provider." };
const discovery = { connectionId: "connection-1", connectionRevision: 2, authorizationState: "authorized", credentialState: "available", healthState: "healthy", discoveryState: "discovered", discoveredTools: ["search", "update"], enabledTools: [], enabledResources: [], capabilityBindings: [] };
const fixture = () => ({
  tools: [{ name: "search", inputSchema: { type: "object" } }, { name: "update", inputSchema: { type: "object" } }], discovery,
  client: { close: vi.fn().mockResolvedValue(undefined) },
});
function show() {
  return render(<RemoteConnectorDetails entry={findMarketplaceConnector("notion")!} preset={remoteConnectors[0]} workspaceId="workspace-1" titleId="notion-title" />);
}
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([]);
  api.prepare.mockResolvedValue({ approval }); api.commit.mockResolvedValue({ id: "marketplace-notion" });
  api.resolve.mockResolvedValue({}); api.auth.mockResolvedValue({}); api.disconnect.mockResolvedValue({});
  api.open.mockResolvedValue(fixture()); api.enable.mockResolvedValue({ ...discovery, enabledTools: ["search", "update"] });
});
const connect = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
};
describe("official connector setup", () => {
  it("preserves the cause when a saved connection cannot restore access", async () => {
    api.list.mockResolvedValue([{ id: "marketplace-notion" }]);
    api.open.mockRejectedValue(new Error("Authorization expired. Sign in again."));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Authorization expired. Sign in again.");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(api.auth).not.toHaveBeenCalled();
  });
  it("connects with one click and enables discovered tools after sign-in", async () => {
    show(); await connect(); await screen.findByText("Connected");
    expect(api.commit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", endpoint: "https://mcp.notion.com/mcp" }), expect.objectContaining({ decision: "once", confirmationText: "approve" }));
    expect(api.auth).toHaveBeenCalledWith("workspace-1", "marketplace-notion");
    expect(api.enable).toHaveBeenCalledWith("workspace-1", "connection-1", 2, ["search", "update"], [], []);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
  it("selects the exact official endpoint for each verified marketplace route", async () => {
    const cases = [
      { id: "atlassian-rovo", name: "Atlassian Rovo", endpoint: "https://mcp.atlassian.com/v2/mcp" },
    ];
    for (const expected of cases) {
      const view = render(<RemoteConnectorDetails entry={findMarketplaceConnector(expected.id)!} preset={remoteConnectorFor(expected.id)!} workspaceId="workspace-1" titleId={`${expected.id}-title`} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await screen.findByText("Connected");
      expect(api.commit).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "workspace-1", id: `marketplace-${expected.id}`, displayName: expected.name, endpoint: expected.endpoint }), expect.anything());
      view.unmount();
    }
  });
  it("keeps an official route unavailable until the desktop runtime lists servers", async () => {
    api.list.mockResolvedValue(null);
    const view = render(<RemoteConnectorDetails entry={findMarketplaceConnector("atlassian-rovo")!} preset={remoteConnectorFor("atlassian-rovo")!} workspaceId="workspace-1" titleId="rovo-title" />);
    await screen.findByText("Account connections require the desktop app.");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    view.unmount();
  });
  it("restores existing access without sign-in or expanding permissions", async () => {
    api.list.mockResolvedValue([{ id: "marketplace-notion" }]);
    api.open.mockResolvedValue({ ...fixture(), discovery: { ...discovery, enabledTools: ["search"] } });
    show(); await screen.findByText("Connected");
    expect(api.auth).not.toHaveBeenCalled(); expect(api.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Disconnected.");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
  it("does not claim ready when enabling tools fails and closes the session", async () => {
    const connection = fixture(); api.open.mockResolvedValue(connection); api.enable.mockRejectedValue(new Error("Could not save access"));
    show(); await connect(); await screen.findByText("Could not save access");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(connection.client.close).toHaveBeenCalled();
  });
  it("does not discover tools after cancelled authorization", async () => {
    api.auth.mockRejectedValue(new Error("Sign-in cancelled"));
    show(); await connect(); await screen.findByText("Sign-in cancelled");
    expect(api.open).not.toHaveBeenCalled(); expect(api.enable).not.toHaveBeenCalled();
  });
  it("fails closed in preview and finishes authorized setup after closing the dialog", async () => {
    api.list.mockResolvedValue(null); const view = show();
    await screen.findByText("Account connections require the desktop app.");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled(); view.unmount();
    api.list.mockResolvedValue([]);
    let finish: (value: object) => void = () => {};
    api.auth.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const signedIn = show(); await connect(); await waitFor(() => expect(api.auth).toHaveBeenCalled()); signedIn.unmount();
    await act(async () => { finish({}); });
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.enable).toHaveBeenCalledTimes(1);
  });
});
