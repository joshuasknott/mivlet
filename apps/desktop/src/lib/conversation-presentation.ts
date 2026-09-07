import type { ConversationMessageView } from "./conversation-runtime";
import { connectorErrorMessage } from "./connector-errors";
import { CONNECTOR_READ_TOOLS } from "./connector-chat";
import { findMarketplaceConnector } from "../components/marketplace/marketplace-catalog";

export type ResponsePart =
  | { id: string; kind: "text"; content: string }
  | { id: string; kind: "tool"; tool: string; connectorId?: string; state: "running" | "succeeded" | "failed"; content: string }
  | { id: string; kind: "notice"; content: string; error: boolean };

export interface ConversationTurn {
  id: string;
  prompt?: string;
  parts: ResponsePart[];
  startedAt?: string;
  endedAt?: string;
}

/** Presentation only. Tool labels never confer execution authority. */
const toolLabels: Record<string, [string, string]> = {
  "google-drive-read": ["Reading Google Drive", "Read Google Drive"],
  "gmail-read": ["Reading Gmail", "Read Gmail"],
  "google-calendar-read": ["Reading Google Calendar", "Read Google Calendar"],
  "github-read": ["Reading GitHub", "Read GitHub"],
  "vercel-read": ["Reading Vercel", "Read Vercel"],
  "linear-read": ["Reading Linear", "Read Linear"],
  "search-notion": ["Searching Notion", "Searched Notion"],
  "search-slack": ["Searching Slack", "Searched Slack"],
  "connector-tools": ["Checking connected app tools", "Checked connected app tools"],
  "read-file": ["Reading a file", "Read a file"],
  "write-file": ["Writing a file", "Wrote a file"],
  "list-files": ["Looking through files", "Listed files"],
  "run-shell": ["Running a command", "Ran a command"],
  "local-browser": ["Opening a page", "Opened a page"],
  "local-browser-observe": ["Checking the page", "Checked the page"],
  "local-desktop-observe": ["Checking the computer", "Checked the computer"],
  "local-browser-action": ["Working in the browser", "Used the browser"],
  "local-browser-tab": ["Switching browser tabs", "Updated browser tabs"],
  "local-desktop-action": ["Working on the computer", "Used the computer"],
  "computer-artifact": ["Preparing a file", "Prepared a file"],
  "connector-search": ["Searching connected apps", "Searched connected apps"],
  "connector-read": ["Reading from a connected app", "Read from a connected app"],
  "connector-call": ["Using a connected app", "Used a connected app"],
  "connector-action": ["Updating a connected app", "Updated a connected app"],
};

export function toolActivity(tool: string, state: "running" | "succeeded" | "failed", connectorId?: string) {
  const connector = connectorId && findMarketplaceConnector(connectorId);
  const labels = connector && tool.startsWith("connector-") ? [`Using ${connector.name}`, `Used ${connector.name}`] : toolLabels[tool] ?? ["Working with a tool", "Used a tool"];
  return state === "failed" ? `${labels[0]} — failed` : labels[state === "running" ? 0 : 1];
}

export function toolConnectorId(tool: string, argumentsJson: string): string | undefined {
  if (CONNECTOR_READ_TOOLS[tool]) return CONNECTOR_READ_TOOLS[tool];
  if (!["connector-call", "connector-tools", "connector-action"].includes(tool)) return undefined;
  try {
    const value = JSON.parse(argumentsJson) as { connectorId?: string };
    return value.connectorId && findMarketplaceConnector(value.connectorId) ? value.connectorId : undefined;
  } catch { return undefined; }
}

export function toolFailureSummary(content: string): string {
  let message = content;
  try {
    const value = JSON.parse(content);
    if (typeof value.message === "string") message = value.message;
    else if (typeof value.error === "string") message = value.error;
    else if (typeof value.error?.message === "string") message = value.error.message;
  } catch { /* Text errors are already a supported result. */ }
  return connectorErrorMessage(new Error(message || "The app could not complete this step.")).slice(0, 500);
}

export function appendResponseText(parts: ResponsePart[], text: string): ResponsePart[] {
  const last = parts.at(-1);
  return last?.kind === "text"
    ? [...parts.slice(0, -1), { ...last, content: last.content + text }]
    : [...parts, { id: `text-${parts.length}`, kind: "text", content: text }];
}

export function resolveResponseTool(parts: ResponsePart[], callId: string, output: string, ok: boolean): ResponsePart[] {
  const found = parts.some((part) => part.kind === "tool" && part.id === callId);
  const result = { id: callId, kind: "tool" as const, tool: "unknown-tool", content: output, state: ok ? "succeeded" as const : "failed" as const };
  return found ? parts.map((part) => part.kind === "tool" && part.id === callId ? { ...part, content: output, state: result.state } : part) : [...parts, result];
}

/** Pair call/result by run and call id, preserving conversational chronology. */
export function conversationTurns(messages: ConversationMessageView[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const { message, currentRevision: revision } of messages) {
    const content = revision.state === "redacted" ? "This message was removed." : revision.content;
    const previous = turns.at(-1);
    const id = message.runId ?? (message.kind === "user" ? message.id : previous?.id ?? message.id);
    let turn = previous;
    if (!turn || turn.id !== id || (message.kind === "user" && turn.prompt !== undefined)) {
      turn = { id, parts: [], startedAt: message.createdAt };
      turns.push(turn);
    }
    turn.endedAt = revision.checkpointedAt;
    if (message.kind === "user") turn.prompt = content;
    else if (revision.state === "redacted" || message.kind === "assistant") turn.parts.push({ id: message.id, kind: "text", content });
    else if (message.kind === "tool") {
      if (message.detail.phase === "call") turn.parts.push({ id: message.detail.toolCallId, kind: "tool", tool: message.detail.toolName, ...(toolConnectorId(message.detail.toolName, content) ? { connectorId: toolConnectorId(message.detail.toolName, content) } : {}), content: "", state: "running" });
      else turn.parts = resolveResponseTool(turn.parts, message.detail.toolCallId, content, message.detail.outcome === "succeeded");
    } else if (message.kind === "error" || message.kind === "interruption") {
      turn.parts.push({ id: message.id, kind: "notice", content, error: message.kind === "error" });
    } else if (message.kind === "approval" && message.detail.phase === "decision" && message.detail.decision === "denied") {
      turn.parts.push({ id: message.id, kind: "notice", content: "You declined this action.", error: false });
    }
  }
  return turns;
}

export const CONVERSATION_STYLE_INSTRUCTIONS = `Conversation style:
Keep the conversation calm, direct and concise. For multi-step work, briefly explain your approach before acting. Send another short update only when you have a useful finding, a material decision, a delay to explain, or need the user's help. Do not narrate each tool call; Fable displays recorded actions separately. For simple questions, answer directly.
Summarize relevant decisions and evidence without exposing private chain-of-thought or inventing reasoning traces. Never claim an action succeeded before its result confirms it.
Finish with the result, any files produced, and material limitations. If a tool failed, distinguish recovered attempts from work you could not complete. If a source is paginated or text is shortened, state the coverage accurately; never imply you read the entire source from one partial page. Do not repeatedly parse or repair tool output: use its documented fields and continuation token, or report the concrete limitation. Use readable Markdown when useful. When interrupted, explain what is complete and what remains. Do not repeat consequential actions with an uncertain outcome without checking their current state. Ask for sign-in or control only when needed and explain the next action.`;
