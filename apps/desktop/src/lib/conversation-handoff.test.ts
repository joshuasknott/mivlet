import { describe, expect, it } from "vitest";
import type { ConversationMessageView, ConversationThread } from "./conversation-runtime";
import { buildConversationHandoff } from "./conversation-handoff";

const thread = { id: "thread-a", title: "Audit work" } as ConversationThread;
function view(sequence: number, kind: string, content: string, detail?: unknown): ConversationMessageView {
  return {
    message: { id: `message-${sequence}`, threadId: "thread-a", sequence, kind, detail },
    currentRevision: { state: "terminal", content },
  } as ConversationMessageView;
}

describe("buildConversationHandoff", () => {
  it("preserves current intent and dialogue provenance without carrying tool payloads or approval authority", () => {
    const handoff = buildConversationHandoff({
      thread,
      failedPrompt: "Finish the audit and keep the blue design.",
      messages: [
        view(1, "user", "Keep the blue design."),
        view(2, "assistant", "The layout is complete; verification remains."),
        view(3, "tool", "SECRET TOOL PAYLOAD", { phase: "result", toolCallId: "call-1", toolName: "local-app-click", outcome: "succeeded" }),
        view(4, "approval", "permit-secret", { phase: "decision", approvalRequestId: "approval-1", approvalDecisionId: "decision-1", decision: "approved" }),
      ],
    });
    expect(handoff).toContain("Finish the audit and keep the blue design.");
    expect(handoff).toContain('"title": "Audit work"');
    expect(handoff).toContain('"tool:local-app-click:succeeded": 1');
    expect(handoff).toContain('"approval:approved": 1');
    expect(handoff).not.toContain("SECRET TOOL PAYLOAD");
    expect(handoff).not.toContain("permit-secret");
    expect(handoff).toContain("do not carry over");
  });

  it("bounds repetitive dialogue and states what was omitted", () => {
    const messages = Array.from({ length: 20 }, (_, index) => view(index + 1, "user", `Distinct requirement ${index + 1}`));
    const handoff = buildConversationHandoff({ thread, failedPrompt: "Continue ".repeat(1_000), messages });
    expect(handoff.length).toBeLessThanOrEqual(12_000);
    expect(handoff).toContain('"omittedDistinctMessages": 10');
    expect(handoff).toContain('"currentRequestTruncated": true');
    expect(handoff).toContain("Distinct requirement 1");
    expect(handoff).toContain("Distinct requirement 20");
  });

  it("deduplicates complete messages before excerpting shared long prefixes", () => {
    const prefix = "same prefix ".repeat(60);
    const handoff = buildConversationHandoff({
      thread,
      failedPrompt: "Continue",
      messages: [
        view(1, "user", `${prefix}KEEP BLUE`),
        view(2, "user", `${prefix}KEEP GREEN`),
        view(3, "user", `${prefix}KEEP BLUE`),
      ],
    });
    expect(handoff).toContain('"collapsedRepeatedMessages": 1');
    expect(handoff).toContain('"truncated": true');
    expect(handoff.match(/"role": "user"/g)).toHaveLength(2);
  });
});
