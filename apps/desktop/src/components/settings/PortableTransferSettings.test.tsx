import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { PortableTransferSettings } from "./PortableTransferSettings";

const api = vi.hoisted(() => ({ export: vi.fn(), import: vi.fn() }));
vi.mock("../../runtime/domains/portable-transfer", () => ({
  exportPortableTransfer: api.export,
  importPortableTransfer: api.import,
}));

beforeEach(() => { vi.resetAllMocks(); setActiveRuntimeDataScope("default", "account-a"); });
afterEach(() => { clearActiveRuntimeDataScope(); });

describe("native portable transfer controls", () => {
  it("requires an explicit click, sends no passphrase, and prevents duplicate dialogs", async () => {
    let finish!: (value: { fileName: string }) => void;
    api.export.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<PortableTransferSettings mode="export" />);
    expect(api.export).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Export portable history" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.export).toHaveBeenCalledExactlyOnceWith();
    expect(button).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => { finish({ fileName: "history.json" }); });
    expect(screen.getByRole("status")).toHaveTextContent("Saved history.json");
  });

  it("does not display another account's late transfer receipt", async () => {
    let finish!: (value: { fileName: string }) => void;
    api.export.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = render(<PortableTransferSettings mode="export" />);
    fireEvent.click(screen.getByRole("button", { name: "Export portable history" }));
    setActiveRuntimeDataScope("default", "account-b");
    await act(async () => { finish({ fileName: "private-history.json" }); });
    expect(screen.queryByText(/private-history/)).not.toBeInTheDocument();
    view.unmount();
  });

  it("surfaces a native refusal without reporting a successful import", async () => {
    api.import.mockRejectedValue(new Error("The destination is not empty."));
    render(<PortableTransferSettings mode="import" />);
    fireEvent.click(screen.getByRole("button", { name: "Import portable history" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("destination is not empty"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
