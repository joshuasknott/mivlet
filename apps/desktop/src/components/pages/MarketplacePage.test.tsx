import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorManifest } from "@fable/protocol";
import { MarketplacePage } from "./MarketplacePage";

const github: ConnectorManifest = { id: "github", name: "GitHub", status: "needs-auth", permissions: ["Repositories"], healthSummary: "Not connected", lastCheckedAt: "Not checked", authMode: "oauth-broker", supportsSearch: false, supportsImport: false, supportedActions: [] };

describe("MarketplacePage", () => {
  it("keeps agent skills out of Connectors and connects through the detail page", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<MarketplacePage manifests={[github]} accounts={{}} connectorStatus={null}
      onUseConnector={vi.fn()} onConnect={onConnect} onDisconnect={vi.fn()} onRefresh={vi.fn()}
      onSelectConnector={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Skills" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("region", { name: "Popular" })).getByRole("button", { name: "Connect GitHub" }));
    expect(screen.getByRole("heading", { name: "Try asking" })).toBeVisible();
    expect(onConnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith(github);
  });
});
