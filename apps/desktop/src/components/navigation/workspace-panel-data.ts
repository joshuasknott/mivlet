import type {
  CollaborationWorkItem,
  ConversationRoom,
  KnowledgeSource,
  LocalProject,
  MemoryRecord,
  WorkAttachment,
} from "@mivlet/protocol";
import { isLiveSource } from "@mivlet/knowledge";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import type { RightPanelTab } from "./right-panel-state";

export function agentChatOwner(room: ConversationRoom): string | undefined {
  if (room.projectId || room.chat?.ownerKind === "project") return undefined;
  return room.chat?.ownerKind === "agent"
    ? room.chat.ownerId
    : (room.facilitatorId ??
        (room.participants.length === 1
          ? room.participants[0].agentId
          : undefined));
}

export function panelRooms(
  workspaceId: string,
  room: ConversationRoom | undefined,
): ConversationRoom[] {
  return room?.workspaceId === workspaceId ? [room] : [];
}

/** Include the effort's delegated assignments, but never a foreign workspace. */
export function panelWork(
  workspaceId: string,
  rooms: ConversationRoom[],
  work: CollaborationWorkItem[],
) {
  const roomIds = new Set(
    rooms
      .filter((room) => room.workspaceId === workspaceId)
      .map((room) => room.id),
  );
  const roots = new Set(
    work
      .filter(
        (item) =>
          item.workspaceId === workspaceId &&
          roomIds.has(item.conversationId) &&
          !item.parentId,
      )
      .map((item) => item.rootId),
  );
  return work.filter(
    (item) => item.workspaceId === workspaceId && roots.has(item.rootId),
  );
}

/** Match native memory inheritance; an agent's project membership grants no private memory. */
export function memoryGroup(
  record: MemoryRecord,
  room: ConversationRoom,
): string | null {
  if (
    record.forgottenAt ||
    record.approvalState === "rejected" ||
    (record.workspaceId && record.workspaceId !== room.workspaceId)
  )
    return null;
  const scope = record.scope;
  if (scope?.level === "thread")
    return scope.threadId === room.id ? "This chat" : null;
  if (room.projectId)
    return scope?.level === "project" && scope.projectId === room.projectId
      ? "From this project"
      : null;
  if (!scope || scope.level === "global") return "Account-wide";
  return scope.level === "agent" && scope.agentId === agentChatOwner(room)
    ? "From this agent"
    : null;
}

export function panelMemories(
  records: MemoryRecord[],
  room: ConversationRoom | undefined,
) {
  if (!room) return [];
  return records.flatMap((record) => {
    const group = memoryGroup(record, room);
    return group ? [{ record, group }] : [];
  });
}

export type PanelFile = {
  id: string;
  title: string;
  detail: string;
  origin: "created" | "attached" | "shared";
  updatedAt: string;
  tab?: RightPanelTab;
  attachment?: { file: WorkAttachment; agentId: string; threadId: string };
};

/** Metadata only. The overview never scans the agent's working filesystem. */
export function panelFiles({
  workspaceId,
  work,
  project,
  sources = [],
}: {
  workspaceId: string;
  work: CollaborationWorkItem[];
  project?: LocalProject;
  sources?: KnowledgeSource[];
}): PanelFile[] {
  const entries = new Map<string, PanelFile>();
  for (const item of work) {
    if (item.workspaceId !== workspaceId) continue;
    for (const output of item.outputs) {
      const artifact = parseComputerArtifact(output.text);
      if (!artifact) continue;
      const id = "artifact:" + item.agentId + ":" + artifact.id;
      const previous = entries.get(id);
      if (previous && previous.updatedAt >= output.createdAt) continue;
      entries.set(id, {
        id,
        title: artifact.title,
        detail: "Created by " + item.agentName,
        origin: "created",
        updatedAt: output.createdAt,
        tab: {
          id,
          kind: "artifact",
          title: artifact.title,
          output: output.text,
          agentId: item.agentId,
          conversationId: output.conversationId ?? item.conversationId,
          messageId: output.messageId,
          sourceRevisionId: output.sourceRevisionId,
        },
      });
    }
    for (const file of item.attachments ?? []) {
      const id =
        "attachment:" +
        item.conversationId +
        ":" +
        item.agentId +
        ":" +
        file.id;
      if (entries.has(id)) continue;
      const source = file.sourceId
        ? sources.find(
            (source) =>
              source.id === file.sourceId &&
              isLiveSource(source) &&
              (!source.workspaceId || source.workspaceId === workspaceId),
          )
        : undefined;
      entries.set(id, {
        id,
        title: file.name,
        detail: "Added to chat",
        origin: "attached",
        updatedAt: item.createdAt,
        ...(source
          ? {
              tab: {
                id,
                kind: "file" as const,
                title: file.name,
                target: {
                  type: "knowledge-file" as const,
                  workspaceId,
                  sourceId: source.id,
                },
                text: source.contentPreview ?? "Preview unavailable.",
              },
            }
          : {
              attachment: {
                file,
                agentId: item.agentId,
                threadId: item.conversationId,
              },
            }),
      });
    }
  }
  for (const source of sources) {
    if (
      project?.workspaceId !== workspaceId ||
      !project.knowledgeSourceIds.includes(source.id) ||
      source.connectorId !== "local-files" ||
      !isLiveSource(source) ||
      (source.workspaceId && source.workspaceId !== workspaceId)
    )
      continue;
    const id = "source:" + source.id;
    entries.set(id, {
      id,
      title: source.title,
      detail: "Shared by " + project.name,
      origin: "shared",
      updatedAt: project.updatedAt,
      tab: {
        id,
        kind: "file",
        title: source.title,
        target: {
          type: "knowledge-file",
          workspaceId,
          sourceId: source.id,
          projectId: project.id,
        },
        text: source.contentPreview ?? "Preview unavailable.",
      },
    });
  }
  return [...entries.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
