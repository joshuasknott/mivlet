import type {
  CollaborationWorkItem,
  ConversationRoom,
  LocalProject,
  MemoryRecord,
  ProjectTeam,
} from "@fable/protocol";
import { GLOBAL_SCOPE, type KnowledgeScope } from "@fable/protocol";
import { activeWork } from "../../lib/workspace-execution";

/** Work whose outcome blocks the person, ordered newest first. */
export const needsAttention = (work: CollaborationWorkItem) =>
  ["awaiting-approval", "awaiting-user", "failed", "blocked"].includes(
    work.status,
  );

/**
 * Attention first, then active work, then finished history. A completed item
 * can never push a pending approval or failure out of the first positions.
 */
export function attentionOrder(
  work: CollaborationWorkItem[],
): CollaborationWorkItem[] {
  return [...work].sort((a, b) => {
    const rank = (item: CollaborationWorkItem) =>
      needsAttention(item) ? 0 : activeWork(item) ? 1 : 2;
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (rank(a) === 1) return a.createdAt.localeCompare(b.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Work that belongs to the selected Agent or Project, never workspace-wide. */
export function scopeWork(
  work: CollaborationWorkItem[],
  context: { agentId?: string; projectId?: string },
): CollaborationWorkItem[] {
  return work.filter((item) =>
    context.projectId
      ? item.projectId === context.projectId
      : context.agentId
        ? item.agentId === context.agentId
        : true,
  );
}

/**
 * The exact scope levels a Memory record may claim for this context. Each level
 * is an equality on the owning object; nothing is widened to global and no
 * record from another Agent, Project, Chat or Work item matches.
 */
export function scopeLevelsFor(input: {
  agentId?: string;
  projectId?: string;
  roomIds?: string[];
  workIds?: string[];
}): KnowledgeScope[] {
  const scopes: KnowledgeScope[] = [GLOBAL_SCOPE];
  if (input.projectId) scopes.push({ level: "project", projectId: input.projectId });
  if (input.agentId) scopes.push({ level: "agent", agentId: input.agentId });
  for (const threadId of input.roomIds ?? [])
    scopes.push({ level: "thread", threadId });
  for (const workId of input.workIds ?? [])
    scopes.push({ level: "work", workId });
  return scopes;
}

/** True when a Memory record's exact scope is satisfied by one of the scopes. */
export function memoryInScope(
  record: Pick<MemoryRecord, "scope">,
  scopes: KnowledgeScope[],
): boolean {
  const scope = record.scope ?? GLOBAL_SCOPE;
  if (scope.level === "global") return true;
  return scopes.some(
    (candidate) =>
      candidate.level === scope.level &&
      scopeId(candidate) === scopeId(scope),
  );
}

function scopeId(scope: KnowledgeScope): string | undefined {
  switch (scope.level) {
    case "global":
      return undefined;
    case "thread":
      return scope.threadId;
    case "agent":
      return scope.agentId;
    case "project":
      return scope.projectId;
    case "work":
      return scope.workId;
  }
}

/** Side Chats stay subordinate to their owner; a project's main Chat and an
 * Agent's main Chat are never classified as a side chat. */
export function sideChatsFor(
  context:
    | { kind: "agent"; agentId: string }
    | { kind: "project"; project: Pick<LocalProject, "id" | "threadId"> }
    | null,
  rooms: ConversationRoom[],
): ConversationRoom[] {
  if (!context) return [];
  if (context.kind === "agent") {
    return rooms.filter((room) => {
      if (room.chat)
        return (
          room.chat.role === "side" &&
          room.chat.ownerKind === "agent" &&
          room.chat.ownerId === context.agentId
        );
      return (
        !room.projectId &&
        room.kind === "direct" &&
        room.participants.some((member) => member.agentId === context.agentId)
      );
    });
  }
  return rooms.filter(
    (room) =>
      room.projectId === context.project.id &&
      room.id !== context.project.threadId &&
      (!room.chat || room.chat.role === "side"),
  );
}

/** Rooms whose exact thread a memory record may claim for this context. */
export function scopedRoomIds(
  agentId: string | undefined,
  projectId: string | undefined,
  rooms: ConversationRoom[],
): string[] {
  return rooms
    .filter((room) =>
      projectId
        ? room.projectId === projectId
        : agentId
          ? room.facilitatorId === agentId ||
            room.participants.some((member) => member.agentId === agentId) ||
            (room.chat?.ownerKind === "agent" && room.chat.ownerId === agentId)
          : false,
    )
    .map((room) => room.id);
}

/** Durable Team section data for the selected Project. */
export function teamMembers(
  team: ProjectTeam | undefined,
  agents: { id: string; name: string }[],
): { lead?: string; participants: string[] } {
  if (!team) return { participants: [] };
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  return {
    lead: team.leadAgentId
      ? (names.get(team.leadAgentId) ?? team.leadAgentId)
      : undefined,
    participants: team.participantIds.map((id) => names.get(id) ?? id),
  };
}