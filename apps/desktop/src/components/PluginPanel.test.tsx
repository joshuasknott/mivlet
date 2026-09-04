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
import { PluginPanel } from "./PluginPanel";

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
  it("labels and selects the opaque Fable Connection instead of provider account authority", async () => {
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
        screen.getByRole("button", { name: "Close connector setup" }),
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
    expect(screen.getByRole("heading", { name: "Recommended" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Product & design" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Figma is planned" })[0],
    ).toBeVisible();

    await user.type(
      screen.getByRole("searchbox", { name: "Search connectors" }),
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

    await user.click(
      screen.getAllByRole("button", { name: "Figma is planned" })[0],
    );

    expect(screen.getByRole("dialog", { name: "Figma" })).toBeVisible();
    expect(screen.getByText("Planned")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Not available yet" }),
    ).toBeDisabled();
  });
});
