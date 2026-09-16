import type { SearchResult } from "@mivlet/protocol";

/** Exact, side-effect-free routing target for a search result. Every variant
 * names an existing object; the shell opens or focuses it and never creates a
 * conversation, session or Work item as a search side effect. */
export type SearchNavigationTarget =
  | {
      type: "conversation";
      workspaceId: string;
      conversationId: string;
      messageId?: string;
    }
  | { type: "agent"; workspaceId: string; agentId: string }
  | {
      type: "project";
      workspaceId: string;
      projectId: string;
      threadId: string;
    }
  | {
      type: "work";
      workspaceId: string;
      workId: string;
      conversationId: string;
    }
  | {
      type: "artifact";
      workspaceId: string;
      agentId: string;
      relativePath: string;
      title: string;
    }
  | {
      type: "knowledge-file";
      workspaceId: string;
      sourceId: string;
      projectId?: string;
    };

/** Resolve a displayed result to the exact object the shell should open. Returns
 * null when the native context is incomplete so callers can report an
 * unavailable object instead of guessing. */
export function navigationTargetFor(
  result: SearchResult,
): SearchNavigationTarget | null {
  const workspaceId = result.reference.workspaceId;
  const context = result.context;
  switch (result.objectKind) {
    case "conversation": {
      const conversationId = context.conversationId ?? result.reference.id;
      if (!conversationId) return null;
      return {
        type: "conversation",
        workspaceId,
        conversationId,
        messageId: context.messageId,
      };
    }
    case "agent": {
      const agentId = context.agentId ?? result.reference.id;
      if (!agentId) return null;
      return { type: "agent", workspaceId, agentId };
    }
    case "project": {
      if (!context.projectId || !context.threadId) return null;
      return {
        type: "project",
        workspaceId,
        projectId: context.projectId,
        threadId: context.threadId,
      };
    }
    case "work": {
      if (!context.workId || !context.conversationId) return null;
      return {
        type: "work",
        workspaceId,
        workId: context.workId,
        conversationId: context.conversationId,
      };
    }
    case "file": {
      if (context.fileKind === "artifact") {
        if (!context.agentId || !context.relativePath) return null;
        return {
          type: "artifact",
          workspaceId,
          agentId: context.agentId,
          relativePath: context.relativePath,
          title: result.title,
        };
      }
      const sourceId = context.sourceId ?? result.reference.id;
      if (!sourceId) return null;
      return {
        type: "knowledge-file",
        workspaceId,
        sourceId,
        projectId: context.projectId,
      };
    }
    default:
      return null;
  }
}
