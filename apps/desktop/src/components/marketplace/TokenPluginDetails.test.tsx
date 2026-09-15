import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorManifest } from "@mivlet/protocol";
import { tokenPluginFor } from "@mivlet/connectors/providers/token-plugins";
import { TokenPluginDetails } from "./TokenPluginDetails";
const connect = vi.hoisted(() => vi.fn());
vi.mock("../../runtime/domains/connectors", () => ({
connectRuntimeTokenPlugin: connect
}));
afterEach(cleanup);
beforeEach(() => { connect.mockReset(); });
const ready: ConnectorManifest = { id: "google-ads", name: "Google Ads", status: "connected", health: { state: "healthy", summary: "Verified", checkedAt: "now" }, healthSummary: "Verified", permissions: [], lastCheckedAt: "now" };
const props = () => ({ plugin: tokenPluginFor("google-ads")!, workspaceId: "workspace-local", titleId: "plugin-title", onUseConnector: vi.fn(), onDisconnect: vi.fn() });

describe("token plugin setup", () => {
  it("clears secret fields before awaiting native verification and exposes chat only after success", async () => {
    let finish!: (value: ConnectorManifest) => void;
    let submitted: unknown;
    connect.mockImplementation((_workspace, _id, credential) => { submitted = { ...credential }; return new Promise((resolve) => { finish = resolve; }); });
    const p = props(); const { container } = render(<TokenPluginDetails {...p} />);
    const token = screen.getByLabelText("Access token or API key");
    const developer = screen.getByLabelText("Developer token");
    fireEvent.change(token, { target: { value: "private-api-token" } });
    fireEvent.change(developer, { target: { value: "private-developer-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    expect(submitted).toMatchObject({ token: "private-api-token", developerToken: "private-developer-token" });
    expect(token).toHaveValue(""); expect(developer).toHaveValue("");
    expect(container).not.toHaveTextContent("private-api-token");
    expect(screen.queryByRole("button", { name: "Use in chat" })).toBeNull();
    finish(ready);
    await waitFor(() => expect(screen.getByRole("button", { name: "Use in chat" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Use in chat" }));
    expect(p.onUseConnector).toHaveBeenCalledWith(ready);
  });
  it("shows failed verification and never presents a connection as ready", async () => {
    connect.mockRejectedValue(new Error("The token lacks account access."));
    render(<TokenPluginDetails {...props()} />);
    fireEvent.change(screen.getByLabelText("Access token or API key"), { target: { value: "private-api-token" } });
    fireEvent.change(screen.getByLabelText("Developer token"), { target: { value: "private-developer-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("lacks account access"));
    expect(screen.queryByRole("button", { name: "Use in chat" })).toBeNull();
    expect(screen.getByLabelText("Access token or API key")).toHaveValue("");
  });
  it("honors a disconnected manifest while the detail view remains open", async () => {
    const p = props(); const { rerender } = render(<TokenPluginDetails {...p} connector={ready} />);
    expect(screen.getByRole("button", { name: "Use in chat" })).toBeEnabled();
    rerender(<TokenPluginDetails {...p} connector={{ ...ready, status: "revoked" }} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use in chat" })).toBeNull());
  });
});
