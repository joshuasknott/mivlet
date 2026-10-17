import type { Spine } from "@mivlet/protocol";

export type ResponsePart =
  | { id: string; kind: "text"; content: string }
  | {
      id: string;
      kind: "tool";
      tool: string;
      connectorId?: string;
      state: "running" | "succeeded" | "failed";
      content: string;
      /** Durable result outcome when execution stopped before a normal result. */
      terminalStatus?: "interrupted" | "cancelled";
      mcpApp?: McpAppDescriptor;
      /** Exact persisted result revision; provider call IDs may be reused. */
      resultRevisionId?: string;
      toolInput?: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "notice";
      content: string;
      error: boolean;
      /** Durable terminal state represented by this notice. */
      status?: "interrupted" | "cancelled" | "awaiting-user";
    };

/** Persisted, non-secret pointer to an MCP App resource. */
export interface McpAppDescriptor {
  connectorId: string;
  toolName: string;
  resourceUri: string;
}

export interface ConversationTurn {
  id: string;
  prompt?: string;
  promptMessageId?: string;
  responseMessageId?: string;
  responseRevisionId?: string;
  /** Exact terminal assistant revision source used by native OpenUI actions. */
  responseSource?: string;
  attachments?: readonly Spine.Conversations.ConversationAttachmentMetadata[];
  parts: ResponsePart[];
  startedAt?: string;
  endedAt?: string;
}

