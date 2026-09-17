import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageAttachments } from "./MessageAttachments";
import { retainAttachmentPreviews } from "../../lib/attachment-previews";
import { setActiveRuntimeDataScope } from "../../runtime-scope";
import { previewRuntimeLocalComputerFile } from "../../runtime/domains/local-computer";

vi.mock("../../runtime/domains/local-computer", () => ({ previewRuntimeLocalComputerFile: vi.fn() }));
const file = { id: "file", name: "notes.csv", mimeType: "text/csv", sizeBytes: 12, availability: "workspace-file" as const, relativePath: "Attachments/notes.csv" };
const props = { workspaceId: "workspace", agentId: "agent", threadId: "thread", attachments: [file] };
describe("message attachments", () => {
  beforeEach(() => { setActiveRuntimeDataScope("workspace"); vi.mocked(previewRuntimeLocalComputerFile).mockReset(); });
  it("opens a saved document with the exact workspace path and restores focus on Escape", async () => {
    vi.mocked(previewRuntimeLocalComputerFile).mockResolvedValue({ computerId: "local", path: file.relativePath, content: "name,total\nEmber,42", sizeBytes: 12, truncated: false, updatedAt: "now" });
    render(<MessageAttachments {...props} />);
    const button = screen.getByRole("button", { name: "Preview notes.csv" });
    button.focus(); fireEvent.click(button);
    expect(await screen.findByText(/Ember,42/)).toBeVisible();
    expect(previewRuntimeLocalComputerFile).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "agent", path: file.relativePath });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });
  it("renders uploaded images inline and opens them without a file read", () => {
    const image = { id: "photo", name: "photo.png", mediaType: "image/png" as const, dataUrl: "data:image/png;base64,aGVsbG8=", sizeBytes: 5, width: 1, height: 1 };
    retainAttachmentPreviews("workspace", "thread", [{ id: image.id, name: image.name, type: image.mediaType, sizeBytes: 5, imageInput: image }]);
    render(<MessageAttachments {...props} attachments={[{ id: image.id, name: image.name, mimeType: image.mediaType, sizeBytes: 5, availability: "image-input" }]} />);
    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute("src", image.dataUrl);
    fireEvent.click(screen.getByRole("button", { name: "Preview photo.png" }));
    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeVisible();
    expect(previewRuntimeLocalComputerFile).not.toHaveBeenCalled();
  });
  it("previews uploaded document text safely even without a workspace file", () => {
    retainAttachmentPreviews("workspace", "thread", [{ id: file.id, name: file.name, type: file.mimeType, sizeBytes: 12, transientBytes: new TextEncoder().encode("<script>private text</script>") }]);
    render(<MessageAttachments {...props} attachments={[{ ...file, availability: "project-file", relativePath: undefined }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.csv" }));
    expect(screen.getByText("<script>private text</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(previewRuntimeLocalComputerFile).not.toHaveBeenCalled();
  });
  it("keeps historical unavailable originals honest and never guesses the file owner", () => {
    const view = render(<MessageAttachments {...props} attachments={[{ ...file, availability: "image-input", relativePath: undefined }]} />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText(/Original not retained/)).toBeVisible();
    view.rerender(<MessageAttachments {...props} agentId="unavailable-author" />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(previewRuntimeLocalComputerFile).not.toHaveBeenCalled();
  });
});
