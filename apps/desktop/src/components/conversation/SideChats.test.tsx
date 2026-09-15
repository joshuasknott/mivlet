import { act } from "@testing-library/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationRoom } from "@fable/protocol";
import { SideChatList } from "./SideChats";

const room = (over: Partial<ConversationRoom> = {}): ConversationRoom => ({
  id: "side",
  workspaceId: "default",
  kind: "direct",
  title: "Side",
  chat: { role: "side", ownerKind: "agent", ownerId: "lead" },
  participants: [{ agentId: "lead", name: "lead" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const active = room({ id: "active", title: "Active research" });
const archived = room({
  id: "archived",
  title: "Archived research",
  archived: true,
});

function setup(overrides: Partial<Parameters<typeof SideChatList>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <SideChatList
      chats={[active, archived]}
      owner={{ kind: "agent", id: "lead" }}
      ownerName="Mira"
      activeId="active"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("SideChatList", () => {
  it("does not carry a rename editor into another owner's list", async () => {
    const handlers = { onOpen: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
    const view = render(<SideChatList chats={[active]} owner={{ kind: "agent", id: "lead" }} ownerName="Mira" {...handlers} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rename Active research" })); });
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(<SideChatList chats={[]} owner={{ kind: "agent", id: "other" }} ownerName="Other" {...handlers} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(handlers.onRename).not.toHaveBeenCalled();
  });

  it("marks Side Chats as separate and separates active from archived", async () => {
    setup();
    expect(screen.getByText(/Side Chats are separate conversations/i)).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "Active (1)" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Active research")).toBeVisible();
    expect(screen.queryByText("Archived research")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Archived (1)" })); });
    expect(screen.getByText("Archived research")).toBeVisible();
    expect(screen.queryByText("Active research")).toBeNull();
  });

  it("searches titles and reports an empty result without crossing owners", async () => {
    setup();
    const search = screen.getByRole("searchbox", {
      name: "Search Mira Side Chats",
    });
    await act(async () => { fireEvent.change(search, { target: { value: "active" } }); });
    expect(screen.getByText("Active research")).toBeVisible();
    await act(async () => { fireEvent.change(search, { target: { value: "nothing" } }); });
    expect(screen.getByText("No Side Chats match this search.")).toBeVisible();
  });

  it("renames through the editor", async () => {
    const handlers = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rename Active research" })); });
    const dialog = screen.getByRole("dialog", { name: "Rename Side Chat" });
    const input = screen.getByLabelText("Side Chat name");
    await act(async () => { fireEvent.change(input, { target: { value: "Renamed research" } }); });
    await act(async () => { fireEvent.click(
      screen.getByRole("button", { name: "Save name" }),
    ); });
    await waitFor(() =>
      expect(handlers.onRename).toHaveBeenCalledWith(active, "Renamed research"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("archives and restores with the exact room", async () => {
    const handlers = setup();
    await act(async () => { fireEvent.click(
      screen.getByRole("button", { name: "Archive Active research" }),
    ); });
    expect(handlers.onArchive).toHaveBeenCalledWith(active, true);
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Archived (1)" })); });
    await act(async () => { fireEvent.click(
      screen.getByRole("button", { name: "Restore Archived research" }),
    ); });
    expect(handlers.onArchive).toHaveBeenCalledWith(archived, false);
  });

  it("requires explicit confirmation before deleting", async () => {
    const handlers = setup();
    await act(async () => { fireEvent.click(
      screen.getByRole("button", { name: "Delete Active research" }),
    ); });
    expect(handlers.onDelete).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete Side Chat" })); });
    await waitFor(() =>
      expect(handlers.onDelete).toHaveBeenCalledWith(active),
    );
  });

  it("creates a named Side Chat through the editor", async () => {
    const handlers = setup();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New Side Chat" })); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Side Chat name"), {
      target: { value: "  Focused question  " },
    }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create Side Chat" })); });
    await waitFor(() =>
      expect(handlers.onCreate).toHaveBeenCalledWith("Focused question"),
    );
  });

  it("surfaces a failed archive instead of dropping it", async () => {
    const onArchive = vi
      .fn()
      .mockRejectedValue(new Error("Stop the request first."));
    setup({ onArchive });
    await act(async () => { fireEvent.click(
      screen.getByRole("button", { name: "Archive Active research" }),
    ); });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Stop the request first.",
      ),
    );
    expect(onArchive).toHaveBeenCalledWith(active, true);
  });
});
