import type {
  CollaborationWorkItem,
  ConversationRoom,
  LocalProject,
} from "@mivlet/protocol";
import { activeWork } from "../../lib/workspace-execution";

/** Work whose outcome blocks the person, ordered newest first. */
const needsAttention = (work: CollaborationWorkItem) =>
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
