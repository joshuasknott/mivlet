import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuiltinPlugins } from "./BuiltinPlugins";
import { loadRuntimeBuiltinPlugins, setRuntimeBuiltinPlugin } from "../../runtime";

vi.mock("../../runtime", () => ({ loadRuntimeBuiltinPlugins: vi.fn(), setRuntimeBuiltinPlugin: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ browser: false, computer: false }); });

describe("built-in Plugin settings", () => {
  it("offers Use only after native enablement and passes the selected plugin", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValue({ browser: true, computer: false });
    const onUse = vi.fn();
    render(<BuiltinPlugins workspaceId="workspace-local" query="" onUse={onUse} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use Browser" }));
    expect(onUse).toHaveBeenCalledWith("browser");
    expect(screen.queryByRole("button", { name: "Use Computer Use" })).toBeNull();
  });
  it("waits for native enablement and never claims readiness from enablement", async () => {
    let resolve!: (value: { browser: boolean; computer: boolean }) => void;
    vi.mocked(setRuntimeBuiltinPlugin).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<BuiltinPlugins workspaceId="workspace-local" query="" />);
    const enable = await screen.findByRole("button", { name: "Enable Browser" });
    await waitFor(() => expect(enable).toBeEnabled());
    fireEvent.click(enable);
    expect(setRuntimeBuiltinPlugin).toHaveBeenCalledWith("workspace-local", "browser", true);
    expect(screen.queryByRole("button", { name: "Disable Browser" })).toBeNull();
    await act(async () => resolve({ browser: true, computer: false }));
    expect(screen.getByRole("button", { name: "Disable Browser" })).toBeEnabled();
    expect(screen.getByText("Enabled · requires a running agent computer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable Computer Use" })).toBeEnabled();
  });
  it("fails closed in browser preview and re-reads authority after an update failure", async () => {
    vi.mocked(loadRuntimeBuiltinPlugins).mockResolvedValueOnce(null);
    const view = render(<BuiltinPlugins workspaceId="workspace-local" query="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable Browser" })).toBeDisabled());
    view.rerender(<BuiltinPlugins workspaceId="next-workspace" query="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable Browser" })).toBeEnabled());
    vi.mocked(setRuntimeBuiltinPlugin).mockRejectedValue(new Error("Storage unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Enable Browser" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Storage unavailable"));
    expect(screen.queryByRole("button", { name: "Disable Browser" })).toBeNull();
  });
});
