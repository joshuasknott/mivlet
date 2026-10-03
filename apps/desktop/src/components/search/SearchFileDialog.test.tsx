import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchFileDialog } from "./SearchFileDialog";
import { previewRuntimeLocalComputerFile } from "../../runtime/domains/local-computer";

vi.mock("../../runtime/domains/local-computer", () => ({ previewRuntimeLocalComputerFile: vi.fn() }));
vi.mock("../conversation/PdfPreview", () => ({ PdfPreview: ({ base64 }: { base64: string }) => <section aria-label="PDF pages">{base64}</section> }));
const target = { type: "artifact" as const, workspaceId: "workspace", agentId: "agent", relativePath: "Attachments/budget.xlsx", title: "Budget" };
describe("uploaded Office preview", () => {
  it("routes original PDF bytes to the lazy page viewer", async () => {
    vi.mocked(previewRuntimeLocalComputerFile).mockResolvedValue({ computerId: "computer", path: "Attachments/report.pdf", content: "PDF page preview", sizeBytes: 10, updatedAt: "now", truncated: false, pdfBase64: "native-pdf-bytes" });
    render(<SearchFileDialog target={{ ...target, relativePath: "Attachments/report.pdf" }} title="Report" onClose={() => {}} />);
    expect(await screen.findByRole("region", { name: "PDF pages" })).toHaveTextContent("native-pdf-bytes");
  });
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
