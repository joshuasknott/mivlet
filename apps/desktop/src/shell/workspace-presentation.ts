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
import type { AgentSidebarPreview } from "../components/agents/AgentSidebar";
import type { NewAction } from "../components/conversation/ConversationTabs";
import type { NavContext } from "../components/navigation/WorkspaceRightNav";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import type { RightPanelTab } from "../components/navigation/right-panel-state";
import { agentPresence, type AgentPresence } from "../lib/agent-presence";
import {
  navigationTargetFor,
  type SearchNavigationTarget,
} from "../lib/search/navigation";
import { workPresentation } from "../components/work/WorkStatusBadge";
import {
  activeWork,
  type ExecutionSession,
} from "../lib/workspace-execution";

export type TeammateWorkspaceGate = "loading" | "onboarding" | "active";

/** Account owner decides loading, onboarding, or the live execution workspace. */
export function teammateWorkspaceGate(input: {
  accountWorkspacePending: boolean;
  runtimeSnapshotReady: boolean;
  runtimeSnapshotError: string | null;
  account: AccountWorkspaceStatus;
  onboardingRequired: boolean;
}): TeammateWorkspaceGate {
  if (
    input.accountWorkspacePending ||
    (!input.runtimeSnapshotReady &&
      !input.runtimeSnapshotError &&
      input.account.accountBound)
  )
    return "loading";
  if (
    !input.account.accountBound ||
    !["ready", "offline"].includes(input.account.state) ||
    input.account.activeWorkspace.source !== "local" ||
    input.onboardingRequired
  )
    return "onboarding";
  return "active";
}

export function activeWorkspaceScope(account: AccountWorkspaceStatus): string {
  return `${account.activeWorkspace.localWorkspaceId}:${account.activeContextOwner?.internalUserId}:${account.activeContextOwner?.memberId ?? ""}`;
}

export function workspaceProfileName(identity: IdentityStatus): string {
  return (
    identity.authentication?.verifiedDisplayAttributes?.displayName ??
    identity.authentication?.verifiedDisplayAttributes?.email ??
    "Local workspace"
  );
}

export function latestRoomRunId(
  roomId: string,
  work: CollaborationWorkItem[],
): string {
  return (
    work
      .filter((item) => item.conversationId === roomId)
      .flatMap((item) => item.outputs)
      .at(-1)?.runId ?? ""
  );
}

export function conversationIndicators(
  conversations: ConversationRoom[],
  work: CollaborationWorkItem[],
  seen: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    conversations.map((room) => {
      const roomWork = work.filter((item) => item.conversationId === room.id);
      const latest = roomWork.at(-1);
      const needsInput = roomWork.some((item) =>
        ["awaiting-user", "blocked"].includes(item.status),
      );
      return [
        room.id,
        roomWork.some((item) => item.status === "awaiting-approval")
          ? "Approval needed"
          : roomWork.some(activeWork)
            ? "Working"
            : needsInput || latest?.status === "failed"
              ? "Needs attention"
              : latest?.outputs.at(-1)?.runId &&
                  seen.get(room.id) !== latest.outputs.at(-1)?.runId
                ? "Unread"
                : "",
      ];
    }),
  );
}

