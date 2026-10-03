import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchFileDialog } from "./SearchFileDialog";
import { previewRuntimeLocalComputerFile } from "../../runtime/domains/local-computer";

vi.mock("../../runtime/domains/local-computer", () => ({ previewRuntimeLocalComputerFile: vi.fn() }));
const target = { type: "artifact" as const, workspaceId: "workspace", agentId: "agent", relativePath: "Attachments/budget.xlsx", title: "Budget" };
describe("uploaded Office preview", () => {
  it("shows bounded Office content without rendering binary text or untrusted HTML", async () => {
    vi.mocked(previewRuntimeLocalComputerFile).mockResolvedValue({ computerId: "computer", path: target.relativePath, content: "Cached values may be stale.", sizeBytes: 10, updatedAt: "now", truncated: true,
      office: { kind: "spreadsheet", sections: [{ name: "Budget", blocks: [{ type: "table", rows: [["<script>attack</script>", "26"]] }] }] } });
    const { container } = render(<SearchFileDialog target={target} title="Budget" onClose={() => {}} />);
    expect(await screen.findByRole("cell", { name: "26" })).toBeVisible();
    expect(screen.getByText("Cached values may be stale.")).toBeVisible();
    expect(screen.getByText(/preview is truncated/)).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
  });
  it("ignores an old workspace file result after the target changes", async () => {
    let finish!: (value: null) => void;
    vi.mocked(previewRuntimeLocalComputerFile).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<SearchFileDialog target={target} title="Budget" onClose={() => {}} />);
    rerender(<SearchFileDialog title="New file" text="New scope content" onClose={() => {}} />);
    await act(async () => finish(null));
    expect(screen.getByText("New scope content")).toBeVisible();
    expect(screen.queryByText("Preview requires the desktop app.")).toBeNull();
  });
});
