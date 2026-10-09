import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfficeOutputEditor } from "./OfficeOutputEditor";

const runtime = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  export: vi.fn(),
  list: vi.fn(),
  ensure: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("../../runtime/domains/office-drafts", () => ({
  getOfficeDraft: runtime.get,
  inspectOfficeDraftSelection: runtime.inspect,
  saveOfficeDraftEdit: runtime.save,
  restoreOfficeDraft: runtime.restore,
  exportOfficeDraft: runtime.export,
}));
vi.mock("../../runtime/domains/outputs", () => ({
  listRuntimeOutputs: runtime.list,
  ensureRuntimeOutput: runtime.ensure,
}));

const documentPreview = (text: string) => ({
  kind: "document" as const,
  sections: [
    {
      name: "Document",
      sourceEntry: "word/document.xml",
      blocks: [{ type: "paragraph" as const, style: "paragraph" as const, text }],
    },
  ],
});

function draft(current = 2, preview = documentPreview("Current")) {
  return {
    artifactId: "artifact-1",
    conversationId: "thread-1",
    agentId: "agent-1",
    title: "Brief.docx",
    extension: "docx",
    currentRevisionNumber: current,
    preview,
    previewTruncated: false,
    revisions: [
      { number: 0, editCount: 0, edits: [], author: "system", createdAt: "2026-10-08T10:00:00Z", provenance: "generated artifact" },
      { number: 1, editCount: 1, edits: [{ kind: "paragraph", entry: "word/document.xml", selector: "0", replacement: "Earlier" }], author: "user", createdAt: "2026-10-08T10:01:00Z", provenance: "paragraph word/document.xml 0" },
      { number: 2, editCount: 2, edits: [{ kind: "paragraph", entry: "word/document.xml", selector: "0", replacement: "Current" }], author: "user", createdAt: "2026-10-08T10:02:00Z", provenance: "paragraph word/document.xml 0" },
    ],
  };
}

function renderEditor() {
  return render(
    <OfficeOutputEditor
      office={documentPreview("Current")}
      truncated={false}
      workspaceId="default"
      conversationId="thread-1"
      agentId="agent-1"
      artifactId="artifact-1"
      generation={3}
      title="Brief.docx"
    />,
  );
}

describe("OfficeOutputEditor", () => {
  it("loads and renders the selected historical preview", async () => {
    const current = draft();
    runtime.get.mockResolvedValueOnce(current).mockResolvedValueOnce({
      ...current,
      preview: documentPreview("Earlier"),
    });
    runtime.list.mockResolvedValue([]);
    renderEditor();
    await waitFor(() => expect(screen.getByText("Current")).toBeVisible());
    fireEvent.change(screen.getByLabelText("Compare or restore"), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByText("Earlier")).toBeVisible());
    expect(screen.queryByRole("button", { name: "Request agent change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit paragraph" })).not.toBeInTheDocument();
  });

  it("does not enable a stale or unauthorised agent proposal", async () => {
    const current = draft();
    runtime.get.mockResolvedValue(current);
    runtime.list.mockResolvedValue([
      {
        id: "office-edit:artifact-1:1:abcd",
        source: { conversationId: "thread-1", artifactId: "artifact-1", agentId: "agent-1" },
        currentRevisionId: "proposal-1",
        currentRevisionNumber: 2,
        revisions: [{
          id: "proposal-1",
          outputId: "office-edit:artifact-1:1:abcd",
          number: 2,
          baseNumber: 1,
          content: JSON.stringify({ kind: "paragraph", entry: "word/document.xml", selector: "0", replacement: "Agent result", baseRevision: 1 }),
          author: "user",
          provenance: { conversationId: "thread-1", artifactId: "artifact-1", agentId: "agent-1", reason: "direct-edit" },
          createdAt: "2026-10-08T10:03:00Z",
        }],
      },
    ]);
    renderEditor();
    await waitFor(() => expect(screen.getByRole("region", { name: "Agent Office revision proposal" })).toBeVisible());
    expect(screen.getByRole("button", { name: "Apply proposed edit" })).toBeDisabled();
    expect(runtime.save).not.toHaveBeenCalled();
  });

  it("shows direct edit failures without losing the selected text", async () => {
    const current = draft();
    runtime.get.mockResolvedValue(current);
    runtime.list.mockResolvedValue([]);
    runtime.save.mockRejectedValue(new Error("The Office draft changed in another pane."));
    renderEditor();
    await waitFor(() => expect(screen.getByText("Current")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Edit paragraph" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement paragraph text" }), { target: { value: "Local edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edited copy" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").some((element) => element.textContent?.includes("changed in another pane"))).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Reload latest" })).toBeEnabled();
  });

  it("reloads the latest Office draft without discarding the stale view first", async () => {
    const current = draft();
    const latest = { ...current, currentRevisionNumber: 3, preview: documentPreview("Latest") };
    runtime.get.mockResolvedValueOnce(current).mockResolvedValueOnce(latest);
    runtime.list.mockResolvedValue([]);
    renderEditor();
    await waitFor(() => expect(screen.getByText("Current")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    // The native refresh is asynchronous; the existing preview remains while
    // it is in flight, then the successful response replaces it.
    expect(screen.getByText("Current")).toBeVisible();
    await waitFor(() => expect(screen.getByText("Latest")).toBeVisible());
  });
});
