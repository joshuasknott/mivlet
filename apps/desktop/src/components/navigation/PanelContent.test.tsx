import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelWebPreview } from "./PanelContent";
import { OpenWebPreview } from "./open-web-preview";
import { MessageMarkdown } from "../conversation/MessageMarkdown";

describe("panel web previews", () => {
  it("routes explicit web clicks to the panel while preserving modified clicks and email links", () => {
    const open = vi.fn();
    render(
      <OpenWebPreview.Provider value={open}>
        <MessageMarkdown content="[Read](https://example.com) [Email](mailto:hello@example.com)" />
      </OpenWebPreview.Provider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Read" }));
    expect(open).toHaveBeenCalledWith("https://example.com/");
    open.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "Read" }), {
      ctrlKey: true,
    });
    fireEvent.click(screen.getByRole("link", { name: "Email" }));
    expect(open).not.toHaveBeenCalled();
  });
  it("isolates remote pages and always offers an external browser fallback", () => {
    render(<PanelWebPreview url="https://example.com/path" />);
    const frame = screen.getByTitle("Web preview: example.com");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("referrerPolicy", "no-referrer");
    expect(frame).toHaveAttribute("src", "https://example.com/path");
    expect(
      screen.getAllByRole("link", { name: "Open in browser" }),
    ).toHaveLength(2);
  });
  it("never embeds executable, local-file, credential-bearing or insecure addresses", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///private",
      "https://user:pass@example.com",
      "http://example.com",
    ]) {
      const view = render(<PanelWebPreview url={url} />);
      expect(view.container.querySelector("iframe")).toBeNull();
      view.unmount();
    }
  });
});
