import type {
  ConversationAuthor,
  CollaborationWorkItem,
  MivletAgentProfile,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import type { ConversationTurn } from "../lib/conversation-presentation-types";

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

export function responseOutputId(
  messageId: string | undefined,
  runId: string,
  text: string,
) {
  let hash = 2166136261;
  for (const character of text)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `response-${messageId ?? runId}-${(hash >>> 0).toString(36)}`;
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
