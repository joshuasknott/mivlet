import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationRoom, MemoryRecord } from "@mivlet/protocol";
import { memoryGroup, WorkspaceMemories } from "./WorkspaceMemories";

const room = {
  id: "chat",
  workspaceId: "workspace",
  title: "Design",
  participants: [{ agentId: "agent", name: "Mira" }],
  facilitatorId: "agent",
} as ConversationRoom;
const record = (patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "memory",
  kind: "fact",
  title: "Decision",
  value: "Keep setup simple",
  source: "You",
  freshness: "Today",
  approved: true,
  pinned: false,
  scope: { level: "thread", threadId: "chat" },
  updatedAt: "revision",
  ...patch,
});
const runtime = (records = [record()]) => ({
  managedMemoryRecords: records,
  memoryDisabled: false,
  addChatMemory: vi.fn().mockResolvedValue(undefined),
  approveMemory: vi.fn().mockResolvedValue(undefined),
  refreshMemories: vi.fn().mockResolvedValue(undefined),
  correctMemory: vi.fn().mockResolvedValue(undefined),
  forgetMemory: vi.fn().mockResolvedValue(undefined),
  toggleMemoryRecordDisabled: vi.fn().mockResolvedValue(undefined),
});

describe("conversation memories", () => {
  it("excludes sibling chats, unrelated agents, foreign workspaces and forgotten records", () => {
    for (const patch of [
      { scope: { level: "thread" as const, threadId: "sibling" } },
      { scope: { level: "agent" as const, agentId: "other" } },
      { workspaceId: "other" },
      { forgottenAt: "yesterday" },
    ])
      expect(memoryGroup(record(patch), room)).toBeNull();
    expect(
      memoryGroup(
        record({ scope: { level: "agent", agentId: "agent" } }),
        room,
      ),
    ).toBe("From this agent");
    expect(memoryGroup(record({ scope: { level: "global" } }), room)).toBe(
      "Account-wide",
    );
  });
  it("project chats inherit only their project and own chat", () => {
    const projectRoom = { ...room, projectId: "project" };
    expect(memoryGroup(record(), projectRoom)).toBe("This chat");
    expect(
      memoryGroup(
        record({ scope: { level: "project", projectId: "project" } }),
        projectRoom,
      ),
    ).toBe("From this project");
    for (const scope of [
      { level: "global" as const },
      { level: "agent" as const, agentId: "agent" },
      { level: "project" as const, projectId: "other" },
    ])
      expect(memoryGroup(record({ scope }), projectRoom)).toBeNull();
  });
  it("adds deliberate chat memories and keeps failed drafts editable", async () => {
    const value = runtime([]);
    value.addChatMemory.mockRejectedValueOnce(new Error("Save failed"));
    render(<WorkspaceMemories room={room} runtime={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Preference" },
    });
    fireEvent.change(screen.getByLabelText("Memory"), {
      target: { value: "Short replies" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByLabelText("Memory")).toHaveValue("Short replies");
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(screen.queryByLabelText("Memory")).toBeNull());
    expect(value.addChatMemory).toHaveBeenCalledWith(
      "chat",
      "Preference",
      "Short replies",
    );
  });
  it("edits with the captured revision and deletes through the forget boundary", async () => {
    const value = runtime();
    render(<WorkspaceMemories room={room} runtime={value} />);
    fireEvent.click(screen.getByLabelText("Actions for Decision"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Memory"), {
      target: { value: "Updated decision" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() =>
      expect(value.correctMemory).toHaveBeenCalledWith(
        "memory",
        "Decision",
        "Updated decision",
        "revision",
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText("Memory")).toBeNull());
    fireEvent.click(screen.getByLabelText("Actions for Decision"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(value.forgetMemory).toHaveBeenCalledWith("memory"),
    );
  });
  it("separates suggestions and explicitly accepts or dismisses them", async () => {
    const value = runtime([
      record({ approved: false, approvalState: "suggested" }),
    ]);
    render(<WorkspaceMemories room={room} runtime={value} />);
    expect(screen.queryByRole("region", { name: "This chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(value.approveMemory).toHaveBeenCalledWith("memory"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(value.forgetMemory).toHaveBeenCalledWith("memory"),
    );
  });
});
