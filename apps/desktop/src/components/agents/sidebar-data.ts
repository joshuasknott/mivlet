import type { CollaborationWorkItem, MivletAgentProfile, ProjectTeam } from "@mivlet/protocol";

export interface AgentSidebarProject {
  id: string;
  name: string;
  threadId?: string;
  updatedAt?: string;
}
export interface SidebarRoom {
  id: string;
  title: string;
  kind: "direct" | "group";
  projectId?: string;
  participants?: { agentId: string; name?: string }[];
  updatedAt?: string;
  archived?: boolean;
  status?: string;
}
export interface SidebarAttention {
  id: string;
  conversationId: string;
  agentId: string;
  label: string;
  detail: string;
  kind: "approval" | "input" | "blocked";
  count: number;
}

/** Activity is metadata only: no timestamps or private message excerpts in the nav. */
export function sidebarActivity(projects: AgentSidebarProject[], conversations: SidebarRoom[], work: CollaborationWorkItem[]) {
  const project = new Map<string, number>(), agent = new Map<string, number>();
  const mainProjects = new Map(projects.map((item) => [item.threadId, item.id]));
  const roomProjects = new Map<string, string>();
  const update = (map: Map<string, number>, id: string | undefined, date: string | undefined) => {
    const time = date ? Date.parse(date) : 0;
    if (id && Number.isFinite(time)) map.set(id, Math.max(map.get(id) ?? 0, time));
  };
  for (const item of projects) update(project, item.id, item.updatedAt);
  for (const room of conversations) {
    const projectId = room.projectId ?? mainProjects.get(room.id);
    if (projectId) roomProjects.set(room.id, projectId);
    update(project, projectId, room.updatedAt);
    for (const member of room.participants ?? []) update(agent, member.agentId, room.updatedAt);
  }
  for (const item of work) {
    update(project, item.projectId ?? roomProjects.get(item.conversationId), item.updatedAt);
    update(agent, item.agentId, item.updatedAt);
  }
  return { project, agent };
}

export function sidebarProjectMembers(projects: AgentSidebarProject[], agents: MivletAgentProfile[], conversations: SidebarRoom[], teams: ProjectTeam[]) {
  const profiles = new Map(agents.map((agent) => [agent.id, agent]));
  const currentTeams = new Map(teams.map((team) => [team.projectId, team.participantIds]));
  return new Map(projects.map((project) => {
    // Current Team membership is authoritative; old side chats may retain former members.
    const ids = currentTeams.get(project.id) ?? conversations
      .filter((room) => room.id === project.threadId || room.projectId === project.id)
      .flatMap((room) => room.participants?.map((member) => member.agentId) ?? []);
    return [project.id, [...new Set(ids)].flatMap((id) => profiles.get(id) ? [profiles.get(id)!] : [])];
  }));
}

export function sidebarAttention(
  work: CollaborationWorkItem[],
  sessions: { work: { id: string }; approvalIds: ReadonlySet<string> }[],
  openApprovals: { id: string }[],
  conversations: SidebarRoom[],
): SidebarAttention[] {
  const rooms = new Map(conversations.map((room) => [room.id, room]));
  const approvals = new Set(openApprovals.map((approval) => approval.id));
  const liveCounts = new Map(sessions.map((session) => [session.work.id,
    [...session.approvalIds].filter((id) => approvals.has(id)).length]));
  return work.flatMap((item): SidebarAttention[] => {
    const room = rooms.get(item.conversationId);
    if (!room || ["completed", "cancelled"].includes(item.status)) return [];
    const liveCount = liveCounts.get(item.id) ?? 0;
    const kind = liveCount || item.status === "awaiting-approval" ? "approval"
      : item.status === "awaiting-user" ? "input"
      : item.status === "blocked" || item.awaitingUser ? "blocked" : null;
    if (!kind) return [];
    return [{ id: item.id, conversationId: room.id, agentId: item.agentId,
      label: room.title, detail: `${item.agentName} · ${kind === "approval" ? "Approval needed" : kind === "input" ? "Waiting for you" : "Blocked"}`,
      kind, count: kind === "approval" ? Math.max(1, liveCount) : 1 }];
  });
}
