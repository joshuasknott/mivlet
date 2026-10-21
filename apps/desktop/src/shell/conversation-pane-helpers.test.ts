import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollaborationWorkItem,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { composerScopeKey } from "../hooks/useScopedComposer";
import {
  conversationAuthors,
  openResponseSideChat,
  pendingConversationTurns,
} from "./conversation-pane-helpers";

const sideChats = vi.hoisted(() => ({ createSideChat: vi.fn() }));
const drafts = vi.hoisted(() => ({
  loadRuntimeConversationDraft: vi.fn(),
  saveRuntimeConversationDraft: vi.fn(),
}));

vi.mock("../lib/conversation-service", () => sideChats);
vi.mock("../runtime/domains/conversations", () => drafts);

const fallback: MivletAgentProfile = {
  id: "fallback",
  name: "Fallback",
  instructions: "",
  modelId: "",
  permissionLabel: "Ask Me",
  icon: "agent",
  iconColor: "#24bb77",
  connectorIds: [],
  knowledgeSourceIds: [],
};

const work = (patch: Partial<CollaborationWorkItem> = {}) =>
  ({
    id: "work-1",
    agentId: "agent-1",
    agentName: "Agent One",
    conversationId: "conversation-1",
    status: "failed",
    runIds: [],
    prompt: "Queued request",
    userRequest: "",
    createdAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:01:00.000Z",
    ...patch,
  }) as CollaborationWorkItem;

