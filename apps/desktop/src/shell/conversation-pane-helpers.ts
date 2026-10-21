import type {
  ConversationAuthor,
  CollaborationWorkItem,
  ConversationRoom,
  MivletAgentProfile,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import { composerScopeKey } from "../hooks/useScopedComposer";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { createSideChat } from "../lib/conversation-service";
import type { ConversationTurn } from "../lib/conversation-presentation-types";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import {
  loadRuntimeConversationDraft,
  saveRuntimeConversationDraft,
} from "../runtime/domains/conversations";

export const idleAgentState: NativeAgentState = {
  transcript: "",
  usage: null,
  running: false,
  lastError: null,
  status: "idle",
  recoverableAttempts: [],
  contextReceipts: {},
  providerRoutes: {},
  usageReceipts: {},
  currentAttemptId: null,
  noTransport: false,
};

type SideChatGuard = () => boolean;

/** Opens a selected passage in a new owner-bound Side Chat after live fences pass. */
export async function openResponseSideChat({
  service,
  runtime,
  room,
  workspaceId,
  authorId,
  draft,
  isCurrent,
  open,
}: {
  service: WorkspaceExecution;
  runtime: ShellRuntime;
  room: ConversationRoom;
  workspaceId: string;
  authorId: string;
  draft: string;
  isCurrent: SideChatGuard;
  open: (conversationId: string) => void;
}) {
  assertSideChatCurrent(isCurrent);
  if (room.workspaceId !== workspaceId) {
    throw new Error("The account or workspace changed. Refresh before opening a Side Chat.");
  }
  const binding = room.chat;
  if (!binding) {
    throw new Error("This conversation has no owner-bound Side Chat route.");
  }
  const participantIds = room.participants.map((participant) => participant.agentId);
  if (!participantIds.length) {
    throw new Error("This conversation has no available Side Chat participant.");
  }
  const facilitatorId = room.facilitatorId ??
    (participantIds.includes(authorId) ? authorId : participantIds[0]);
  if (!facilitatorId || !participantIds.includes(facilitatorId)) {
    throw new Error("This conversation has no valid Side Chat facilitator.");
  }
  const sideChat = await createSideChat(service, {
    title: `Ask about ${room.title}`.slice(0, 120),
    owner: { kind: binding.ownerKind, id: binding.ownerId },
    participantIds,
    facilitatorId,
  });
  assertSideChatCurrent(isCurrent);
  if (sideChat.workspaceId !== workspaceId) {
    throw new Error("The Side Chat opened in a different workspace.");
  }

  const owner = runtime.accountWorkspaceStatus.activeContextOwner;
  const draftKey = composerScopeKey({
    workspaceId,
    accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
    agentId: facilitatorId,
    projectId: sideChat.projectId,
    threadId: sideChat.id,
  });
  const existing = await loadRuntimeConversationDraft(
    draftKey,
    workspaceId,
    sideChat.id,
  );
  assertSideChatCurrent(isCurrent);
  if (!existing?.content || !hasPersistedDraftContent(existing.content)) {
    await saveRuntimeConversationDraft(
      {
        draftKey,
        threadId: sideChat.id,
        content: JSON.stringify({ text: draft, attachments: [] }),
        updatedAt: new Date().toISOString(),
      },
      workspaceId,
    );
    assertSideChatCurrent(isCurrent);
  }
  assertSideChatCurrent(isCurrent);
  open(sideChat.id);
  return sideChat.id;
}

function assertSideChatCurrent(isCurrent: SideChatGuard) {
  if (!isCurrent()) {
    throw new Error("The account, workspace, or conversation changed before the Side Chat opened.");
  }
}

function hasPersistedDraftContent(content: string) {
  try {
    const parsed = JSON.parse(content) as {
      text?: unknown;
      attachments?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return content.trim().length > 0;
    const keys = Object.keys(parsed);
    if (
      keys.length === 0 ||
      keys.some((key) => key !== "text" && key !== "attachments")
    )
      return content.trim().length > 0;
    return Boolean(
      (typeof parsed.text === "string" && parsed.text.trim()) ||
        (Array.isArray(parsed.attachments) && parsed.attachments.length > 0),
    );
  } catch {
    return content.trim().length > 0;
  }
}

/** Projects queued and steered work into the turn shape consumed by the feed. */
export function pendingConversationTurns(
  work: readonly CollaborationWorkItem[],
): ConversationTurn[] {
  const pending = work
    .filter((item) => !item.parentId && !item.runIds.length)
    .map((item) => ({
      id: item.id,
      prompt: item.userRequest || item.prompt,
      startedAt: item.createdAt,
      endedAt: item.updatedAt,
      parts:
        item.status === "failed"
          ? [
              {
                id: `${item.id}-error`,
                kind: "notice" as const,
                error: true,
                content: item.reason || "This request could not start.",
              },
            ]
          : [],
    }));

  pending.push(
    ...work.flatMap((item) =>
      (item.steering ?? []).map((event) => ({
        id: event.id,
        prompt: event.text,
        startedAt: event.createdAt,
        endedAt: event.createdAt,
        parts: [],
      })),
    ),
  );
  return pending;
}

/** Builds stable feed authors from persisted run authors and current work. */
export function conversationAuthors({
  authors,
  work,
  conversationId,
  agentById,
  fallback,
}: {
  authors: readonly ConversationAuthor[];
  work: readonly CollaborationWorkItem[];
  conversationId: string;
  agentById: ReadonlyMap<string, MivletAgentProfile>;
  fallback: MivletAgentProfile;
}): Record<string, MivletAgentProfile> {
  const result: Record<string, MivletAgentProfile> = Object.fromEntries(
    authors
      .filter((author) => author.conversationId === conversationId)
      .map((author) => [
        author.runId,
        {
          ...(agentById.get(author.agentId) ?? fallback),
          id: author.agentId,
          name: author.name,
          avatarSeed:
            agentById.get(author.agentId)?.avatarSeed ??
            `blob-v1:${author.agentId}`,
        },
      ]),
  );
  for (const item of work) {
    result[item.id] = {
      ...(agentById.get(item.agentId) ?? fallback),
      id: item.agentId,
      name: item.agentName,
    };
  }
  return result;
}
