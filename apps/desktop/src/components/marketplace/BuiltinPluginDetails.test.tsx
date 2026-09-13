import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPanel } from "../PluginPanel";
import { loadRuntimeBuiltinPlugins, setRuntimeBuiltinPlugin } from "../../runtime";

vi.mock("../../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime")>()),
  loadRuntimeBuiltinPlugins: vi.fn(),
  setRuntimeBuiltinPlugin: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ computer: false });
});

function renderPanel(overrides: Partial<Parameters<typeof PluginPanel>[0]> = {}) {
  return render(
    <PluginPanel
      workspaceId="workspace-local"
      manifests={[]}
      accounts={{}}
      onUseConnector={vi.fn()}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onRefresh={vi.fn()}
      onSelect={vi.fn()}
      onSwitchAccount={vi.fn()}
      {...overrides}
    />,
  );
}

describe("built-in Computer Use plugin", () => {
  it("uses the ordinary card and modal, enables through native settings, and then offers Use in chat", async () => {
    const onUse = vi.fn();
    vi.mocked(setRuntimeBuiltinPlugin).mockResolvedValue({ computer: true });
    renderPanel({ onUseBuiltinPlugin: onUse });

    const card = await screen.findByRole("button", { name: "Set up Computer Use" });
    expect(screen.queryByRole("button", { name: "Enable Computer Use" })).toBeNull();
    fireEvent.click(card);

    const dialog = await screen.findByRole("dialog", { name: "Computer Use" });
    expect(dialog).toHaveTextContent("Disabled");
    expect(within(dialog).getByRole("button", { name: "Enable" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "Use in chat" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Enable" }));
    expect(setRuntimeBuiltinPlugin).toHaveBeenCalledWith("workspace-local", "computer", true);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Computer Use" })).toHaveTextContent("Enabled"));

    fireEvent.click(within(dialog).getByRole("button", { name: "Use in chat" }));
    expect(onUse).toHaveBeenCalledWith("computer");
    expect(screen.getByRole("button", { name: "Manage Computer Use" })).toBeInTheDocument();
  });

  it("disables through native settings, reports relinquished control, and re-reads authority after a failure", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ computer: true });
    vi.mocked(setRuntimeBuiltinPlugin).mockRejectedValueOnce(new Error("Storage unavailable"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Manage Computer Use" }));
    const dialog = await screen.findByRole("dialog", { name: "Computer Use" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(screen.getByText("Storage unavailable")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Computer Use" })).toHaveTextContent("Enabled"));
    expect(setRuntimeBuiltinPlugin).toHaveBeenCalledWith("workspace-local", "computer", false);

    vi.mocked(setRuntimeBuiltinPlugin).mockResolvedValue({ computer: false });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(screen.getByText(/Any active application control stopped immediately/)).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Computer Use" })).toHaveTextContent("Disabled");
  });

  it("fails closed when native plugin settings are unavailable", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue(null);
    renderPanel();

    const card = await screen.findByRole("button", { name: "Set up Computer Use" });
    expect(within(card).getByText("Unavailable")).toBeInTheDocument();
    fireEvent.click(card);

    const dialog = await screen.findByRole("dialog", { name: "Computer Use" });
    expect(within(dialog).getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Use in chat" })).toBeNull();
  });
});
