import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectFiles } from "./ProjectFiles";
describe("project files", () => {
  it("attaches only real eligible source ids and removes by source id", () => {
    const onAttach = vi.fn();
    const onRemove = vi.fn();
    const onOpen = vi.fn();
    render(
      <ProjectFiles
        files={[
          {
            sourceId: "source-brief",
            name: "Brief.md",
            mediaType: "text/markdown",
            sizeBytes: 3072,
          },
        ]}
        eligibleSources={[
          { sourceId: "source-brief", name: "Brief.md" },
          {
            sourceId: "source-research",
            name: "Research.md",
            provenance: "Local file · 8 KB",
          },
        ]}
        onAttach={onAttach}
        onRemove={onRemove}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project file" }));
    expect(
      screen.queryByText("All matching files are already attached."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Research.md/ }));
    expect(onAttach).toHaveBeenCalledWith("source-research");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Brief.md from project",
      }),
    );
    expect(onRemove).toHaveBeenCalledWith("source-brief");
    fireEvent.click(screen.getByRole("button", { name: /^Brief.md MARKDOWN/ }));
    expect(onOpen).toHaveBeenCalledWith("source-brief");
  });
});
