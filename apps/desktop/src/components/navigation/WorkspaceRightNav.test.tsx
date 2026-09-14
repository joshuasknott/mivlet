import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
} from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import {
  WorkspaceRightNav,
  type NavContext,
} from "./WorkspaceRightNav";

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
const item = (patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
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
    { id: "mine", kind: "fact", title: "Writing", value: "Short replies", source: "You", freshness: "Today", approved: true, pinned: false, scope: { level: "agent", agentId: "agent" } },
    { id: "theirs", kind: "fact", title: "Other", value: "Other value", source: "You", freshness: "Today", approved: true, pinned: false, scope: { level: "agent", agentId: "other" } },
    { id: "global", kind: "fact", title: "Global", value: "Global value", source: "You", freshness: "Today", approved: true, pinned: false },
  ],
  connectorManifests: [],
} as unknown as ShellRuntime;
const base = {
  rooms: [
    room({ id: "side", title: "Side chat", chat: { role: "side", ownerKind: "agent", ownerId: "agent" } }),
    room({ id: "main", projectId: "project", kind: "group", title: "Launch main" }),
    room({ id: "pside", projectId: "project", kind: "group", title: "Launch side", chat: { role: "side", ownerKind: "project", ownerId: "project" } }),
  ],
  work: [item({ id: "a" }), item({ id: "b", agentId: "other", agentName: "Theo", projectId: "project", conversationId: "pside", status: "completed" })],
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

describe("contextual right navigation", () => {
  it("shows agent sections with scoped memory and work", () => {
    render(<WorkspaceRightNav {...context({ kind: "agent", agent })} />);
    expect(screen.getByRole("button", { name: "New side chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Side chat" })).toBeVisible();
    const work = screen.getByRole("region", { name: "Work" });
    expect(within(work).getByText("Original request")).toBeVisible();
    // The other agent's queued work is out of scope here.
    expect(within(work).queryByText("Theo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
    const memory = screen.getByRole("region", { name: "Memory" });
    expect(within(memory).getByText("2 in scope for this agent.")).toBeVisible();
  });

  it("scopes project sections and never lists the main chat as a side chat", () => {
    render(
      <WorkspaceRightNav
        {...context({ kind: "project", project })}
        team={{ projectId: "project", participantIds: ["agent"], leadAgentId: "agent", revision: 1 }}
        onSchedules={vi.fn()}
      />,
    );
    expect(screen.queryByText("Launch main")).toBeNull();
    const chats = screen.getByRole("region", { name: "Side Chats" });
    expect(within(chats).getByText("Launch side")).toBeVisible();
    expect(within(chats).queryByText("Launch main")).toBeNull();
    const work = screen.getByRole("region", { name: "Work" });
    expect(within(work).queryByText("Mira")).toBeNull();
    expect(screen.getByRole("button", { name: "View schedules" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Team/ }));
    expect(screen.getByText("Lead: Mira")).toBeVisible();
  });

  it("opens one work item into its detailed view and back", () => {
    const onOpenWork = vi.fn();
    render(
      <WorkspaceRightNav
        {...context({ kind: "agent", agent })}
        onOpenWork={onOpenWork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Work details" }));
    expect(onOpenWork).toHaveBeenCalledWith("a");
  });

  it("renders the selected work item with its original request and recovery", () => {
    const onOpenWork = vi.fn();
    const { container } = render(
      <WorkspaceRightNav
        {...context({ kind: "work", item: item({ id: "a" }) })}
        onOpenWork={onOpenWork}
      />,
    );
    const requests = [...container.querySelectorAll("p.work-details-request")].map(
      (node) => node.textContent,
    );
    expect(requests).toEqual(["Original request", "Assignment"]);
    expect(screen.getByText("Computer status unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to context" }));
    expect(onOpenWork).toHaveBeenCalledWith(null);
  });

  it("keeps the attention summary scoped to the context", () => {
    const onOpenConversation = vi.fn();
    render(
      <WorkspaceRightNav
        {...context({ kind: "project", project })}
        onOpenConversation={onOpenConversation}
      />,
    );
    // Only the project's failed work is pinned; the agent's failed work is out of scope.
    expect(screen.queryByRole("heading", { name: "Work needing attention" })).toBeNull();
  });
});
