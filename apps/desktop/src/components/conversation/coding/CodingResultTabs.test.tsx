import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodingResultTabs } from "./CodingResultTabs";
afterEach(cleanup);
describe("real coding result tabs", () => {
  it("shows only supplied views and supports arrow-key selection", () => {
    render(<CodingResultTabs files={<p>Exact files</p>} changes={<p>Exact diff</p>} terminal={<p>Terminal disclosure</p>} />);
    expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();
    const files = screen.getByRole("tab", { name: "Files" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Exact files");
    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Exact diff");
    expect(screen.getByText("Terminal disclosure")).toBeVisible();
  });
  it("falls back to the remaining real view when a result disappears", () => {
    const view = render(<CodingResultTabs preview={<p>Live app</p>} files={<p>Files</p>} />);
    view.rerender(<CodingResultTabs files={<p>Files</p>} />);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Files");
    view.rerender(<CodingResultTabs />);
    expect(screen.queryByRole("region", { name: "Coding result" })).toBeNull();
  });
});
