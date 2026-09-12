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
import type { ConnectorManifest } from "@fable/protocol";
import { PluginPanel, resolveDetailedStatus, connectorAccessSummary } from "./PluginPanel";

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
  it("filters ready connections separately from missing authorization and unhealthy connections", () => {
    const props = { manifests: [gmail, github], accounts: {}, onUseConnector: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onSelect: vi.fn(), onSwitchAccount: vi.fn() };
    const view = render(<PluginPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    expect(screen.getAllByRole("button", { name: "Manage Gmail" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.queryByRole("button", { name: "Manage Gmail" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect GitHub" }).length).toBeGreaterThan(0);
    view.rerender(<PluginPanel {...props} manifests={[{ ...gmail, health: { ...gmail.health!, state: "error", summary: "Connection expired." } }, github]} />);
    expect(screen.getAllByRole("button", { name: "Reconnect Gmail" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    expect(screen.queryByRole("button", { name: "Manage Gmail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect Gmail" })).toBeNull();
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
    expect(resolveDetailedStatus(unchecked).label).toBe("Not checked");
    expect(resolveDetailedStatus({ ...unchecked, sync: { connectorId: "gmail", workspaceId: "workspace-test", phase: "syncing", attempt: 1, itemsProcessed: 0, staleTokenRecovered: false } }).label).toBe("Syncing");
    const unhealthy = { ...gmail, health: { ...gmail.health!, state: "error" as const, summary: "Could not reach Gmail." } };
    expect(resolveDetailedStatus(unhealthy).className).toBe("failed");
    const user = userEvent.setup();
    render(<PluginPanel manifests={[unhealthy]} accounts={{}} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Manage Gmail from Installed" }));
    expect(screen.queryByRole("button", { name: "Use in chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
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

  it("keeps planned catalogue entries visibly unavailable", async () => {
    const user = userEvent.setup();
    render(
      <PluginPanel
        manifests={[github]}
        onUseConnector={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        accounts={{}}
        onSwitchAccount={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Outlook is planned" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Planned" }));
    await user.click(screen.getAllByRole("button", { name: "Outlook is planned" })[0]);

    expect(screen.getByRole("dialog", { name: "Outlook" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Outlook" })).toHaveTextContent("Planned");
    expect(
      screen.getByRole("button", { name: "Not available yet" }),
    ).toBeDisabled();
  });
});
