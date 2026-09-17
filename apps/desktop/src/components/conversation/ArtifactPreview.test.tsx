import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreview } from "./ArtifactPreview";
import { previewComputerArtifact } from "../../lib/computer-artifacts";
vi.mock("../../lib/computer-artifacts", async (original) => ({ ...await original<typeof import("../../lib/computer-artifacts")>(), previewComputerArtifact: vi.fn(), canOpenComputerArtifact: () => false }));
const output = JSON.stringify({ kind: "computer-artifact", version: 1, id: `artifact-${"a".repeat(64)}`, computerId: `local-${"b".repeat(24)}`, title: "Notes", relativePath: "notes.md", mimeType: "text/markdown", sizeBytes: 20, createdAt: "2026-09-06T12:00:00Z" });
describe("verified artifact previews", () => {
  beforeEach(() => {
    vi.mocked(previewComputerArtifact).mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  it("renders published Markdown and passes the exact scope and generation", async () => {
    vi.mocked(previewComputerArtifact).mockResolvedValue({ artifactId: `artifact-${"a".repeat(64)}`, mimeType: "text/markdown", text: "# Published notes", imageDataUrl: null, truncated: false });
    render(<ArtifactPreview output={output} workspaceId="workspace" agentId="agent" generation={7} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Published notes" });
    expect(previewComputerArtifact).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "agent", artifactId: `artifact-${"a".repeat(64)}`, expectedGeneration: 7 });
  });
  it("keeps the external-open fallback for PDF documents", async () => {
    vi.mocked(previewComputerArtifact).mockResolvedValue({ artifactId: `artifact-${"a".repeat(64)}`, mimeType: "application/pdf", text: null, imageDataUrl: null, truncated: false });
    const pdf = JSON.stringify({ ...JSON.parse(output), mimeType: "application/pdf", relativePath: "notes.pdf" });
    render(<ArtifactPreview output={pdf} workspaceId="workspace" agentId="agent" generation={7} onClose={() => {}} />);
    expect(await screen.findByText("This file is ready to open.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Notes" })).toBeVisible();
  });
  it("discards an old preview after a generation change", async () => {
    let finish!: (value: Awaited<ReturnType<typeof previewComputerArtifact>>) => void;
    vi.mocked(previewComputerArtifact).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("Computer changed"));
    const props = { output, workspaceId: "workspace", agentId: "agent", onClose: () => {} };
    const view = render(<ArtifactPreview {...props} generation={7} />);
    view.rerender(<ArtifactPreview {...props} generation={8} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Computer changed"));
    await act(async () => finish({ artifactId: "old", mimeType: "text/markdown", text: "Old private content", imageDataUrl: null, truncated: false }));
    expect(screen.queryByText("Old private content")).toBeNull();
  });
});
