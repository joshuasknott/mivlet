import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRecords } from "./MemoryRecords";
import type { SettingsRuntime } from "./settings-runtime";

function runtime() {
  return { managedMemoryRecords: [{ id: "one", kind: "fact", title: "Writing", value: "Short replies", source: "You", freshness: "Today", approved: true, pinned: true, updatedAt: "revision-one" }], correctMemory: vi.fn().mockResolvedValue(undefined), forgetMemory: vi.fn(), toggleMemoryRecordDisabled: vi.fn(), memoryStatus: "Memory ready" } as unknown as SettingsRuntime;
}
describe("Memory corrections", () => {
  it("saves the displayed revision and keeps errors editable", async () => {
    const value = runtime();
    vi.mocked(value.correctMemory).mockRejectedValueOnce(new Error("This memory changed. Reopen it."));
    render(<MemoryRecords runtime={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByLabelText("Memory"), { target: { value: "Detailed replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("This memory changed"));
    expect(value.correctMemory).toHaveBeenCalledWith("one", "Writing", "Detailed replies", "revision-one");
    expect((screen.getByLabelText("Memory") as HTMLTextAreaElement).value).toBe("Detailed replies");
  });
  it("excludes forgotten records and offers reversible disabling", async () => {
    const value = runtime();
    value.managedMemoryRecords.push({ ...value.managedMemoryRecords[0], id: "forgotten", title: "Old", forgottenAt: "yesterday" });
    render(<MemoryRecords runtime={value} />);
    expect(screen.queryByText("Old")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(value.toggleMemoryRecordDisabled).toHaveBeenCalledWith("one");
    await waitFor(() => expect((screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
