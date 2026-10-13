import { fireEvent, render, screen } from "@testing-library/react";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessageView } from "../../lib/conversation-runtime";
import { createInitialNativeAgentState } from "../../hooks/native-agent/runtime";
import { ConversationFeed } from "./ConversationFeed";

const { renders } = vi.hoisted(() => ({
  renders: vi.fn<(props: { text: string; workspaceId: string; conversationId: string; generation?: number; responseRevisionId?: string }) => void>(),
}));
vi.mock("./AssistantMessageActions", () => ({ AssistantMessageActions: () => null }));
// Count the actual feed/turn boundary; renderer internals keep their existing suites.
vi.mock("./generated/GeneratedResponse", () => ({
  GeneratedResponse: (props: Parameters<typeof renders>[0]) => {
    renders(props);
    return <p>{props.text}</p>;
  },
}));

const agent: MivletAgentProfile = {
  id: "agent", name: "Agent", icon: "agent", iconColor: "#24bb77",
  instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
};
const base = {
  agent, workspaceId: "workspace", threadId: "thread", profileName: "Joshua",
  connectors: [], optimisticPrompt: "",
};
const idle = createInitialNativeAgentState();
const live = {
  ...idle, currentAttemptId: "live", progressThreadId: "thread",
  progressAgentId: "agent", running: true, status: "streaming" as const,
  transcript: "delta", responseParts: [{ id: "text-0", kind: "text" as const, content: "delta" }],
};
function history(count: number, threadId = "thread"): ConversationMessageView[] {
  return Array.from({ length: count }, (_, index) => [
    {
      message: { id: `user-${index}`, threadId, runId: `old-${index}`, kind: "user", sequence: index * 2 + 1 },
      currentRevision: { threadId, state: "terminal", content: `Question ${index}` },
    },
    {
      message: { id: `answer-${index}`, threadId, runId: `old-${index}`, kind: "assistant",
        sequence: index * 2 + 2, currentRevisionId: `revision-${index}` },
      currentRevision: { threadId, state: "terminal", content: `Answer ${index}` },
    },
  ]).flat() as unknown as ConversationMessageView[];
}

function withText(entry: ConversationMessageView, content: string): ConversationMessageView {
  if (entry.currentRevision.state === "redacted") throw new Error("Fixture is redacted");
  return { ...entry, currentRevision: { ...entry.currentRevision, content } };
}

function redact(entry: ConversationMessageView): ConversationMessageView {
  const { content: _content, redaction: _redaction, ...revision } = entry.currentRevision;
  return { ...entry, currentRevision: {
    ...revision, state: "redacted", reason: "redaction",
    redaction: { reason: "user-request" },
  } };
}

describe("retained conversation rendering", () => {
  beforeEach(() => renders.mockClear());

  it("renders 200 retained answers once across 20 live updates while the live disclosure stays current", () => {
    const messages = history(200);
    const view = render(<ConversationFeed {...base} messages={messages} state={live} />);
    expect(renders).toHaveBeenCalledTimes(200);
    for (let i = 0; i < 20; i++) {
      view.rerender(<ConversationFeed {...base} messages={messages} state={{
        ...live, transcript: `delta ${i}`,
        responseParts: [{ id: "text-0", kind: "text", content: `delta ${i}` }],
      }} />);
    }
    // Previously every update entered all 200 retained renderers: 4,200 calls.
    expect(renders).toHaveBeenCalledTimes(200);
    expect(screen.getByText("Answer 199")).toBeVisible();
    fireEvent.click(screen.getByText("Working"));
    expect(screen.getByText("delta 19")).toBeVisible();
    view.rerender(<ConversationFeed {...base} messages={messages} state={{
      ...live, transcript: "Final answer", running: false, status: "completed",
      responseParts: [{ id: "text-0", kind: "text", content: "Final answer" }],
    }} />);
    expect(screen.getByText("Final answer")).toBeVisible();
    expect(renders).toHaveBeenCalledTimes(201);
  });

  it("reconciles revision/redaction changes and forwards the current generation to retained outputs", () => {
    const messages = history(1);
    const view = render(<ConversationFeed {...base} messages={messages} state={idle} generation={1} />);
    expect(renders).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Answer 0", responseRevisionId: "revision-0", generation: 1,
    }));
    const revised = messages.map((entry, index) => index === 1 ? {
      ...entry,
      message: { ...entry.message, currentRevisionId: "revised" as never },
      currentRevision: withText(entry, "Edited answer").currentRevision,
    } : entry);
    view.rerender(<ConversationFeed {...base} messages={revised} state={idle} generation={2} />);
    expect(screen.queryByText("Answer 0")).toBeNull();
    expect(renders).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Edited answer", responseRevisionId: "revised", generation: 2,
    }));
    const redacted = revised.map((entry, index) => index === 1 ? redact(entry) : entry);
    view.rerender(<ConversationFeed {...base} messages={redacted} state={idle} generation={3} />);
    expect(screen.queryByText("Edited answer")).toBeNull();
    expect(screen.getByText("This message was removed.")).toBeVisible();
  });

  it("switches workspace/thread without retaining prior text or output scope", () => {
    const view = render(<ConversationFeed {...base} messages={history(1)} state={idle} />);
    const other = history(1, "other").map((entry) => withText(entry, "Other workspace"));
    view.rerender(<ConversationFeed {...base} workspaceId="other-workspace" threadId="other" messages={other} state={live} />);
    expect(screen.queryByText("Answer 0")).toBeNull();
    expect(screen.queryByText("delta")).toBeNull();
    expect(renders).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "Other workspace", workspaceId: "other-workspace", conversationId: "other",
    }));
  });

  it("refreshes only the turn whose progress receipt changed and retains paging controls", () => {
    const messages = history(2);
    const older = vi.fn();
    const view = render(<ConversationFeed {...base} messages={messages} state={idle} hasOlderMessages onLoadOlderMessages={older} />);
    expect(renders).toHaveBeenCalledTimes(2);
    view.rerender(<ConversationFeed {...base} messages={messages} hasOlderMessages onLoadOlderMessages={older} state={{
      ...idle, progressReceipts: { "old-0": {
        summaries: { summary: "Saved reasoning summary" },
        startedAt: "2026-10-13T12:00:00Z", endedAt: "2026-10-13T12:00:05Z",
      } },
    }} />);
    expect(renders).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByText("Worked for 5s"));
    expect(screen.getByText("Saved reasoning summary")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(older).toHaveBeenCalledOnce();
  });
});
