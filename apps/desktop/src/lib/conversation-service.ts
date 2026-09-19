import type {
  CollaborationCommand,
  CollaborationSnapshot,
  ConversationRoom,
} from "@mivlet/protocol";

/**
 * Conversation-domain service for the durable main/Side Chat model. The shell's
 * execution service implements this port; views never talk to native directly.
 */
export interface ConversationCommandPort {
  command(command: CollaborationCommand): Promise<CollaborationSnapshot>;
}

export interface SideChatOwner {
  kind: "agent" | "project";
  id: string;
}

function isMainChat(room: ConversationRoom) {
  return room.chat?.role === "main";
}

function isSideChat(room: ConversationRoom) {
  return room.chat?.role === "side";
}

/** Main Chat resolution is deterministic: selection, reload and duplicate views agree. */
export function mainChatForAgent(
  rooms: readonly ConversationRoom[],
  agentId: string,
): ConversationRoom | undefined {
  return rooms.find(
    (room) =>
      isMainChat(room) &&
      room.chat?.ownerKind === "agent" &&
      room.chat.ownerId === agentId,
  );
}

export function projectMainChat(
  rooms: readonly ConversationRoom[],
  projectId: string,
): ConversationRoom | undefined {
  return rooms.find(
    (room) =>
      isMainChat(room) &&
      room.chat?.ownerKind === "project" &&
      room.chat.ownerId === projectId,
  );
}

export function sideChatsFor(
  rooms: readonly ConversationRoom[],
  owner: SideChatOwner,
): ConversationRoom[] {
  return rooms.filter(
    (room) =>
      isSideChat(room) &&
      room.chat?.ownerKind === owner.kind &&
      room.chat.ownerId === owner.id,
  );
}

export function searchConversations(
  rooms: readonly ConversationRoom[],
  query: string,
): ConversationRoom[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rooms];
  return rooms.filter((room) =>
    room.title.toLocaleLowerCase().includes(needle),
  );
}

/**
 * Side Chats are separate conversational contexts. They sort newest first and
 * split into active and archived groups; search never widens ownership.
 */
export function partitionSideChats(
  rooms: readonly ConversationRoom[],
  owner: SideChatOwner,
  query = "",
): { active: ConversationRoom[]; archived: ConversationRoom[] } {
  const owned = sideChatsFor(rooms, owner).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const matched = searchConversations(owned, query);
  return {
    active: matched.filter((room) => !room.archived),
    archived: matched.filter((room) => room.archived),
  };
}

export async function resolveMainChat(
  port: ConversationCommandPort,
  agentId: string,
): Promise<ConversationRoom> {
  const snapshot = await port.command({ action: "open-main-chat", agentId });
  const room = mainChatForAgent(snapshot.conversations, agentId);
  if (!room) {
    throw new Error(
      "This Agent's main Chat could not be resolved. Reload the workspace.",
    );
  }
  return room;
}

export interface SideChatCreateInput {
  /** Stable caller-provided identity; generated when omitted. */
  id?: string;
  title: string;
  owner: SideChatOwner;
  participantIds: string[];
  facilitatorId: string;
}

export async function createSideChat(
  port: ConversationCommandPort,
  input: SideChatCreateInput,
): Promise<ConversationRoom> {
  const id = input.id ?? `thread-${crypto.randomUUID()}`;
  const snapshot = await port.command({
    action: "create-conversation",
    id,
    title: input.title.trim() || "New Side Chat",
    kind: input.owner.kind === "project" ? "group" : "direct",
    participantIds: input.participantIds,
    facilitatorId: input.facilitatorId || undefined,
    projectId: input.owner.kind === "project" ? input.owner.id : undefined,
  });
  const room = snapshot.conversations.find((candidate) => candidate.id === id);
  if (!room) throw new Error("The Side Chat was not saved. Reload and retry.");
  return room;
}

export function renameSideChat(
  port: ConversationCommandPort,
  room: ConversationRoom,
  title: string,
) {
  return port.command({
    action: "rename-conversation",
    id: room.id,
    expectedRevision: room.revision,
    title: title.trim(),
  });
}

export function setSideChatArchived(
  port: ConversationCommandPort,
  room: ConversationRoom,
  archived: boolean,
) {
  return port.command({
    action: "set-conversation-archived",
    id: room.id,
    expectedRevision: room.revision,
    archived,
  });
}

export function deleteSideChat(
  port: ConversationCommandPort,
  room: ConversationRoom,
) {
  return port.command({
    action: "delete-conversation",
    id: room.id,
    expectedRevision: room.revision,
  });
}
