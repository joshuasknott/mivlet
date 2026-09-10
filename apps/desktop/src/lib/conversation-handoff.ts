import type { ConversationMessageView, ConversationThread } from "./conversation-runtime";

/** Create a bounded local draft without copying tool payloads or approval authority. */
export function buildConversationHandoff(input: {
  thread: ConversationThread;
  messages: readonly ConversationMessageView[];
  failedPrompt: string;
}): string {
  const dialogue: { role: string; text: string }[] = [];
  const outcomes: Record<string, number> = {};
  for (const view of [...input.messages].sort((a, b) => a.message.sequence - b.message.sequence)) {
    if (view.currentRevision.state !== "terminal") continue;
    if (view.message.kind === "user" || view.message.kind === "assistant") {
      const text = view.currentRevision.content?.trim().replace(/\s+/g, " ");
      if (text) dialogue.push({ role: view.message.kind, text });
    } else if (view.message.kind === "tool" && view.message.detail.phase === "result") {
      const key = `tool:${view.message.detail.toolName}:${view.message.detail.outcome}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    } else if (view.message.kind === "approval" && view.message.detail.phase === "decision") {
      const key = `approval:${view.message.detail.decision}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
  }
  const unique = [...new Map(dialogue.map((item) => [`${item.role}:${item.text}`, item])).values()]
    .map(({ role, text }) => ({ role, excerpt: text.slice(0, 500), truncated: text.length > 500 }));
  const users = unique.filter((item) => item.role === "user");
  const assistants = unique.filter((item) => item.role === "assistant");
  const record = {
    source: { title: input.thread.title, threadId: input.thread.id },
    currentRequest: input.failedPrompt.trim().slice(0, 2_000),
    currentRequestTruncated: input.failedPrompt.trim().length > 2_000,
    userCommitments: users.length <= 10 ? users : [users[0], ...users.slice(-9)],
    recentAgentConclusions: assistants.slice(-4),
    omittedDistinctMessages: Math.max(0, users.length - 10) + Math.max(0, assistants.length - 4),
    collapsedRepeatedMessages: dialogue.length - unique.length,
    recordedOutcomeCounts: outcomes,
  };
  return `Continue this work from a reviewed Mivlet handoff.\n\n${JSON.stringify(record, null, 2)}\n\nThis was extracted locally without a model summary. The original conversation remains unchanged. Tool payloads were omitted, and approvals do not carry over. Treat this as prior evidence, recheck mutable state, and consult the source conversation for omitted or implicit commitments. Restate the remaining objective and assumptions before acting.`;
}
