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
  it("reports a failed memory read without presenting it as an empty collection and supports retry", async () => {
    const value = runtime([]);
    value.refreshMemories.mockRejectedValueOnce(
      new Error("Native store unavailable"),
    );
    render(<WorkspaceMemories room={room} runtime={value} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Native store unavailable",
    );
    expect(screen.queryByText(/No saved memories yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry memory" }));
    await waitFor(() => expect(value.refreshMemories).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Memory refreshed.",
    );
  });

  it("pages saved memories independently from suggestions and reveals inherited search matches", () => {
    const value = runtime([
      ...Array.from({ length: 80 }, (_, index) =>
        record({ id: "saved-" + index, title: "Saved fact " + index }),
      ),
      record({
        id: "suggested",
        title: "Candidate preference",
        approved: false,
        approvalState: "suggested",
      }),
      record({
        id: "inherited",
        title: "Agent policy",
        scope: { level: "agent", agentId: "agent" },
      }),
    ]);
    render(<WorkspaceMemories room={room} runtime={value} />);
    expect(screen.getAllByRole("article")).toHaveLength(14);
    expect(screen.getByText("Candidate preference")).toBeVisible();
    expect(screen.getByText("Agent policy")).not.toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Next this chat memory page" }),
    );
    expect(screen.queryByText("Saved fact 0")).toBeNull();
    expect(screen.getByText("Saved fact 23")).toBeVisible();
    expect(screen.getByText("Candidate preference")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Agent policy" },
    });
    expect(screen.getByText("Agent policy")).toBeVisible();
  });

  it("opens only a retained source and expands a long memory on request", () => {
    const open = vi.fn();
    const value = runtime([
      record({
        value: "A lengthy decision. ".repeat(80),
        provenance: {
          origin: "source",
          sourceId: "brief",
          note: "Saved from the launch brief.",
        },
      }),
    ]);
    render(
      <WorkspaceMemories
        room={room}
        runtime={value}
        sourceIds={["brief"]}
        onOpenSource={open}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(open).toHaveBeenCalledWith("brief");
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("searches the entire memory collection while rendering a bounded page", () => {
    const value = runtime(
      Array.from({ length: 100 }, (_, index) =>
        record({ id: "memory-" + index, title: "Saved fact " + index }),
      ),
    );
    render(<WorkspaceMemories room={room} runtime={value} />);
    expect(screen.queryByText("Saved fact 99")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Saved fact 99" },
    });
    expect(screen.getByText("Saved fact 99")).toBeVisible();
    expect(screen.queryByText("Saved fact 0")).toBeNull();
  });

  it("browses only the owner's shared memories without adding a chat memory into that scope", () => {
    const value = runtime([
      record(),
      record({
        id: "project-memory",
        title: "Project style",
        scope: { level: "project", projectId: "project" },
      }),
    ]);
    render(
      <WorkspaceMemories
        room={{ ...room, projectId: "project" }}
        runtime={value}
        scope="owner"
      />,
    );
    expect(screen.getByText("Project style")).toBeVisible();
    expect(screen.queryByText("Decision")).toBeNull();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
  });
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