export function agentSidebarPreviews(input: {
  agents: MivletAgentProfile[];
  work: CollaborationWorkItem[];
  sessions: ExecutionSession[];
  openApprovals: { id: string }[];
}): Record<string, AgentSidebarPreview> {
  const { agents, work, sessions, openApprovals } = input;
  return Object.fromEntries(
    agents.map((agent) => {
      const agentWork = work.filter((item) => item.agentId === agent.id);
      const current = agentWork.find(activeWork) ?? agentWork.at(-1);
      const session = sessions.find(
        (entry) => entry.work.agentId === agent.id && entry.state,
      );
      const awaitingApproval = session
        ? openApprovals.some((approval) =>
            session.approvalIds.has(approval.id),
          )
        : current?.status === "awaiting-approval";
      const presence: AgentPresence = session?.state
        ? agentPresence(
            session.state,
            awaitingApproval,
            session.work.status === "queued",
          )
        : awaitingApproval
          ? "waiting"
          : current?.status === "awaiting-user"
            ? "input"
            : current && ["failed", "blocked"].includes(current.status)
              ? "blocked"
              : current?.status === "queued"
                ? "received"
                : current && activeWork(current)
                  ? "working"
                  : "idle";
      return [
        agent.id,
        {
          message: current
            ? workPresentation(current).label
            : "Open a conversation",
          time: "",
          presence,
          status:
            awaitingApproval ||
            (current &&
              ["failed", "blocked", "awaiting-user"].includes(current.status))
              ? "attention"
              : current && activeWork(current)
                ? "running"
                : "idle",
        },
      ];
    }),
  );
}

export function conversationTabMeta(
  conversations: ConversationRoom[],
  projects: LocalProject[],
): {
  titles: Record<string, string>;
  descriptions: Record<string, string>;
} {
  return {
    titles: Object.fromEntries(
      conversations.map((room) => [room.id, room.title]),
    ),
    descriptions: Object.fromEntries(
      conversations.map((room) => [
        room.id,
        [
          projects.find((project) => project.id === room.projectId)?.name,
          room.participants.map((member) => member.name).join(", "),
        ]
          .filter(Boolean)
          .join(" · "),
      ]),
    ),
  };
}

export function contextualNewActionSpecs(input: {
  navContext: NavContext;
  navProject?: LocalProject;
}): { id: string; label: string }[] {
  if (input.navContext?.kind === "agent")
    return [
      {
        id: "side-chat",
        label: `New side chat with ${input.navContext.agent.name}`,
      },
    ];
  if (input.navProject)
    return [
      {
        id: "side-chat",
        label: `New side chat in ${input.navProject.name}`,
      },
    ];
  return [
    { id: "agent", label: "New agent" },
    { id: "project", label: "New project" },
  ];
}

export function contextualNewActions(input: {
  navContext: NavContext;
  navProject?: LocalProject;
  onSideChat: () => void;
  onNewAgent: () => void;
  onNewProject: () => void;
}): NewAction[] {
  return contextualNewActionSpecs(input).map((spec) => ({
    ...spec,
    run:
      spec.id === "side-chat"
        ? input.onSideChat
        : spec.id === "agent"
          ? input.onNewAgent
          : input.onNewProject,
  }));
}

export type SideChatIntent =
  | { kind: "create"; draft: ConversationDraft; projectId?: string }
  | { kind: "dialog"; draft: Partial<ConversationDraft> };

export function sideChatIntent(input: {
  navContext: NavContext;
  navProject?: LocalProject;
  navTeam?: ProjectTeam;
  activeProfile?: MivletAgentProfile;
}): SideChatIntent {
  if (input.navContext?.kind === "agent")
    return {
      kind: "create",
      draft: {
        kind: "direct",
        title: `Side chat with ${input.navContext.agent.name}`,
        instructions: "",
        participantIds: [input.navContext.agent.id],
        facilitatorId: input.navContext.agent.id,
        shareHistory: false,
      },
    };
  if (input.navProject && input.navTeam)
    return {
      kind: "create",
      draft: {
        kind: "project",
        title: `Side chat in ${input.navProject.name}`,
        instructions: "",
        participantIds: input.navTeam.participantIds,
        facilitatorId: input.navTeam.leadAgentId ?? "",
        shareHistory: false,
      },
      projectId: input.navProject.id,
    };
  return {
    kind: "dialog",
    draft: {
      kind: "direct",
      ...(input.activeProfile
        ? {
            participantIds: [input.activeProfile.id],
            facilitatorId: input.activeProfile.id,
          }
        : {}),
    },
  };
}

