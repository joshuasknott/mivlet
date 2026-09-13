import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationCommand,
  CollaborationSnapshot,
  ConversationRoom,
  MemoryControlState,
} from "@fable/protocol";
import {
  createSideChat,
  deleteSideChat,
  mainChatForAgent,
  partitionSideChats,
  promoteConversationConclusion,
  projectMainChat,
  renameSideChat,
  resolveMainChat,
  searchConversations,
  setSideChatArchived,
  sideChatsFor,
  type ConversationCommandPort,
  type MemoryPromotionPorts,
} from "./conversation-service";

vi.mock("../runtime", () => ({
  loadRuntimeMemoryState: vi.fn(),
  saveRuntimeMemoryState: vi.fn(),
}));

const room = (over: Partial<ConversationRoom> = {}): ConversationRoom => ({
  id: "room",
  workspaceId: "default",
  kind: "direct",
  title: "Room",
  participants: [{ agentId: "lead", name: "lead" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const main = room({
  id: "main-lead",
  chat: { role: "main", ownerKind: "agent", ownerId: "lead" },
});
const projectMain = room({
  id: "main-project",
  chat: { role: "main", ownerKind: "project", ownerId: "project" },
});
const side = room({
  id: "side-lead",
  title: "Research notes",
  chat: { role: "side", ownerKind: "agent", ownerId: "lead" },
  updatedAt: "2026-02-01T00:00:00.000Z",
});
const archived = room({
  id: "side-archived",
  title: "Old research",
  chat: { role: "side", ownerKind: "agent", ownerId: "lead" },
  archived: true,
  updatedAt: "2026-03-01T00:00:00.000Z",
});
const otherAgent = room({
  id: "side-researcher",
  chat: { role: "side", ownerKind: "agent", ownerId: "researcher" },
});
const projectSide = room({
  id: "side-project",
  title: "Launch planning",
  chat: { role: "side", ownerKind: "project", ownerId: "project" },
});
const unclassified = room({ id: "legacy" });

function commandPort(
  respond: (
    command: CollaborationCommand,
    snapshot: CollaborationSnapshot,
  ) => CollaborationSnapshot,
) {
  const commands: CollaborationCommand[] = [];
  const snapshot: CollaborationSnapshot = {
    conversations: [],
    authors: [],
    teams: [],
    work: [],
    facts: [],
    layout: null,
  };
  const fake: ConversationCommandPort = {
    command: async (command) => {
      commands.push(command);
      return respond(command, snapshot);
    },
  };
  return { fake, commands, snapshot };
}

describe("conversation selectors", () => {
  it("resolves exactly one main Chat per Agent or Project and never guesses for unclassified chats", () => {
    const rooms = [unclassified, side, main, projectMain, otherAgent];
    expect(mainChatForAgent(rooms, "lead")?.id).toBe("main-lead");
    expect(mainChatForAgent(rooms, "researcher")).toBeUndefined();
    expect(projectMainChat(rooms, "project")?.id).toBe("main-project");
    expect(mainChatForAgent([side, unclassified], "lead")).toBeUndefined();
  });

  it("keeps Side Chats scoped to their exact owner", () => {
    const rooms = [main, side, archived, otherAgent, projectSide];
    expect(sideChatsFor(rooms, { kind: "agent", id: "lead" })).toEqual([
      side,
      archived,
    ]);
    expect(sideChatsFor(rooms, { kind: "project", id: "project" })).toEqual([
      projectSide,
    ]);
    expect(sideChatsFor(rooms, { kind: "agent", id: "missing" })).toEqual([]);
  });

  it("splits and searches Side Chats without crossing owners", () => {
    const rooms = [main, side, archived, otherAgent, projectSide];
    const lead = partitionSideChats(rooms, { kind: "agent", id: "lead" });
    expect(lead.active.map((item) => item.id)).toEqual(["side-lead"]);
    expect(lead.archived.map((item) => item.id)).toEqual(["side-archived"]);
    const searched = partitionSideChats(
      rooms,
      { kind: "agent", id: "lead" },
      "RESEARCH",
    );
    expect(searched.active.map((item) => item.id)).toEqual(["side-lead"]);
    expect(searched.archived.map((item) => item.id)).toEqual(["side-archived"]);
    expect(searchConversations(rooms, "launch")).toEqual([projectSide]);
    expect(searchConversations(rooms, "  ")).toHaveLength(rooms.length);
  });
});

describe("main Chat resolution", () => {
  it("returns the same persistent Chat for repeated selection", async () => {
    const { fake, commands } = commandPort(() => ({
      conversations: [main],
      authors: [],
      teams: [],
      work: [],
      facts: [],
      layout: null,
    }));
    const first = await resolveMainChat(fake, "lead");
    const second = await resolveMainChat(fake, "lead");
    expect(first.id).toBe("main-lead");
    expect(second.id).toBe("main-lead");
    expect(commands).toEqual([
      { action: "open-main-chat", agentId: "lead" },
      { action: "open-main-chat", agentId: "lead" },
    ]);
  });

  it("fails closed when the main Chat cannot be resolved", async () => {
    const { fake } = commandPort(() => ({
      conversations: [],
      authors: [],
      teams: [],
      work: [],
      facts: [],
      layout: null,
    }));
    await expect(resolveMainChat(fake, "lead")).rejects.toThrow(
      "main Chat could not be resolved",
    );
  });
});

describe("Side Chat lifecycle commands", () => {
  it("creates an Agent Side Chat with its exact owner", async () => {
    const { fake, commands } = commandPort((command) => {
      if (command.action !== "create-conversation") throw new Error("unexpected");
      return {
        conversations: [room({ id: command.id, chat: side.chat })],
        authors: [],
        teams: [],
        work: [],
        facts: [],
        layout: null,
      };
    });
    const created = await createSideChat(fake, {
      id: "side-1",
      title: "  Fresh notes  ",
      owner: { kind: "agent", id: "lead" },
      participantIds: ["lead"],
      facilitatorId: "lead",
    });
    expect(created.id).toBe("side-1");
    expect(commands[0]).toEqual({
      action: "create-conversation",
      id: "side-1",
      title: "Fresh notes",
      kind: "direct",
      participantIds: ["lead"],
      facilitatorId: "lead",
      projectId: undefined,
    });
  });

  it("creates a Project Side Chat as a group bound to the project", async () => {
    const { fake, commands } = commandPort((command) => {
      if (command.action !== "create-conversation") throw new Error("unexpected");
      return {
        conversations: [room({ id: command.id, chat: projectSide.chat })],
        authors: [],
        teams: [],
        work: [],
        facts: [],
        layout: null,
      };
    });
    await createSideChat(fake, {
      id: "side-2",
      title: "Launch",
      owner: { kind: "project", id: "project" },
      participantIds: ["lead", "researcher"],
      facilitatorId: "lead",
    });
    expect(commands[0]).toMatchObject({
      action: "create-conversation",
      kind: "group",
      projectId: "project",
    });
  });

  it("fails closed when the created Side Chat is missing from the snapshot", async () => {
    const { fake } = commandPort(() => ({
      conversations: [],
      authors: [],
      teams: [],
      work: [],
      facts: [],
      layout: null,
    }));
    await expect(
      createSideChat(fake, {
        id: "side-3",
        title: "Missing",
        owner: { kind: "agent", id: "lead" },
        participantIds: ["lead"],
        facilitatorId: "lead",
      }),
    ).rejects.toThrow("was not saved");
  });

  it("sends revision-fenced rename, archive and delete commands", async () => {
    const { fake, commands } = commandPort(() => ({
      conversations: [],
      authors: [],
      teams: [],
      work: [],
      facts: [],
      layout: null,
    }));
    await renameSideChat(fake, side, "  Renamed notes  ");
    await setSideChatArchived(fake, side, true);
    await deleteSideChat(fake, side);
    expect(commands).toEqual([
      {
        action: "rename-conversation",
        id: "side-lead",
        expectedRevision: 1,
        title: "Renamed notes",
      },
      {
        action: "set-conversation-archived",
        id: "side-lead",
        expectedRevision: 1,
        archived: true,
      },
      {
        action: "delete-conversation",
        id: "side-lead",
        expectedRevision: 1,
      },
    ]);
  });

  it("propagates stale-revision rejection instead of retrying blindly", async () => {
    const fake: ConversationCommandPort = {
      command: async () => {
        throw new Error("This conversation changed. Reload before editing.");
      },
    };
    await expect(renameSideChat(fake, side, "Stale")).rejects.toThrow(
      "Reload before editing",
    );
    await expect(setSideChatArchived(fake, side, true)).rejects.toThrow(
      "Reload before editing",
    );
    await expect(deleteSideChat(fake, side)).rejects.toThrow(
      "Reload before editing",
    );
  });
});

describe("deliberate Memory promotion", () => {
  const emptyState: MemoryControlState = {
    disabled: false,
    records: [
      {
        id: "existing",
        kind: "preference",
        title: "Existing",
        value: "Keep",
        source: "You",
        freshness: "Today",
        approved: true,
        pinned: false,
      },
    ],
  };

  function ports(
    state: MemoryControlState | null = emptyState,
  ): MemoryPromotionPorts & { saved: MemoryControlState[] } {
    const saved: MemoryControlState[] = [];
    return {
      saved,
      load: async () => state,
      save: async (next) => {
        saved.push(next);
        return next;
      },
    };
  }

  it("records one approved conclusion with narrow scope and provenance", async () => {
    const sink = ports();
    const record = await promoteConversationConclusion(sink, {
      conversation: side,
      title: "Deadline",
      value: "Use the two week deadline.",
      scope: { level: "agent", id: "lead" },
      promotedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(record.approved).toBe(true);
    expect(record.kind).toBe("fact");
    expect(record.scope).toEqual({ level: "agent", agentId: "lead" });
    expect(record.scope && "threadId" in record.scope).toBe(false);
    expect(record.provenance).toMatchObject({
      origin: "chat",
      sourceId: "side-lead",
    });
    expect(sink.saved).toHaveLength(1);
    expect(sink.saved[0].records[0]).toEqual(record);
    expect(sink.saved[0].records[1].id).toBe("existing");
  });

  it("keeps thread and project scopes exact", async () => {
    const threadSink = ports();
    const threadRecord = await promoteConversationConclusion(threadSink, {
      conversation: side,
      title: "Note",
      value: "Only here.",
      scope: { level: "thread", id: "side-lead" },
      promotedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(threadRecord.scope).toEqual({
      level: "thread",
      threadId: "side-lead",
    });
    const projectRecord = await promoteConversationConclusion(ports(), {
      conversation: projectSide,
      title: "Decision",
      value: "Ship it.",
      scope: { level: "project", id: "project" },
      promotedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(projectRecord.scope).toEqual({
      level: "project",
      projectId: "project",
    });
  });

  it("refuses empty, oversized, disabled, unavailable and unsaved memory", async () => {
    await expect(
      promoteConversationConclusion(ports(), {
        conversation: side,
        title: " ",
        value: "text",
        scope: { level: "agent", id: "lead" },
        promotedAt: "now",
      }),
    ).rejects.toThrow("Add a title");
    await expect(
      promoteConversationConclusion(ports(), {
        conversation: side,
        title: "Title",
        value: "x".repeat(2_001),
        scope: { level: "agent", id: "lead" },
        promotedAt: "now",
      }),
    ).rejects.toThrow("2,000 characters");
    await expect(
      promoteConversationConclusion(
        ports({ disabled: true, records: [] }),
        {
          conversation: side,
          title: "Title",
          value: "Value",
          scope: { level: "agent", id: "lead" },
          promotedAt: "now",
        },
      ),
    ).rejects.toThrow("Memory is disabled");
    await expect(
      promoteConversationConclusion(ports(null), {
        conversation: side,
        title: "Title",
        value: "Value",
        scope: { level: "agent", id: "lead" },
        promotedAt: "now",
      }),
    ).rejects.toThrow("Memory is unavailable");
    await expect(
      promoteConversationConclusion(
        { load: async () => emptyState, save: async () => null },
        {
          conversation: side,
          title: "Title",
          value: "Value",
          scope: { level: "agent", id: "lead" },
          promotedAt: "now",
        },
      ),
    ).rejects.toThrow("could not save");
  });
});
