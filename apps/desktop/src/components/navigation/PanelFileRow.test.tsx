import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelFileRow } from "./PanelFileRow";
import type { PanelFile } from "./workspace-panel-data";

describe("file metadata rows", () => {
  it("renders Markdown, PDF, images and spreadsheets as the same compact row and opens only the clicked file", () => {
    const open = vi.fn();
    const files = [
      "plan.md",
      "research.pdf",
      "checklist.xlsx",
      "cover.png",
    ].map((title): PanelFile => ({
      id: title,
      title,
      detail: "Created by Mira",
      origin: "created",
      updatedAt: "2026-10-17",
      tab: {
        id: title,
        kind: "file",
        title,
        text: "Actual content is opened only in the inspector.",
      },
    }));
    render(
      <>
        {files.map((file) => (
          <PanelFileRow
            key={file.id}
            file={file}
            workspaceId="workspace"
            onOpen={open}
          />
        ))}
      </>,
    );
    expect(screen.queryByText(/Actual content/)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    for (const button of screen.getAllByRole("button"))
      expect(button).toHaveClass("workspace-library__file-row");
    fireEvent.click(screen.getByRole("button", { name: "Open research.pdf" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(files[1].tab);
  });

  it("keeps unavailable attachments in the same row with a clear reattachment prerequisite", () => {
    const open = vi.fn();
    const file: PanelFile = {
      id: "missing",
      title: "brief.md",
      detail: "Added to chat",
      origin: "attached",
      updatedAt: "2026-10-17",
      attachment: {
        agentId: "agent",
        threadId: "chat",
        file: {
          id: "missing",
          name: "brief.md",
          sizeBytes: 12,
          mimeType: "text/markdown",
          availability: "transient",
        },
      },
    };
    render(<PanelFileRow file={file} workspaceId="workspace" onOpen={open} />);
    expect(
      screen.getByRole("button", { name: "Preview brief.md" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Original not retained · Reattach to preview"),
    ).toBeVisible();
    expect(open).not.toHaveBeenCalled();
  });
});
