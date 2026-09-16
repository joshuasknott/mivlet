import type {
  CollaborationCommand,
  CollaborationSnapshot,
  ConversationRoom,
  KnowledgeScope,
  MemoryControlState,
  MemoryRecord,
} from "@mivlet/protocol";
import { redactSecretTextOrOmit } from "@mivlet/protocol";
import { loadRuntimeMemoryState, saveRuntimeMemoryState } from "../runtime/domains/memory";

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

/** Baseline Memory interface. P6 owns its internals; P3 only promotes records. */
export interface MemoryPromotionPorts {
  load(): Promise<MemoryControlState | null>;
  save(state: MemoryControlState): Promise<MemoryControlState | null>;
}

export const runtimeMemoryPorts: MemoryPromotionPorts = {
  load: loadRuntimeMemoryState,
  save: saveRuntimeMemoryState,
};

export interface ConversationConclusionInput {
  conversation: Pick<ConversationRoom, "id" | "title">;
  title: string;
  value: string;
  /** Narrow scopes only: a promoted conclusion never becomes account-global. */
  scope: { level: "thread" | "agent" | "project"; id: string };
  promotedAt: string;
}

function conclusionScope(
  scope: ConversationConclusionInput["scope"],
): KnowledgeScope {
  switch (scope.level) {
    case "thread":
      return { level: "thread", threadId: scope.id };
    case "agent":
      return { level: "agent", agentId: scope.id };
    case "project":
      return { level: "project", projectId: scope.id };
  }
}

/**
 * Promotion is a deliberate user action: exactly one approved record with
 * retained provenance enters the selected scope. Transcript text is never
 * summarized or promoted automatically.
 */
export async function promoteConversationConclusion(
  ports: MemoryPromotionPorts,
  input: ConversationConclusionInput,
): Promise<MemoryRecord> {
  const title = redactSecretTextOrOmit(input.title.trim());
  const value = redactSecretTextOrOmit(input.value.trim());
  if (!title || !value) {
    throw new Error("Add a title and the conclusion before saving it to Memory.");
  }
  if (input.title.trim().length > 120 || input.value.trim().length > 2_000) {
    throw new Error(
      "Use a title up to 120 characters and a conclusion up to 2,000 characters.",
    );
  }
  const state = await ports.load();
  if (!state) {
    throw new Error("Memory is unavailable. Open the installed app and retry.");
  }
  if (state.disabled) {
    throw new Error(
      "Memory is disabled. Enable it in Settings before promoting a conclusion.",
    );
  }
  const record: MemoryRecord = {
    id: `memory-chat-${crypto.randomUUID()}`,
    kind: "fact",
    title,
    value,
    source: `Promoted from “${input.conversation.title}”`,
    freshness: "Promoted now",
    approved: true,
    pinned: false,
    scope: conclusionScope(input.scope),
    confidence: 1,
    provenance: {
      origin: "chat",
      sourceId: input.conversation.id,
      note: `You promoted a conclusion from ${input.conversation.title}.`,
    },
    approvalState: "approved",
    createdAt: input.promotedAt,
    updatedAt: input.promotedAt,
  };
  const saved = await ports.save({
    disabled: state.disabled,
    records: [record, ...state.records],
  });
  if (!saved) {
    throw new Error("Mivlet could not save this conclusion to Memory.");
  }
  return record;
}
