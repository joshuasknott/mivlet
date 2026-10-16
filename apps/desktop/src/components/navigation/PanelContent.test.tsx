import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelOutput, PanelWebPreview } from "./PanelContent";
import { OpenWebPreview } from "./open-web-preview";
import { MessageMarkdown } from "../conversation/MessageMarkdown";
import { emitOutputRevisionApplied } from "../../lib/output-revision-events";

vi.mock("../../runtime/domains/outputs", () => ({
  getRuntimeOutput: vi.fn(),
}));
vi.mock("../conversation/OutputEditor", () => ({
  OutputEditor: ({ source, output }: { source: { sourceRevisionId?: string }; output: { currentRevisionNumber: number } }) => (
    <div data-testid="output-editor" data-source-revision={source.sourceRevisionId ?? ""} data-current-revision={output.currentRevisionNumber} />
  ),
}));

import { getRuntimeOutput } from "../../runtime/domains/outputs";

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

describe("saved output navigation", () => {
  it("passes the durable source branch and revision back to conversation navigation", async () => {
    vi.mocked(getRuntimeOutput).mockResolvedValue({
      id: "output-1",
      title: "Launch plan",
      format: "markdown",
      mimeType: "text/markdown",
      source: {
        conversationId: "conversation-1",
        branchId: "branch-2",
        messageId: "message-7",
        sourceRevisionId: "message-revision-3",
      },
      revisions: [],
      currentRevisionId: "output-revision-1",
      currentRevisionNumber: 1,
      pinned: true,
      updatedAt: "2026-10-08T10:00:00.000Z",
    });
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();
    render(
      <PanelOutput
        outputId="output-1"
        workspaceId="workspace-1"
        onOpenConversation={onOpenConversation}
        onClose={onClose}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open originating conversation" })).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open originating conversation" }),
    );
    expect(onOpenConversation).toHaveBeenCalledWith("conversation-1", {
      conversationId: "conversation-1",
      branchId: "branch-2",
      messageId: "message-7",
      sourceRevisionId: "message-revision-3",
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens a pinned revision with its exact provenance source", async () => {
    vi.mocked(getRuntimeOutput).mockResolvedValue({
      id: "output-2",
      title: "Agent draft",
      format: "markdown",
      mimeType: "text/markdown",
      source: { conversationId: "conversation-2", messageId: "message-1" },
      revisions: [{
        id: "output-revision-2",
        outputId: "output-2",
        number: 2,
        baseNumber: 1,
        content: "agent revision",
        author: "agent",
        provenance: {
          conversationId: "conversation-2",
          messageId: "message-2",
          sourceRevisionId: "message-revision-2",
          agentId: "agent-1",
          reason: "agent-revision",
        },
        createdAt: "2026-10-08T10:01:00.000Z",
      }],
      currentRevisionId: "output-revision-2",
      currentRevisionNumber: 2,
      pinned: true,
      pin: {
        revisionId: "output-revision-2",
        source: {
          conversationId: "conversation-2",
          messageId: "message-2",
          sourceRevisionId: "message-revision-2",
          agentId: "agent-1",
        },
      },
      updatedAt: "2026-10-08T10:01:00.000Z",
    });
    render(<PanelOutput outputId="output-2" workspaceId="workspace-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("output-editor")).toHaveAttribute("data-source-revision", "message-revision-2"));
  });

  it("refreshes a clean saved-output panel when the owning agent revision is applied", async () => {
    const first = {
      id: "output-live",
      title: "Agent draft",
      format: "markdown" as const,
      mimeType: "text/markdown",
      source: { conversationId: "conversation-live" },
      revisions: [],
      currentRevisionId: "output-revision-1",
      currentRevisionNumber: 1,
      pinned: true,
      updatedAt: "2026-10-08T10:00:00.000Z",
    };
    const second = { ...first, currentRevisionId: "output-revision-2", currentRevisionNumber: 2 };
    vi.mocked(getRuntimeOutput).mockResolvedValue(first);
    render(<PanelOutput outputId="output-live" workspaceId="workspace-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("output-editor")).toHaveAttribute("data-current-revision", "1"));
    act(() => {
      emitOutputRevisionApplied({ outputId: "output-live", conversationId: "conversation-live", output: second });
    });
    await waitFor(() => expect(screen.getByTestId("output-editor")).toHaveAttribute("data-current-revision", "2"));
  });
});