export type NewConversationIntent =
  | { kind: "create"; draft: ConversationDraft; projectId?: string }
  | { kind: "select-agent"; agent: MivletAgentProfile }
  | { kind: "new-agent" };

export function newConversationIntent(input: {
  activeRoom?: ConversationRoom;
  activeProject?: LocalProject;
  activeProfile?: MivletAgentProfile;
}): NewConversationIntent {
  if (input.activeRoom && input.activeRoom.participants.length)
    return {
      kind: "create",
      draft: {
        kind: input.activeRoom.kind === "group" ? "project" : "direct",
        title: input.activeProject
          ? "New conversation"
          : input.activeRoom.kind === "group"
            ? input.activeRoom.title
            : "Conversation with " + (input.activeProfile?.name ?? "agent"),
        instructions: "",
        participantIds: input.activeRoom.participants.map(
          (member) => member.agentId,
        ),
        facilitatorId: input.activeRoom.facilitatorId ?? "",
        shareHistory: false,
      },
      projectId: input.activeRoom.projectId,
    };
  if (input.activeProfile)
    return { kind: "select-agent", agent: input.activeProfile };
  return { kind: "new-agent" };
}

export function continueConversationDraft(
  room: ConversationRoom,
  projectId: string | undefined,
  text?: string,
): { draft: ConversationDraft; projectId?: string; seedText?: string } {
  return {
    draft: {
      kind: room.kind === "group" ? "project" : "direct",
      title: text
        ? `${room.title.slice(0, 98)} · continued`
        : "New conversation",
      instructions: "",
      participantIds: room.participants.map((member) => member.agentId),
      facilitatorId: room.facilitatorId ?? "",
      shareHistory: false,
    },
    projectId,
    seedText: text,
  };
}

export function projectEditorDraft(
  activeProfile?: MivletAgentProfile,
): Partial<ConversationDraft> {
  return {
    kind: "project",
    ...(activeProfile ? { participantIds: [activeProfile.id] } : {}),
  };
}

export type SearchOpenPlan =
  | { kind: "unavailable" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "project"; threadId: string }
  | { kind: "work"; conversationId: string; workId: string }
  | { kind: "agent-room"; conversationId: string }
  | { kind: "agent-editor"; agentId: string }
  | { kind: "file-panel"; request: Extract<RightPanelTab, { kind: "file" }> };

export function planSearchOpen(input: {
  result: SearchResult;
  workspaceId: string;
  conversations: ConversationRoom[];
  knowledgeSources: KnowledgeSource[];
}): SearchOpenPlan {
  const target = navigationTargetFor(input.result);
  if (!target || target.workspaceId !== input.workspaceId)
    return { kind: "unavailable" };
  if (target.type === "conversation")
    return { kind: "conversation", conversationId: target.conversationId };
  if (target.type === "project")
    return { kind: "project", threadId: target.threadId };
  if (target.type === "work")
    return {
      kind: "work",
      conversationId: target.conversationId,
      workId: target.workId,
    };
  if (target.type === "agent") {
    const room = input.conversations.find(
      (entry) =>
        entry.chat?.role === "main" &&
        entry.chat.ownerKind === "agent" &&
        entry.chat.ownerId === target.agentId,
    );
    if (room) return { kind: "agent-room", conversationId: room.id };
    return { kind: "agent-editor", agentId: target.agentId };
  }
  const source =
    target.type === "knowledge-file"
      ? input.knowledgeSources.find(
          (entry) =>
            entry.id === target.sourceId &&
            !entry.deletedAt &&
            !entry.disabled,
        )
      : undefined;
  return {
    kind: "file-panel",
    request: {
      id: `file:${JSON.stringify(target)}`,
      kind: "file",
      target: target as Extract<
        SearchNavigationTarget,
        { type: "artifact" | "knowledge-file" }
      >,
      title: input.result.title,
      text:
        source?.contentPreview ??
        (target.type === "knowledge-file"
          ? "This source has no text preview."
          : undefined),
    },
  };
}
