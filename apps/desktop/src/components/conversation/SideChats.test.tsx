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
  it("marks Side Chats as separate and separates active from archived", () => {
    setup();
    expect(screen.getByText(/Side Chats are separate conversations/i)).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "Active (1)" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Active research")).toBeVisible();
    expect(screen.queryByText("Archived research")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Archived (1)" }));
    expect(screen.getByText("Archived research")).toBeVisible();
    expect(screen.queryByText("Active research")).toBeNull();
  });

  it("searches titles and reports an empty result without crossing owners", () => {
    setup();
    const search = screen.getByRole("searchbox", {
      name: "Search Mira Side Chats",
    });
    fireEvent.change(search, { target: { value: "active" } });
    expect(screen.getByText("Active research")).toBeVisible();
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(screen.getByText("No Side Chats match this search.")).toBeVisible();
  });

  it("renames through the editor", async () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "Rename Active research" }));
    const dialog = screen.getByRole("dialog", { name: "Rename Side Chat" });
    const input = screen.getByLabelText("Side Chat name");
    fireEvent.change(input, { target: { value: "Renamed research" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save name" }),
    );
    await waitFor(() =>
      expect(handlers.onRename).toHaveBeenCalledWith(active, "Renamed research"),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("archives and restores with the exact room", () => {
    const handlers = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Active research" }),
    );
    expect(handlers.onArchive).toHaveBeenCalledWith(active, true);
    fireEvent.click(screen.getByRole("tab", { name: "Archived (1)" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Archived research" }),
    );
    expect(handlers.onArchive).toHaveBeenCalledWith(archived, false);
  });

  it("requires explicit confirmation before deleting", async () => {
    const handlers = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Active research" }),
    );
    expect(handlers.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Side Chat" }));
    await waitFor(() =>
      expect(handlers.onDelete).toHaveBeenCalledWith(active),
    );
  });

  it("creates a named Side Chat through the editor", async () => {
    const handlers = setup();
    fireEvent.click(screen.getByRole("button", { name: "New Side Chat" }));
    fireEvent.change(screen.getByLabelText("Side Chat name"), {
      target: { value: "  Focused question  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Side Chat" }));
    await waitFor(() =>
      expect(handlers.onCreate).toHaveBeenCalledWith("Focused question"),
    );
  });

  it("surfaces a failed archive instead of dropping it", async () => {
    const onArchive = vi
      .fn()
      .mockRejectedValue(new Error("Stop the request first."));
    setup({ onArchive });
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Active research" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Stop the request first.",
      ),
    );
    expect(onArchive).toHaveBeenCalledWith(active, true);
  });
});
