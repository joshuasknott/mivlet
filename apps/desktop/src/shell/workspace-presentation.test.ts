import { describe, expect, it } from "vitest";
import type {
  AccountWorkspaceStatus,
  CollaborationWorkItem,
  ConversationRoom,
  IdentityStatus,
  KnowledgeSource,
  LocalProject,
  MivletAgentProfile,
  ProjectTeam,
  SearchResult,
} from "@mivlet/protocol";
import type { ExecutionSession } from "../lib/workspace-execution";
import {
  activeWorkspaceScope,
  agentSidebarPreviews,
  contextualNewActionSpecs,
  continueConversationDraft,
  conversationIndicators,
  conversationTabMeta,
  latestRoomRunId,
  newConversationIntent,
  planSearchOpen,
  projectEditorDraft,
  sideChatIntent,
  teammateWorkspaceGate,
  workspaceProfileName,
} from "./workspace-presentation";

const account = (
  patch: Partial<AccountWorkspaceStatus> = {},
): AccountWorkspaceStatus => ({
  configured: true,
  state: "ready",
  message: "",
  accountBound: true,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "ws",
    name: "Local workspace",
    source: "local",
  },
  devices: [],
  ...patch,
});

const room = (patch: Partial<ConversationRoom> = {}): ConversationRoom => ({
  id: "room",
  workspaceId: "ws",
  kind: "direct",
  title: "Chat with Mira",
  participants: [{ agentId: "mira", name: "Mira" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});

const work = (
  patch: Partial<CollaborationWorkItem> = {},
): CollaborationWorkItem => ({
  id: "work",
  rootId: "work",
  workspaceId: "ws",
  conversationId: "room",
  agentId: "mira",
  agentName: "Mira",
  prompt: "Do the thing",
  userRequest: "Do the thing",
  status: "completed",
  permissionMode: "trusted-scope",
  dependencies: [],
  waitingFor: [],
  prerequisites: [],
  awaitingUser: false,
  generation: 1,
  conversationGeneration: 1,
  contextRevision: 0,
  depth: 0,
  turnCount: 0,
  tokenUsage: 0,
  maxTurns: 12,
  maxTokens: 64000,
  runIds: ["run-1"],
  modelOptionId: "fixture::model",
  outputs: [
    {
      runId: "run-1",
      conversationId: "room",
      text: "Done",
      evidence: "agent-report",
      createdAt: "2026-09-12T10:00:00Z",
    },
  ],
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});

const agent = (
  patch: Partial<MivletAgentProfile> = {},
): MivletAgentProfile => ({
  id: "mira",
  name: "Mira",
  instructions: "Help.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
  ...patch,
});

const project: LocalProject = {
  shares: [],
  id: "project",
  workspaceId: "ws",
  name: "Launch",
  threadId: "main",
  instructions: "Ship it.",
  knowledgeSourceIds: [],
  revision: 1,
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
};

const team: ProjectTeam = {
  projectId: "project",
  leadAgentId: "mira",
  participantIds: ["mira", "ava"],
  revision: 1,
};

const search = (
  objectKind: SearchResult["objectKind"],
  id: string,
  context: SearchResult["context"] = {},
): SearchResult => ({
  reference: { workspaceId: "ws", kind: objectKind, id },
  objectKind,
  title: "Title",
  snippet: "snippet",
  matchedField: "title",
  score: 1,
  archived: false,
  context,
});

describe("teammate workspace composition gates", () => {
  it("opens loading until a bound snapshot is ready", () => {
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: true,
        runtimeSnapshotReady: false,
        runtimeSnapshotError: null,
        account: account(),
        onboardingRequired: false,
      }),
    ).toBe("loading");
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: false,
        runtimeSnapshotError: null,
        account: account(),
        onboardingRequired: false,
      }),
    ).toBe("loading");
  });

  it("keeps onboarding when the local workspace is not ready", () => {
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: true,
        runtimeSnapshotError: null,
        account: account({ accountBound: false, state: "signed-out" }),
        onboardingRequired: false,
      }),
    ).toBe("onboarding");
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: true,
        runtimeSnapshotError: null,
        account: account({
          activeWorkspace: {
            localWorkspaceId: "ws",
            name: "Hosted",
            source: "hosted",
          },
        }),
        onboardingRequired: false,
      }),
    ).toBe("onboarding");
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: true,
        runtimeSnapshotError: null,
        account: account(),
        onboardingRequired: true,
      }),
    ).toBe("onboarding");
  });

  it("activates a ready or offline local workspace", () => {
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: true,
        runtimeSnapshotError: null,
        account: account(),
        onboardingRequired: false,
      }),
    ).toBe("active");
    expect(
      teammateWorkspaceGate({
        accountWorkspacePending: false,
        runtimeSnapshotReady: true,
        runtimeSnapshotError: "stale",
        account: account({ state: "offline" }),
        onboardingRequired: false,
      }),
    ).toBe("active");
  });

  it("scopes the live workspace by local id and context owner", () => {
    expect(
      activeWorkspaceScope(
        account({
          activeContextOwner: { internalUserId: "user", memberId: "member" },
        }),
      ),
    ).toBe("ws:user:member");
    expect(activeWorkspaceScope(account())).toBe("ws:undefined:");
  });

  it("prefers verified display name, then email, then the local fallback", () => {
    const identity = (authentication?: IdentityStatus["authentication"]) =>
      ({
        enabled: true,
        state: "signed-in",
        message: "",
        scopes: [],
        authentication,
      }) satisfies IdentityStatus;
    expect(workspaceProfileName(identity())).toBe("Local workspace");
    expect(
      workspaceProfileName(
        identity({
          provider: "clerk",
          subject: "sub",
          verifiedDisplayAttributes: { email: "ada@example.com" },
        } as IdentityStatus["authentication"]),
      ),
    ).toBe("ada@example.com");
  });
});

