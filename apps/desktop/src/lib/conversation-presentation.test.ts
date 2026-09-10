import { describe, expect, it } from "vitest";
import { conversationTurns, appendResponseText, resolveResponseTool, toolActivity } from "./conversation-presentation";
import type { ConversationMessageView } from "./conversation-runtime";

function view(runId: string, kind: string, sequence: number, content: string, detail?: unknown): ConversationMessageView {
  return { message: { id: `${runId}-${sequence}`, runId, kind, sequence, detail, createdAt: "2026-09-06T10:00:00Z" }, currentRevision: { state: "terminal", content, checkpointedAt: "2026-09-06T10:00:01Z" } } as ConversationMessageView;
}
describe("conversation presentation", () => {
  it("names native application and exact URL activity without exposing arguments", () => {
    expect(toolActivity("local-app-list", "running")).toBe("Listing open applications");
    expect(toolActivity("local-app-select", "succeeded")).toBe("Selected an application window");
    expect(toolActivity("local-app-action", "succeeded")).toBe("Input sent; awaiting observation");
    expect(toolActivity("web-fetch", "succeeded")).toBe("Read an exact web page");
  });
  it("pairs calls within their own turn even when the provider reuses ids", () => {
    const turns = conversationTurns([
      view("one", "user", 1, "First"), view("one", "tool", 2, "Call", { phase: "call", toolCallId: "same", toolName: "read-file" }),
      view("one", "tool", 3, "First result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "succeeded" }),
      view("two", "user", 4, "Second"), view("two", "tool", 5, "Call", { phase: "call", toolCallId: "same", toolName: "read-file" }),
      view("two", "tool", 6, "Second result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "failed" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].parts).toEqual([{ id: "same", kind: "tool", tool: "read-file", content: "First result", state: "succeeded" }]);
    expect(turns[1].parts[0]).toMatchObject({ content: "Second result", state: "failed" });
  });
  it("never reveals redacted tool output", () => {
    const item = view("one", "tool", 1, "secret", { phase: "result", toolCallId: "call", toolName: "read-file", outcome: "succeeded" });
    item.currentRevision = { ...item.currentRevision, state: "redacted", content: undefined, redaction: { reason: "user-request" } } as ConversationMessageView["currentRevision"];
    expect(JSON.stringify(conversationTurns([item]))).not.toContain("secret");
  });
  it("keeps live text on either side of an action and updates the action in place", () => {
    let parts = appendResponseText([], "First ");
    parts = appendResponseText(parts, "update.");
    parts.push({ id: "call", kind: "tool", tool: "read-file", content: "", state: "running" });
    parts = appendResponseText(parts, "Answer.");
    parts = resolveResponseTool(parts, "call", "Read it", true);
    expect(parts.map((part) => part.content)).toEqual(["First update.", "Read it", "Answer."]);
  });
  it("retains only bounded attachment metadata from a user message", () => {
    const valid = view("one", "user", 1, "Inspect this", { attachments: [{
      id: "attachment-1", name: "totals.csv", mimeType: "text/csv", sizeBytes: 24,
      availability: "workspace-file", relativePath: "Attachments/totals-a1.csv",
    }] });
    expect(conversationTurns([valid])[0].attachments?.[0]).toMatchObject({ name: "totals.csv", relativePath: "Attachments/totals-a1.csv" });
    const malformed = view("two", "user", 2, "Ignore bad metadata", { attachments: [{ id: "bad", name: 42 }] });
    expect(conversationTurns([malformed])[0].attachments).toBeUndefined();
  });
});
