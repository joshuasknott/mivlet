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
  it("keeps interleaved tools in call order when results arrive in reverse order", () => {
    const messages = [
      view("one", "tool", 1, '{"connectorId":"github"}', { phase: "call", toolCallId: "first", toolName: "connector-call" }),
      view("one", "assistant", 2, "Checking another file."),
      view("one", "tool", 3, "{}", { phase: "call", toolCallId: "second", toolName: "read-file" }),
      view("one", "tool", 4, "Second result", { phase: "result", toolCallId: "second", toolName: "read-file", outcome: "failed" }),
      view("one", "tool", 5, "First result", { phase: "result", toolCallId: "first", toolName: "connector-call", outcome: "succeeded" }),
    ];
    const original = JSON.stringify(messages);
    const turns = conversationTurns(messages);
    expect(turns[0].parts).toEqual([
      { id: "first", kind: "tool", tool: "connector-call", connectorId: "github", content: "First result", state: "succeeded" },
      { id: "one-2", kind: "text", content: "Checking another file." },
      { id: "second", kind: "tool", tool: "read-file", content: "Second result", state: "failed" },
    ]);
    expect(JSON.stringify(messages)).toBe(original);
    expect(conversationTurns(messages)).toEqual(turns);
  });
  it("updates all matching records when a transcript repeats a call ID", () => {
    const turns = conversationTurns([
      view("one", "tool", 1, "Earlier result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "succeeded" }),
      view("one", "tool", 2, "{}", { phase: "call", toolCallId: "same", toolName: "read-file" }),
      view("one", "tool", 3, "Latest result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "failed" }),
    ]);
    expect(turns[0].parts).toEqual([
      { id: "same", kind: "tool", tool: "unknown-tool", content: "Latest result", state: "failed" },
      { id: "same", kind: "tool", tool: "read-file", content: "Latest result", state: "failed" },
    ]);
  });
  it("does not pair an orphan result with a call in an earlier turn", () => {
    const turns = conversationTurns([
      view("one", "tool", 1, "{}", { phase: "call", toolCallId: "same", toolName: "read-file" }),
      view("two", "tool", 2, "Later result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "succeeded" }),
    ]);
    expect(turns[0].parts[0]).toMatchObject({ content: "", state: "running" });
    expect(turns[1].parts[0]).toMatchObject({ tool: "unknown-tool", content: "Later result" });
  });
  it("resets tool pairing when a new prompt splits a repeated run ID", () => {
    const turns = conversationTurns([
      view("one", "user", 1, "First prompt"),
      view("one", "tool", 2, "{}", { phase: "call", toolCallId: "same", toolName: "read-file" }),
      view("one", "user", 3, "Second prompt"),
      view("one", "tool", 4, "Result", { phase: "result", toolCallId: "same", toolName: "read-file", outcome: "succeeded" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].parts[0]).toMatchObject({ content: "", state: "running" });
    expect(turns[1].parts[0]).toMatchObject({ tool: "unknown-tool", content: "Result" });
  });
  it("does not apply a redacted result to a visible call", () => {
    const result = view("one", "tool", 2, "secret", { phase: "result", toolCallId: "call", toolName: "read-file", outcome: "succeeded" });
    result.currentRevision = { ...result.currentRevision, state: "redacted", content: undefined, redaction: { reason: "user-request" } } as ConversationMessageView["currentRevision"];
    const turns = conversationTurns([
      view("one", "tool", 1, "{}", { phase: "call", toolCallId: "call", toolName: "read-file" }),
      result,
    ]);
    expect(turns[0].parts).toEqual([
      { id: "call", kind: "tool", tool: "read-file", content: "", state: "running" },
      { id: "one-2", kind: "text", content: "This message was removed." },
    ]);
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