describe("conversation chrome presentation", () => {
  it("ranks approval, active work, attention, and unread without mutating seen", () => {
    const seen = new Map<string, string>([["room", "run-0"]]);
    expect(
      conversationIndicators(
        [room()],
        [work({ status: "awaiting-approval" })],
        seen,
      ).room,
    ).toBe("Approval needed");
    expect(
      conversationIndicators([room()], [work({ status: "running" })], seen)
        .room,
    ).toBe("Working");
    expect(
      conversationIndicators(
        [room()],
        [work({ status: "awaiting-user" })],
        seen,
      ).room,
    ).toBe("Needs attention");
    expect(
      conversationIndicators([room()], [work({ status: "failed" })], seen)
        .room,
    ).toBe("Needs attention");
    expect(conversationIndicators([room()], [work()], seen).room).toBe(
      "Unread",
    );
    expect(
      conversationIndicators(
        [room()],
        [work()],
        new Map([["room", "run-1"]]),
      ).room,
    ).toBe("");
    expect(latestRoomRunId("room", [work()])).toBe("run-1");
  });

  it("keeps sidebar presence in the same approval-over-work order", () => {
    const idle = agentSidebarPreviews({
      agents: [agent()],
      work: [],
      sessions: [],
      openApprovals: [],
    }).mira;
    expect(idle).toMatchObject({
      message: "Open a conversation",
      presence: "idle",
      status: "idle",
    });
    const queued = agentSidebarPreviews({
      agents: [agent()],
      work: [work({ status: "queued" })],
      sessions: [],
      openApprovals: [],
    }).mira;
    expect(queued).toMatchObject({
      presence: "received",
      status: "running",
    });
    const session = {
      key: "session",
      work: work({ status: "running" }),
      approvalIds: new Set(["approval-1"]),
      state: { running: true, status: "awaiting-approval" },
    } as unknown as ExecutionSession;
    const waiting = agentSidebarPreviews({
      agents: [agent()],
      work: [work({ status: "running" })],
      sessions: [session],
      openApprovals: [{ id: "approval-1" }],
    }).mira;
    expect(waiting).toMatchObject({
      presence: "waiting",
      status: "attention",
    });
  });

  it("joins project name and participants for tab descriptions", () => {
    expect(
      conversationTabMeta(
        [room({ projectId: "project" })],
        [project],
      ).descriptions.room,
    ).toBe("Launch · Mira");
  });
});

