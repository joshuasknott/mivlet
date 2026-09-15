import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorManifest } from "@mivlet/protocol";
import { MarketplacePage } from "./MarketplacePage";

const github: ConnectorManifest = { id: "github", name: "GitHub", status: "needs-auth", permissions: ["Repositories"], healthSummary: "Not connected", lastCheckedAt: "Not checked", authMode: "oauth-broker", supportsSearch: false, supportsImport: false, supportedActions: [] };

describe("MarketplacePage", () => {
  it("returns to the active chat independently of connector setup", async () => {
    const onBack = vi.fn();
    render(<MarketplacePage manifests={[github]} accounts={{}} connectorStatus={null}
      onBack={onBack} onUseConnector={vi.fn()} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()}
      onSelectConnector={vi.fn()} onSwitchAccount={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Back to chat/ }));
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("keeps agent skills out of Plugins and connects through the detail page", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<MarketplacePage manifests={[github]} accounts={{}} connectorStatus={null}
      onUseConnector={vi.fn()} onConnect={onConnect} onDisconnect={vi.fn()} onRefresh={vi.fn()}
      onSelectConnector={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Skills" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("region", { name: "Featured" })).getByRole("button", { name: "Connect GitHub" }));
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeVisible();
    expect(onConnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith(github);
  });
});
