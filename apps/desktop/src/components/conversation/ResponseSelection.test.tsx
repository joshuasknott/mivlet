import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseSelection } from "./ResponseSelection";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../runtime/domains/conversation-ui", () => ({
  conversationUi: mocks.invoke,
}));

afterEach(() => {
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe("response contextual actions", () => {
  it("sends the canonical persisted source while selecting rendered text", async () => {
    const canonical = "A **quiet** conversation with `tools`.";
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Conversation chat, response run, revision revision-1",
      selection: "**quiet** conversation with `tools`",
    });
    render(
      <ResponseSelection
        text="A quiet conversation with tools."
        source={canonical}
        workspaceId="workspace"
        conversationId="chat"
        runId="run"
        agentId="agent"
        responseMessageId="message"
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={vi.fn()}
        onSaveMemory={vi.fn()}
      >
        <span>quiet conversation with tools</span>
      </ResponseSelection>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    const range = document.createRange();
    range.selectNodeContents(content.firstElementChild!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.pointerUp(content);
    fireEvent.click(await screen.findByRole("button", { name: "Quote / ask" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        { workspaceId: "workspace", conversationId: "chat", agentId: "agent" },
        expect.objectContaining({
          action: "quote-response",
          source: canonical,
        }),
      ),
    );
  });

  it("keeps the final paragraph selection when selectionchange follows pointerup", async () => {
    const onPin = vi.fn().mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Conversation chat, response run, revision revision-1",
      selection: "First paragraph with drinks and citrus.",
    });
    render(
      <ResponseSelection
        text="First paragraph with drinks and citrus.\n\nSecond paragraph."
        workspaceId="workspace"
        conversationId="chat"
        runId="run"
        agentId="agent"
        responseMessageId="message"
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={vi.fn()}
        onSaveMemory={vi.fn()}
        onPin={onPin}
      >
        <span>First paragraph with drinks and citrus.</span>
        <span> Second paragraph.</span>
      </ResponseSelection>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    const rendered = content.firstElementChild!;
    const selection = window.getSelection()!;
    const initial = document.createRange();
    initial.setStart(rendered.firstChild!, 23);
    initial.setEnd(rendered.firstChild!, 29);
    selection.removeAllRanges();
    selection.addRange(initial);
    fireEvent.pointerUp(content);

    const final = document.createRange();
    final.selectNodeContents(rendered);
    selection.removeAllRanges();
    selection.addRange(final);
    fireEvent(document, new Event("selectionchange"));

    fireEvent.click(await screen.findByRole("button", { name: "Pin output" }));
    await waitFor(() =>
      expect(onPin).toHaveBeenCalledWith(
        "First paragraph with drinks and citrus.",
        expect.objectContaining({ sourceRevisionId: "revision-1" }),
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        selection: "First paragraph with drinks and citrus.",
      }),
    );
  });
});