describe("new conversation and side-chat intents", () => {
  it("names contextual New actions after the selected agent or project", () => {
    expect(
      contextualNewActionSpecs({
        navContext: { kind: "agent", agent: agent() },
      }),
    ).toEqual([
      { id: "side-chat", label: "New side chat with Mira" },
    ]);
    expect(
      contextualNewActionSpecs({
        navContext: { kind: "project", project },
        navProject: project,
      }),
    ).toEqual([{ id: "side-chat", label: "New side chat in Launch" }]);
    expect(
      contextualNewActionSpecs({ navContext: null }),
    ).toEqual([
      { id: "agent", label: "New agent" },
      { id: "project", label: "New project" },
    ]);
  });

  it("creates a side chat for agent or project context, else opens a dialog", () => {
    expect(
      sideChatIntent({
        navContext: { kind: "agent", agent: agent() },
      }),
    ).toMatchObject({
      kind: "create",
      draft: {
        kind: "direct",
        title: "Side chat with Mira",
        participantIds: ["mira"],
        facilitatorId: "mira",
      },
    });
    expect(
      sideChatIntent({
        navContext: { kind: "project", project },
        navProject: project,
        navTeam: team,
      }),
    ).toMatchObject({
      kind: "create",
      projectId: "project",
      draft: {
        kind: "project",
        title: "Side chat in Launch",
        participantIds: ["mira", "ava"],
        facilitatorId: "mira",
      },
    });
    expect(sideChatIntent({ navContext: null, activeProfile: agent() })).toEqual({
      kind: "dialog",
      draft: {
        kind: "direct",
        participantIds: ["mira"],
        facilitatorId: "mira",
      },
    });
  });

  it("continues the active room, else starts with the selected agent", () => {
    expect(
      newConversationIntent({
        activeRoom: room({ kind: "group", title: "Launch chat", projectId: "project" }),
        activeProject: project,
        activeProfile: agent(),
      }),
    ).toMatchObject({
      kind: "create",
      projectId: "project",
      draft: { kind: "project", title: "New conversation" },
    });
    expect(
      newConversationIntent({
        activeRoom: room(),
        activeProfile: agent(),
      }),
    ).toMatchObject({
      kind: "create",
      draft: {
        kind: "direct",
        title: "Conversation with Mira",
      },
    });
    expect(newConversationIntent({ activeProfile: agent() })).toEqual({
      kind: "select-agent",
      agent: agent(),
    });
    expect(newConversationIntent({})).toEqual({ kind: "new-agent" });
    expect(continueConversationDraft(room(), "project", "keep going")).toEqual({
      draft: {
        kind: "direct",
        title: "Chat with Mira · continued",
        instructions: "",
        participantIds: ["mira"],
        facilitatorId: "",
        shareHistory: false,
      },
      projectId: "project",
      seedText: "keep going",
    });
    expect(projectEditorDraft(agent())).toEqual({
      kind: "project",
      participantIds: ["mira"],
    });
  });
});

describe("search open plans", () => {
  it("opens existing conversations, projects, work, and agent main chats", () => {
    const conversations = [
      room({
        id: "main-mira",
        chat: { role: "main", ownerKind: "agent", ownerId: "mira" },
      }),
    ];
    expect(
      planSearchOpen({
        result: search("conversation", "room", { conversationId: "room" }),
        workspaceId: "ws",
        conversations,
        knowledgeSources: [],
      }),
    ).toEqual({ kind: "conversation", conversationId: "room" });
    expect(
      planSearchOpen({
        result: search("project", "project", {
          projectId: "project",
          threadId: "main",
        }),
        workspaceId: "ws",
        conversations,
        knowledgeSources: [],
      }),
    ).toEqual({ kind: "project", threadId: "main" });
    expect(
      planSearchOpen({
        result: search("work", "work", {
          workId: "work",
          conversationId: "room",
        }),
        workspaceId: "ws",
        conversations,
        knowledgeSources: [],
      }),
    ).toEqual({
      kind: "work",
      conversationId: "room",
      workId: "work",
    });
    expect(
      planSearchOpen({
        result: search("agent", "mira", { agentId: "mira" }),
        workspaceId: "ws",
        conversations,
        knowledgeSources: [],
      }),
    ).toEqual({ kind: "agent-room", conversationId: "main-mira" });
    expect(
      planSearchOpen({
        result: search("agent", "ava", { agentId: "ava" }),
        workspaceId: "ws",
        conversations,
        knowledgeSources: [],
      }),
    ).toEqual({ kind: "agent-editor", agentId: "ava" });
  });

  it("refuses foreign workspaces and previews knowledge files without creating", () => {
    expect(
      planSearchOpen({
        result: {
          ...search("conversation", "room"),
          reference: {
            workspaceId: "other",
            kind: "conversation",
            id: "room",
          },
        },
        workspaceId: "ws",
        conversations: [],
        knowledgeSources: [],
      }),
    ).toEqual({ kind: "unavailable" });
    const source: KnowledgeSource = {
      id: "source",
      title: "Notes",
      kind: "document",
      connectorId: "local-files",
      provenance: "local",
      freshness: "current",
      pinned: false,
      contentPreview: "Preview text",
    };
    const plan = planSearchOpen({
      result: search("file", "source", { sourceId: "source" }),
      workspaceId: "ws",
      conversations: [],
      knowledgeSources: [source],
    });
    expect(plan).toMatchObject({
      kind: "file-panel",
      request: {
        kind: "file",
        title: "Title",
        text: "Preview text",
      },
    });
    expect(
      planSearchOpen({
        result: search("file", "missing", { sourceId: "missing" }),
        workspaceId: "ws",
        conversations: [],
        knowledgeSources: [],
      }),
    ).toMatchObject({
      kind: "file-panel",
      request: { text: "This source has no text preview." },
    });
  });
});
