import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorManifest } from "@mivlet/protocol";
import { PluginPanel, resolveDetailedStatus, connectorAccessSummary } from "./PluginPanel";
import { mergeConnectorConnections } from "../lib/connector-connections";

afterEach(cleanup);

const gmail: ConnectorManifest = {
  id: "gmail",
  name: "Gmail",
  status: "connected",
  permissions: ["Read mail"],
  healthSummary: "Connected",
  lastCheckedAt: "2026-07-11T12:00:00.000Z",
  authMode: "oauth-pkce",
  scopes: [],
  health: {
    state: "healthy",
    summary: "Connected",
    checkedAt: "2026-07-11T12:00:00.000Z",
  },
  account: {
    id: "provider-account-active",
    displayName: "Work",
    email: "work@example.com",
  },
  supportsSearch: true,
  supportsImport: true,
  supportedActions: [],
};

const github: ConnectorManifest = {
  ...gmail,
  id: "github",
  name: "GitHub",
  status: "needs-auth",
  account: undefined,
  health: {
    state: "unknown",
    summary: "Not connected",
    checkedAt: "2026-07-11T12:00:00.000Z",
  },
};

describe("Connector Connection selection", () => {
  it.each([["notion", "Notion"], ["linear", "Linear"], ["vercel", "Vercel"]])("offers one official sign-in for a new %s account", async (id, name) => {
    render(<PluginPanel initialConnectorId={id} manifests={[{ ...github, id, name, status: "provider-error" }]} accounts={{}} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByRole("article", { name: `${name} connection` })).toBeVisible();
    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /endpoint|token|method/i })).not.toBeInTheDocument();
  });
  it("shows the working native account when a saved remote connection is revoked", () => {
    const manifests = mergeConnectorConnections([{ ...gmail, id: "notion", name: "Notion" }], [{ launchReference: "marketplace-notion", authorizationState: "revoked", discoveryState: "unknown", discoveredTools: [], enabledTools: [] }]);
    const onUse = vi.fn();
    render(<PluginPanel initialConnectorId="notion" manifests={manifests} accounts={{}} onUseConnector={onUse} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByText("Active connection: work@example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use in chat" }));
    expect(onUse).toHaveBeenCalledWith(manifests[0]);
  });
  it("reconnects an existing native account without changing its method", async () => {
    const connector = { ...gmail, id: "linear", name: "Linear", status: "needs-auth" as const, health: undefined, healthSummary: "Sign in again." };
    const onConnect = vi.fn();
    render(<PluginPanel initialConnectorId="linear" manifests={[connector]} accounts={{}} onUseConnector={vi.fn()} onConnect={onConnect} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledExactlyOnceWith(connector));
  });
  it("opens custom tool servers from Plugins", async () => {
    render(<PluginPanel workspaceId="workspace-test" manifests={[]} accounts={{}} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.queryByText("Tool servers are available only in the desktop app.")).toBeNull();
    expect(screen.queryByText("Custom tool servers")).toBeNull();
    const add = screen.getByRole("button", { name: "Add custom plugin" });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole("dialog", { name: "Add custom plugin" })).toBeVisible();
    expect(await screen.findByText("Tool servers are available only in the desktop app.")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add custom plugin" })).toBeNull();
    expect(add).toHaveFocus();
  });
  it("shows connections together without status filters and keeps recovery actions", () => {
    const props = { manifests: [gmail, github], accounts: {}, onUseConnector: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onSelect: vi.fn(), onSwitchAccount: vi.fn() };
    const view = render(<PluginPanel {...props} />);
    expect(screen.queryByRole("group", { name: "Filter plugins by readiness" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Manage Gmail" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Connect GitHub" }).length).toBeGreaterThan(0);
    view.rerender(<PluginPanel {...props} manifests={[{ ...gmail, health: { ...gmail.health!, state: "error", summary: "Connection expired." } }, github]} />);
    expect(screen.getAllByRole("button", { name: "Reconnect Gmail" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Manage Gmail" })).toBeNull();
  });
  it("prepares a connected plugin example without starting a connection or action", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    const onConnect = vi.fn();
    render(<PluginPanel manifests={[gmail]} accounts={{}} onUseConnector={onUse} onConnect={onConnect} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage Gmail from Installed" }));
    await user.click(screen.getByRole("button", { name: "Find unread messages from this week." }));
    expect(onUse).toHaveBeenCalledWith(gmail, "Find unread messages from this week.");
    expect(onConnect).not.toHaveBeenCalled();
  });
  it("describes granted Drive access without promising ungranted writes", () => {
    const scope = (name: string, granted: boolean) => ({ id: `https://www.googleapis.com/auth/${name}`, label: name, access: "read" as const, required: false, granted });
    expect(connectorAccessSummary({ ...gmail, id: "google-drive", scopes: [scope("drive.readonly", true), scope("drive.file", false), scope("drive", false)] })).toBe("Read your Drive files.");
    expect(connectorAccessSummary({ ...gmail, id: "google-drive", scopes: [scope("drive.readonly", true), scope("drive.file", true)] })).toContain("Updates are limited to files shared with Mivlet");
  });
  it("reports syncing only for an active sync and keeps unhealthy connections actionable", async () => {
    const unchecked = { ...gmail, health: { ...gmail.health!, state: "unknown" as const } };
    expect(resolveDetailedStatus(unchecked).label).toBe("Needs attention");
    expect(resolveDetailedStatus(unchecked).className).toBe("unverified");
    expect(resolveDetailedStatus({ ...unchecked, sync: { connectorId: "gmail", workspaceId: "workspace-test", phase: "syncing", attempt: 1, itemsProcessed: 0, staleTokenRecovered: false } }).label).toBe("Connected");
    const unhealthy = { ...gmail, health: { ...gmail.health!, state: "error" as const, summary: "Could not reach Gmail." } };
    expect(resolveDetailedStatus(unhealthy).className).toBe("failed");
    const user = userEvent.setup();
    render(<PluginPanel manifests={[unhealthy]} accounts={{}} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage Gmail from Installed" }));
    expect(screen.queryByRole("button", { name: "Use in chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  });
  it("uses the shared readiness vocabulary for every detail state", () => {
    expect(resolveDetailedStatus(gmail).label).toBe("Connected");
    expect(resolveDetailedStatus(github).label).toBe("Needs attention");
    for (const status of ["expired", "revoked", "unavailable", "configured", "unconfigured", "needs-auth"] as const) {
      const label = resolveDetailedStatus({ ...github, status }).label;
      expect(["Available", "Needs attention"]).toContain(label);
    }
    expect(resolveDetailedStatus({ ...github, status: "configured" }).label).toBe("Available");
  });
  it("labels and selects the opaque Mivlet Connection instead of provider account authority", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    const rendered = render(
      <PluginPanel
        manifests={[gmail]}
        onUseConnector={() => {}}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onRefresh={() => {}}
        onSelect={() => {}}
        accounts={{
          gmail: [
            {
              connectionId: "connection_active",
              account: gmail.account!,
              active: true,
              lifecycle: "authorized",
              authorizationState: "authorized",
              healthState: "healthy",
              credentialCustody: "os-secure-store",
              credentialState: "available",
            },
            {
              connectionId: "connection_other",
              account: {
                id: "provider-account-other",
                displayName: "Personal",
                email: "personal@example.com",
              },
              active: false,
              lifecycle: "authorized",
              authorizationState: "authorized",
              healthState: "unknown",
              credentialCustody: "os-secure-store",
              credentialState: "available",
            },
          ],
        }}
        onSwitchAccount={onSwitch}
      />,
    );

    const opener = screen.getAllByRole("button", { name: "Manage Gmail" })[0];
    await user.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close plugin setup" }),
      ).toHaveFocus(),
    );
    const select = screen.getByLabelText("Active connection");
    expect(select).toHaveValue("connection_active");
    fireEvent.change(select, { target: { value: "connection_other" } });
    expect(onSwitch).toHaveBeenCalledWith("gmail", "connection_other");
    expect(rendered.container).not.toHaveTextContent("provider-account-active");
    expect(rendered.container).not.toHaveTextContent("provider-account-other");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("separates installed connections and searches the remaining catalogue", async () => {
    const user = userEvent.setup();
    render(
      <PluginPanel
        manifests={[gmail, github]}
        onUseConnector={() => {}}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onRefresh={() => {}}
        onSelect={() => {}}
        accounts={{}}
        onSwitchAccount={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Installed" })).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Manage Gmail" })[0],
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Connect GitHub" })[0],
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Featured" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Product & design" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Connect Figma" })[0],
    ).toBeVisible();

    await user.type(
      screen.getByRole("searchbox", { name: "Search plugins" }),
      "github",
    );
    expect(
      screen.queryByRole("button", { name: "Manage Gmail" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Connect GitHub" })[0],
    ).toBeVisible();
  });

  it("excludes removed integrations from the directory", () => {
    render(<PluginPanel manifests={[github]} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} accounts={{}} onSwitchAccount={vi.fn()} />);
    for (const name of ["Outlook", "Microsoft Teams", "Zoom", "LinkedIn", "Instagram", "YouTube", "Google Ads", "Meta Ads", "Shopify", "DocuSign", "Greenhouse", "Lever", "Workday"]) {
      expect(screen.queryByRole("button", { name: `Connect ${name}` })).not.toBeInTheDocument();
    }
  });
});