describe("conversation pane projections", () => {
  beforeEach(() => {
    sideChats.createSideChat.mockReset();
    drafts.loadRuntimeConversationDraft.mockReset();
    drafts.saveRuntimeConversationDraft.mockReset();
    sideChats.createSideChat.mockResolvedValue({
      id: "side-chat",
      workspaceId: "workspace-1",
      projectId: undefined,
    });
  });

  it("includes failed queue items and steering entries in feed order", () => {
    const turns = pendingConversationTurns([
      work({
        steering: [
          {
            id: "steer-1",
            text: "Continue with the review",
            createdAt: "2026-10-18T10:02:00.000Z",
          },
        ],
      }),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["work-1", "steer-1"]);
    expect(turns[0]?.parts[0]).toMatchObject({
      kind: "notice",
      error: true,
    });
  });

  it("prefers persisted run authors and overlays current work authors", () => {
    const agentById = new Map<string, MivletAgentProfile>([
      ["agent-1", { ...fallback, id: "agent-1", name: "Current name" }],
    ]);
    const result = conversationAuthors({
      authors: [
        {
          conversationId: "conversation-1",
          runId: "run-1",
          agentId: "agent-1",
          name: "Saved name",
        },
      ],
      work: [work()],
      conversationId: "conversation-1",
      agentById,
      fallback,
    });
    expect(result["run-1"]?.name).toBe("Saved name");
    expect(result["work-1"]?.name).toBe("Agent One");
  });

  it("preserves an existing Side Chat draft", async () => {
    drafts.loadRuntimeConversationDraft.mockResolvedValue({
      content: JSON.stringify({ text: "already drafted", attachments: [] }),
    });
    const open = vi.fn();
    const isCurrent = vi.fn(() => true);

    await openResponseSideChat({
      service: {} as never,
      runtime: {
        accountWorkspaceStatus: {
          activeContextOwner: { internalUserId: "user" },
        },
      } as never,
      room: {
        id: "source",
        workspaceId: "workspace-1",
        title: "Source",
        chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
        participants: [{ agentId: "mira", name: "Mira" }],
        facilitatorId: "mira",
      } as never,
      workspaceId: "workspace-1",
      authorId: "mira",
      draft: "selected passage",
      isCurrent,
      open,
    });

    expect(drafts.saveRuntimeConversationDraft).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("side-chat");
  });

  it("persists the selected passage under the destination composer scope and opens it", async () => {
    drafts.loadRuntimeConversationDraft.mockResolvedValue(null);
    const open = vi.fn();

    await openResponseSideChat({
      service: {} as never,
      runtime: {
        accountWorkspaceStatus: {
          activeContextOwner: { internalUserId: "user" },
        },
      } as never,
      room: {
        id: "source",
        workspaceId: "workspace-1",
        title: "Source",
        chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
        participants: [{ agentId: "mira", name: "Mira" }],
        facilitatorId: "mira",
      } as never,
      workspaceId: "workspace-1",
      authorId: "mira",
      draft: "Ask about this passage:\n\n> Selected quote\n\nSource: revision-1",
      isCurrent: () => true,
      open,
    });

    expect(drafts.loadRuntimeConversationDraft).toHaveBeenCalledWith(
      composerScopeKey({
        workspaceId: "workspace-1",
        accountId: "user:",
        agentId: "mira",
        threadId: "side-chat",
      }),
      "workspace-1",
      "side-chat",
    );
    expect(drafts.saveRuntimeConversationDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftKey: composerScopeKey({
          workspaceId: "workspace-1",
          accountId: "user:",
          agentId: "mira",
          threadId: "side-chat",
        }),
        threadId: "side-chat",
        content: JSON.stringify({
          text: "Ask about this passage:\n\n> Selected quote\n\nSource: revision-1",
          attachments: [],
        }),
      }),
      "workspace-1",
    );
    expect(open).toHaveBeenCalledWith("side-chat");
  });

  it.each([
    ["missing owner binding", { chat: undefined }],
    ["different workspace", { workspaceId: "other-workspace" }],
    ["missing participant", { participants: [] }],
  ])("fails closed for a %s", async (_label, patch) => {
    const source = {
      id: "source",
      workspaceId: "workspace-1",
      title: "Source",
      chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
      participants: [{ agentId: "mira", name: "Mira" }],
      facilitatorId: "mira",
      ...patch,
    } as never;
    await expect(
      openResponseSideChat({
        service: {} as never,
        runtime: {
          accountWorkspaceStatus: {
            activeContextOwner: { internalUserId: "user" },
          },
        } as never,
        room: source,
        workspaceId: "workspace-1",
        authorId: "mira",
        draft: "selected passage",
        isCurrent: () => true,
        open: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(sideChats.createSideChat).not.toHaveBeenCalled();
  });

  it("preserves unknown non-empty persisted JSON", async () => {
    drafts.loadRuntimeConversationDraft.mockResolvedValue({
      content: JSON.stringify({ legacyPayload: "keep me" }),
    });
    const open = vi.fn();

    await openResponseSideChat({
      service: {} as never,
      runtime: {
        accountWorkspaceStatus: {
          activeContextOwner: { internalUserId: "user" },
        },
      } as never,
      room: {
        id: "source",
        workspaceId: "workspace-1",
        title: "Source",
        chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
        participants: [{ agentId: "mira", name: "Mira" }],
        facilitatorId: "mira",
      } as never,
      workspaceId: "workspace-1",
      authorId: "mira",
      draft: "selected passage",
      isCurrent: () => true,
      open,
    });

    expect(drafts.saveRuntimeConversationDraft).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("side-chat");
  });

  it("stops before saving when the pane unmounts during draft loading", async () => {
    let current = true;
    drafts.loadRuntimeConversationDraft.mockImplementation(async () => {
      current = false;
      return null;
    });

    await expect(
      openResponseSideChat({
        service: {} as never,
        runtime: {
          accountWorkspaceStatus: {
            activeContextOwner: { internalUserId: "user" },
          },
        } as never,
        room: {
          id: "source",
          workspaceId: "workspace-1",
          title: "Source",
          chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
          participants: [{ agentId: "mira", name: "Mira" }],
          facilitatorId: "mira",
        } as never,
        workspaceId: "workspace-1",
        authorId: "mira",
        draft: "selected passage",
        isCurrent: () => current,
        open: vi.fn(),
      }),
    ).rejects.toThrow("changed");

    expect(drafts.saveRuntimeConversationDraft).not.toHaveBeenCalled();
  });

  it("stops when account identity changes after the Side Chat is created", async () => {
    let current = true;
    sideChats.createSideChat.mockImplementation(async () => {
      current = false;
      return { id: "side-chat", workspaceId: "workspace-1" };
    });

    await expect(
      openResponseSideChat({
        service: {} as never,
        runtime: {
          accountWorkspaceStatus: {
            activeContextOwner: { internalUserId: "user" },
          },
        } as never,
        room: {
          id: "source",
          workspaceId: "workspace-1",
          title: "Source",
          chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
          participants: [{ agentId: "mira", name: "Mira" }],
          facilitatorId: "mira",
        } as never,
        workspaceId: "workspace-1",
        authorId: "mira",
        draft: "selected passage",
        isCurrent: () => current,
        open: vi.fn(),
      }),
    ).rejects.toThrow("changed");

    expect(drafts.loadRuntimeConversationDraft).not.toHaveBeenCalled();
  });
});
