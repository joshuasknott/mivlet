import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPanel } from "../PluginPanel";

const api = vi.hoisted(() => ({ load: vi.fn(), set: vi.fn() }));
vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  loadRuntimeBuiltinPlugins: api.load,
  setRuntimeBuiltinPlugin: api.set,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.load.mockResolvedValue({ computer: false });
});

function panel(onUseBuiltinPlugin?: (id: "computer") => void) {
  return render(
    <PluginPanel
      workspaceId="workspace-local"
      manifests={[]}
      accounts={{}}
      onUseConnector={vi.fn()}
      onUseBuiltinPlugin={onUseBuiltinPlugin}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onRefresh={vi.fn()}
      onSelect={vi.fn()}
      onSwitchAccount={vi.fn()}
    />,
  );
}

describe("built-in plugin settings", () => {
  it("withdraws stale enablement when a native refresh fails", async () => {
    api.load.mockResolvedValueOnce({ computer: true });
    panel(vi.fn());
    await screen.findByRole("button", { name: "Manage Computer Use" });
    api.load.mockRejectedValueOnce(new Error("Settings unavailable"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up Computer Use" })).toHaveTextContent("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Set up Computer Use" }));
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Use in chat" })).toBeNull();
  });

  it("renders Computer Use as an ordinary card and enables it through the ordinary modal", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    api.set.mockResolvedValue({ computer: true });
    panel(onUse);

    expect(screen.getByRole("heading", { name: "Built-in" })).toBeVisible();
    const card = screen.getByRole("button", { name: "Set up Computer Use" });
    await waitFor(() => expect(card).toHaveTextContent("Disabled"));

    await user.click(card);
    const dialog = screen.getByRole("dialog", { name: "Computer Use" });
    expect(dialog).toHaveTextContent("Disabled");
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(api.set).toHaveBeenCalledWith("workspace-local", "computer", true);
    await waitFor(() => expect(dialog).toHaveTextContent("Enabled"));
    await user.click(screen.getByRole("button", { name: "Use in chat" }));
    expect(onUse).toHaveBeenCalledWith("computer");
  });

  it("disables Computer Use and reports that active control stopped", async () => {
    const user = userEvent.setup();
    api.load.mockResolvedValue({ computer: true });
    api.set.mockResolvedValue({ computer: false });
    panel();

    await user.click(await screen.findByRole("button", { name: "Manage Computer Use" }));
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expect(api.set).toHaveBeenCalledWith("workspace-local", "computer", false);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("stopped immediately"));
    expect(screen.getByRole("button", { name: "Set up Computer Use" })).toHaveTextContent("Disabled");
  });

  it("fails closed in the browser preview and re-reads native enablement after an update failure", async () => {
    const user = userEvent.setup();
    const preview = render(
      <PluginPanel
        manifests={[]}
        accounts={{}}
        onUseConnector={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onSwitchAccount={vi.fn()}
      />,
    );
    expect(api.load).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Set up Computer Use" }));
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.getByText(/Open the desktop app to manage Computer Use/)).toBeInTheDocument();
    preview.unmount();

    api.set.mockRejectedValue(new Error("Storage unavailable"));
    panel();
    const enable = await screen.findByRole("button", { name: "Set up Computer Use" });
    await waitFor(() => expect(enable).toHaveTextContent("Disabled"));
    await user.click(enable);
    await user.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Storage unavailable"));
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Set up Computer Use" })).toHaveTextContent("Disabled");
  });
});
