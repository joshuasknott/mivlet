import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
} from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { WorkspaceRightNav, type NavContext } from "./WorkspaceRightNav";

vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

const agent: FableAgentProfile = {
  id: "agent",
  name: "Mira",
  instructions: "Help.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
};
const project: LocalProject = {
  shares: [],
  id: "project",
  workspaceId: "workspace",
  name: "Launch",
  threadId: "main",
  instructions: "Ship it.",
  knowledgeSourceIds: [],
  revision: 1,
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
};
const room = (patch: Partial<ConversationRoom> = {}): ConversationRoom => ({
  id: "room",
  workspaceId: "workspace",
  kind: "direct",
  title: "Room",
  participants: [{ agentId: "agent", name: "Mira" }],
  revision: 1,
  generation: 1,
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});
const item = (
  patch: Partial<CollaborationWorkItem> = {},
): CollaborationWorkItem => ({
  id: "work",
  rootId: "work",
  workspaceId: "workspace",
  conversationId: "room",
  agentId: "agent",
  agentName: "Mira",
  prompt: "Assignment",
  userRequest: "Original request",
  status: "failed",
  reason: "Computer status unavailable",
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
  runIds: [],
  modelOptionId: "codex::fixture",
  outputs: [],
  createdAt: "2026-09-12T10:00:00Z",
  updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});
const runtime = {
  agents: [agent],
  managedMemoryRecords: [
    {
      id: "mine",
      kind: "fact",
      title: "Writing",
      value: "Short replies",
      source: "You",
      freshness: "Today",
      approved: true,
      pinned: false,
      scope: { level: "agent", agentId: "agent" },
    },
    {
      id: "theirs",
      kind: "fact",
      title: "Other",
      value: "Other value",
      source: "You",
      freshness: "Today",
      approved: true,
      pinned: false,
      scope: { level: "agent", agentId: "other" },
    },
    {
      id: "global",
      kind: "fact",
      title: "Global",
      value: "Global value",
      source: "You",
      freshness: "Today",
      approved: true,
      pinned: false,
    },
  ],
  connectorManifests: [],
} as unknown as ShellRuntime;
const base = {
  rooms: [
    room({
      id: "side",
      title: "Side chat",
      chat: { role: "side", ownerKind: "agent", ownerId: "agent" },
    }),
    room({
      id: "main",
      projectId: "project",
      kind: "group",
      title: "Launch main",
    }),
    room({
      id: "pside",
      projectId: "project",
      kind: "group",
      title: "Launch side",
      chat: { role: "side", ownerKind: "project", ownerId: "project" },
    }),
  ],
  work: [
    item({ id: "a" }),
    item({
      id: "b",
      agentId: "other",
      agentName: "Theo",
      projectId: "project",
      conversationId: "pside",
      status: "completed",
    }),
  ],
  runtime,
  open: true,
  onClose: vi.fn(),
  onOpenConversation: vi.fn(),
  onNewSideChat: vi.fn(),
  onSchedules: vi.fn(),
  onOpenComputer: vi.fn(),
  onManageMemory: vi.fn(),
  onStopWork: vi.fn(),
  onContinueWork: vi.fn(),
  onSteerWork: vi.fn(),
};
const context = (value: NavContext) => ({ ...base, context: value });

describe("multifunctional right panel", () => {
  it("keeps utilities available while a document is open and deduplicates repeated opens", () => {
    const request = {
      id: "file:a",
      kind: "artifact" as const,
      title: "Launch brief",
      output: "file",
      agentId: "agent",
    };
    const props = {
      ...context({ kind: "agent", agent }),
      renderTab: () => <p>Document contents</p>,
    };
    const view = render(<WorkspaceRightNav {...props} request={request} />);
    expect(screen.getByText("Document contents")).toBeInTheDocument();
    for (const name of ["Files", "Side chats", "Schedules"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.queryByText("Document contents")).toBeNull();
    view.rerender(<WorkspaceRightNav {...props} request={{ ...request }} />);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByText("Document contents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Launch brief" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("shows only the selected owner's side chats", () => {
    const view = render(
      <WorkspaceRightNav {...context({ kind: "agent", agent })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Side chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Side chat" }));
    expect(base.onOpenConversation).toHaveBeenCalledWith("side");
    expect(screen.queryByText("Launch side")).toBeNull();
    view.rerender(
      <WorkspaceRightNav {...context({ kind: "project", project })} />,
    );
    expect(screen.getByText("Launch side")).toBeInTheDocument();
    expect(screen.queryByText("Side chat")).toBeNull();
    expect(screen.queryByText("Launch main")).toBeNull();
  });
  it("embeds schedules and removes the old inventory sections", () => {
    render(
      <WorkspaceRightNav
        {...context({ kind: "agent", agent })}
        schedules={<p>Create a routine</p>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedules" }));
    expect(screen.getByText("Create a routine")).toBeInTheDocument();
    for (const name of ["Memory", "Work", "Tools", "Approvals", "Team"])
      expect(screen.queryByRole("heading", { name })).toBeNull();
  });
  it("switches tabs by keyboard and closes onto the neighbouring document", () => {
    const first = {
      id: "web:a",
      kind: "web" as const,
      title: "Website",
      url: "https://example.com",
    };
    const props = {
      ...context(null),
      renderTab: (tab: { title: string }) => <p>{tab.title} contents</p>,
    };
    const view = render(<WorkspaceRightNav {...props} request={first} />);
    view.rerender(
      <WorkspaceRightNav
        {...props}
        request={{ id: "chat:b", kind: "chat", title: "Ideas", roomId: "side" }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Ideas" }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: "Website" })).toHaveFocus();
    expect(screen.getByText("Website contents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Website" }));
    expect(screen.getByText("Ideas contents")).toBeInTheDocument();
  });
  it("keeps background work untouched when the panel closes", () => {
    const onClose = vi.fn();
    render(<WorkspaceRightNav {...context(null)} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Close workspace panel" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(base.onStopWork).not.toHaveBeenCalled();
  });
  it("lists only validated files in the selected agent scope", () => {
    const output = (title: string) => ({
      runId: title,
      conversationId: "side",
      evidence: "agent-report" as const,
      createdAt: "2026-09-14T00:00:00Z",
      text: JSON.stringify({
        kind: "computer-artifact",
        version: 1,
        id: `artifact-${"a".repeat(64)}`,
        computerId: `local-${"b".repeat(24)}`,
        title,
        relativePath: "brief.md",
        mimeType: "text/markdown",
        sizeBytes: 20,
        createdAt: "2026-09-14T00:00:00Z",
      }),
    });
    render(
      <WorkspaceRightNav
        {...context({ kind: "agent", agent })}
        work={[
          item({ outputs: [output("My brief"), output("My brief")] }),
          item({ agentId: "other", outputs: [output("Private brief")] }),
        ]}
        renderTab={(tab) => <p>{tab.title} contents</p>}
      />,
    );
    expect(screen.getAllByRole("button", { name: "My brief" })).toHaveLength(1);
    expect(screen.queryByText("Private brief")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "My brief" }));
    expect(screen.getByText("My brief contents")).toBeInTheDocument();
  });
  it("releases side-chat focus when switching to a utility", () => {
    const active = vi.fn();
    render(
      <WorkspaceRightNav
        {...context(null)}
        request={{ id: "chat:a", kind: "chat", roomId: "a", title: "Ideas" }}
        onChatActiveChange={active}
      />,
    );
    expect(active).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(active).toHaveBeenLastCalledWith(false);
  });
});
