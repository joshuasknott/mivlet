import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import {
  createWorkspaceRoom,
  saveWorkspaceDraft,
  selectWorkspaceAgent,
  updateWorkspaceProject,
} from "./workspace-actions";

const localProjects = vi.hoisted(() => ({
  createLocalProject: vi.fn(),
  updateLocalProject: vi.fn(),
}));
const drafts = vi.hoisted(() => ({
  saveRuntimeConversationDraft: vi.fn(),
}));

vi.mock("../runtime/domains/local-projects", () => localProjects);
vi.mock("../runtime/domains/conversations", () => drafts);

const draft: ConversationDraft = {
  kind: "direct",
  title: "Conversation with Mira",
  instructions: "",
  participantIds: ["mira"],
  facilitatorId: "mira",
  shareHistory: false,
};

function serviceStub(conversations: unknown[] = [], teams: unknown[] = []) {
  return {
    refresh: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      data: { conversations, teams, work: [], facts: [], authors: [], layout: null },
    })),
    command: vi.fn(async () => ({
      conversations,
      teams,
      work: [],
      facts: [],
      authors: [],
      layout: null,
    })),
  } as unknown as WorkspaceExecution;
}

function runtimeStub(): ShellRuntime {
  return {
    flushSnapshot: vi.fn(async () => undefined),
    accountWorkspaceStatus: {
      activeContextOwner: { internalUserId: "user", memberId: "member" },
      activeWorkspace: { localWorkspaceId: "ws" },
    },
  } as unknown as ShellRuntime;
}

describe("workspace room actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localProjects.createLocalProject.mockReset();
    localProjects.updateLocalProject.mockReset();
    drafts.saveRuntimeConversationDraft.mockReset();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("creates a direct conversation, seeds the draft, and opens a new tab", async () => {
    const service = serviceStub();
    const open = vi.fn();
    const saveDraft = vi.fn(async () => undefined);
    const id = await createWorkspaceRoom(
      {
        runtime: runtimeStub(),
        service,
        workspaceId: "ws",
        projects: { projects: [], setProjects: vi.fn() },
        open,
        saveDraft,
      },
      draft,
      undefined,
      "hello",
    );
    expect(id).toBe("thread-11111111-1111-4111-8111-111111111111");
    expect(service.command).toHaveBeenCalledWith({
      action: "create-conversation",
      id,
      title: draft.title,
      kind: "direct",
      participantIds: ["mira"],
      facilitatorId: "mira",
      projectId: undefined,
    });
    expect(saveDraft).toHaveBeenCalledWith(id, "mira", "hello", undefined);
    expect(open).toHaveBeenCalledWith(id, true);
  });

  it("creates a project room by saving the project then updating its team", async () => {
    const created = {
      id: "project-11111111-1111-4111-8111-111111111111",
      name: "Launch",
    };
    localProjects.createLocalProject.mockResolvedValue(created);
    const setProjects = vi.fn();
    const service = serviceStub([], [
      { projectId: created.id, revision: 3 },
    ]);
    const id = await createWorkspaceRoom(
      {
        runtime: runtimeStub(),
        service,
        workspaceId: "ws",
        projects: { projects: [], setProjects },
        open: vi.fn(),
        saveDraft: vi.fn(async () => undefined),
      },
      {
        kind: "project",
        title: "Launch",
        instructions: "Ship it.",
        participantIds: ["mira"],
        facilitatorId: "mira",
        shareHistory: false,
      },
    );
    expect(localProjects.createLocalProject).toHaveBeenCalledWith({
      workspaceId: "ws",
      id: created.id,
      threadId: id,
      name: "Launch",
      instructions: "Ship it.",
      knowledgeSourceIds: [],
    });
    expect(service.command).toHaveBeenCalledWith({
      action: "update-team",
      projectId: created.id,
      expectedRevision: 3,
      participantIds: ["mira"],
      leadAgentId: "mira",
      shareHistory: true,
    });
    expect(setProjects).toHaveBeenCalled();
  });

  it("opens an existing main chat unless a new conversation is requested", async () => {
    const conversations = [
      {
        id: "main",
        chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
      },
    ];
    const service = serviceStub(conversations);
    const open = vi.fn();
    const createRoom = vi.fn(async () => "new-thread");
    const runtime = runtimeStub();
    await expect(
      selectWorkspaceAgent(
        { runtime, service, open, createRoom },
        {
          id: "mira",
          name: "Mira",
        } as never,
      ),
    ).resolves.toBe("main");
    expect(service.command).toHaveBeenCalledWith({
      action: "open-main-chat",
      agentId: "mira",
    });
    expect(open).toHaveBeenCalledWith("main");
    await selectWorkspaceAgent(
      { runtime, service, open, createRoom },
      { id: "mira", name: "Mira" } as never,
      true,
      "seed",
    );
    expect(createRoom).toHaveBeenCalledWith(
      {
        kind: "direct",
        title: "Conversation with Mira",
        instructions: "",
        participantIds: ["mira"],
        facilitatorId: "mira",
        shareHistory: false,
      },
      undefined,
      "seed",
    );
  });

  it("writes composer drafts under the account-scoped key", async () => {
    drafts.saveRuntimeConversationDraft.mockResolvedValue(undefined);
    await saveWorkspaceDraft(
      { runtime: runtimeStub(), workspaceId: "ws" },
      "thread-1",
      "mira",
      "hello",
    );
    expect(drafts.saveRuntimeConversationDraft).toHaveBeenCalled();
    const [payload, workspaceId] =
      drafts.saveRuntimeConversationDraft.mock.calls[0];
    expect(workspaceId).toBe("ws");
    expect(payload.threadId).toBe("thread-1");
    expect(JSON.parse(payload.content)).toEqual({
      text: "hello",
      attachments: [],
    });
  });

  it("updates a project through the native revision fence", async () => {
    const updated = { id: "project", name: "Renamed", revision: 2 };
    localProjects.updateLocalProject.mockResolvedValue(updated);
    const setProjects = vi.fn((updater) =>
      updater([{ id: "project", name: "Launch", revision: 1 }]),
    );
    const service = serviceStub();
    await updateWorkspaceProject(
      {
        workspaceId: "ws",
        projects: { projects: [], setProjects },
        service,
      },
      {
        id: "project",
        revision: 1,
      } as never,
      { name: "Renamed", instructions: "Go", knowledgeSourceIds: [] },
    );
    expect(localProjects.updateLocalProject).toHaveBeenCalledWith({
      workspaceId: "ws",
      id: "project",
      expectedRevision: 1,
      name: "Renamed",
      instructions: "Go",
      knowledgeSourceIds: [],
    });
    expect(service.refresh).toHaveBeenCalled();
  });
});
