import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuiltinPlugins } from "./BuiltinPlugins";
import { loadRuntimeBuiltinPlugins, setRuntimeBuiltinPlugin } from "../../runtime";

vi.mock("../../runtime", () => ({ loadRuntimeBuiltinPlugins: vi.fn(), setRuntimeBuiltinPlugin: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ computer: false }); });

describe("built-in Plugin settings", () => {
  it("offers Use only after native enablement and passes the selected plugin", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ computer: true });
    const onUse = vi.fn();
    render(<BuiltinPlugins workspaceId="workspace-local" query="" onUse={onUse} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use Computer Use" }));
    expect(onUse).toHaveBeenCalledWith("computer");
    expect(screen.queryByRole("button", { name: "Use Browser" })).toBeNull();
  });
  it("waits for native enablement and never claims readiness from enablement", async () => {
    let resolve!: (value: { computer: boolean }) => void;
    vi.mocked(setRuntimeBuiltinPlugin).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<BuiltinPlugins workspaceId="workspace-local" query="" />);
    const enable = await screen.findByRole("button", { name: "Enable Computer Use" });
    await waitFor(() => expect(enable).toBeEnabled());
    fireEvent.click(enable);
    expect(setRuntimeBuiltinPlugin).toHaveBeenCalledWith("workspace-local", "computer", true);
    expect(screen.queryByRole("button", { name: "Disable Computer Use" })).toBeNull();
    await act(async () => resolve({ computer: true }));
    expect(screen.getByRole("button", { name: "Disable Computer Use" })).toBeEnabled();
    expect(screen.getByText("Enabled · app control requires permission")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Browser" })).toBeNull();
  });
  it("fails closed in browser preview and re-reads authority after an update failure", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValueOnce(null);
    const view = render(<BuiltinPlugins workspaceId="workspace-local" query="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable Computer Use" })).toBeDisabled());
    view.rerender(<BuiltinPlugins workspaceId="next-workspace" query="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable Computer Use" })).toBeEnabled());
    vi.mocked(setRuntimeBuiltinPlugin).mockRejectedValue(new Error("Storage unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Enable Computer Use" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Storage unavailable"));
    expect(screen.queryByRole("button", { name: "Disable Computer Use" })).toBeNull();
  });
});
