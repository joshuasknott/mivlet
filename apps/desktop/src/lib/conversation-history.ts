import type { ConversationMessageView } from "./conversation-runtime";
import type { ConversationTurn, ResponsePart } from "./conversation-presentation-types";
import { resultMcpApp } from "./mcp-app-descriptor";
import { toolConnectorId } from "./conversation-presentation";

function parsedToolInput(content: string): Record<string, unknown> | undefined {
  if (content.length > 256 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    const args = value.arguments ?? value.input ?? value;
    return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Pair call/result by run and call id, preserving conversational chronology. */
export function conversationTurns(
  messages: ConversationMessageView[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  // These parts belong to this reconstruction, so results can update them
  // without scanning or copying the whole turn. Keep duplicate call IDs paired.
  type ToolPart = Extract<ResponsePart, { kind: "tool" }>;
  const toolsByCallId = new Map<string, ToolPart[]>();
  const toolInputs = new WeakMap<ToolPart, Record<string, unknown>>();
  for (const { message, currentRevision: revision } of messages) {
    const content =
      revision.state === "redacted"
        ? "This message was removed."
        : revision.content;
    const previous = turns.at(-1);
    const id =
      message.runId ??
      (message.kind === "user" ? message.id : (previous?.id ?? message.id));
    let turn = previous;
    if (
      !turn ||
      turn.id !== id ||
      (message.kind === "user" && turn.prompt !== undefined)
    ) {
      turn = { id, parts: [], startedAt: message.createdAt };
      turns.push(turn);
      toolsByCallId.clear();
    }
    turn.endedAt = revision.checkpointedAt;
    if (message.kind === "user") {
      turn.prompt = content;
      turn.promptMessageId = String(message.id);
      const attachments = message.detail?.attachments;
      if (
        Array.isArray(attachments) &&
        attachments.length <= 12 &&
        attachments.every(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.name === "string" &&
            typeof item.mimeType === "string" &&
            typeof item.sizeBytes === "number" &&
            [
              "image-input",
              "knowledge-context",
              "workspace-file",
              "project-file",
            ].includes(item.availability) &&
            (item.relativePath === undefined ||
              typeof item.relativePath === "string"),
        )
      )
        turn.attachments = attachments;
    } else if (revision.state === "redacted" || message.kind === "assistant") {
      turn.responseMessageId = String(message.id);
      turn.responseRevisionId = String(message.currentRevisionId);
      turn.responseSource = content;
      turn.parts.push({ id: message.id, kind: "text", content });
    } else if (message.kind === "tool") {
      const callId = message.detail.toolCallId;
      const matchingParts = toolsByCallId.get(callId);
      const isCall = message.detail.phase === "call";
      const outcome = String(message.detail.outcome ?? "");
      const terminalStatus =
        !isCall && (outcome === "interrupted" || outcome === "cancelled")
          ? (outcome as "interrupted" | "cancelled")
          : undefined;
      const state = isCall
        ? "running"
        : outcome === "succeeded"
          ? "succeeded"
          : "failed";
      if (!isCall && matchingParts) {
        const app = state === "succeeded" ? resultMcpApp(content) : undefined;
        for (const part of matchingParts) {
          part.content = content;
          part.state = state;
          if (terminalStatus) part.terminalStatus = terminalStatus;
          else delete part.terminalStatus;
          if (app) {
            part.mcpApp = app;
            part.resultRevisionId = String(message.currentRevisionId);
            part.connectorId = app.connectorId;
            part.toolInput = toolInputs.get(part);
          }
        }
      } else {
        const connectorId = isCall
          ? toolConnectorId(message.detail.toolName, content)
          : undefined;
        const part: ToolPart = {
          id: callId,
          kind: "tool",
          tool: isCall ? message.detail.toolName : "unknown-tool",
          ...(connectorId ? { connectorId } : {}),
          content: isCall ? "" : content,
          state,
          ...(terminalStatus ? { terminalStatus } : {}),
          ...(state === "succeeded" && !isCall && resultMcpApp(content)
            ? {
                mcpApp: resultMcpApp(content),
                resultRevisionId: String(message.currentRevisionId),
                connectorId: resultMcpApp(content)!.connectorId,
              }
            : {}),
        };
        turn.parts.push(part);
        const input = isCall ? parsedToolInput(content) : undefined;
        if (input) toolInputs.set(part, input);
        if (matchingParts) matchingParts.push(part);
        else toolsByCallId.set(callId, [part]);
      }
    } else if (message.kind === "error" || message.kind === "interruption") {
      turn.parts.push({
        id: message.id,
        kind: "notice",
        content,
        error: message.kind === "error",
        ...(message.kind === "interruption"
          ? { status: message.detail.reason === "user-stop" ? "cancelled" as const : "interrupted" as const }
          : {}),
      });
    } else if (
      message.kind === "approval" &&
      message.detail.phase === "decision" &&
      message.detail.decision === "denied"
    ) {
      turn.parts.push({
        id: message.id,
        kind: "notice",
        content: "You declined this action.",
        error: false,
      });
    }
  }
  return turns;
}
