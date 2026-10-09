import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextInspector } from "./ContextInspector";

const mocks = vi.hoisted(() => ({ ui: vi.fn(), attempts: vi.fn() }));
vi.mock("../../runtime/domains/conversation-ui", () => ({ conversationUi: mocks.ui }));
vi.mock("../../runtime/domains/workspace", () => ({ listRuntimeExecutionAttempts: mocks.attempts }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const selection = { revision: 0, includeHistory: true, includeProjectFacts: true, excludedMemoryIds: [], excludedKnowledgeSourceIds: [] };
function preview(conversationId: string) {
  return { selection, capture: { capturedAt: "2026-10-08T10:00:00Z", sourceRevision: 1, text: JSON.stringify({ history: [], approvedScopedMemory: [{ id: "memory-1", value: `Preference for ${conversationId}`, scope: { level: "thread" } }] }) } };
}
const props = { workspaceId: "workspace", conversationId: "chat-a", agentId: "lead", revision: 1, work: [], attachments: [] };

describe("native context inspector", () => {
  it("uses the native selection revision and excludes unrelated attempt receipts", async () => {
    mocks.ui.mockResolvedValue(preview("chat-a"));
    mocks.attempts.mockResolvedValue([
      { id: "visible", threadId: "chat-a", contextReceipt: { scope: { agentId: "lead" } } },
      { id: "foreign-conversation", threadId: "chat-b", contextReceipt: { scope: { agentId: "lead" } } },
      { id: "foreign-agent", threadId: "chat-a", contextReceipt: { scope: { agentId: "other" } } },
    ]);
    render(<ContextInspector {...props} />);
    fireEvent.click(screen.getByText("Context"));
    await screen.findByText("Preference for chat-a");
    expect(screen.getByText(/Request receipt.*visible/)).toBeInTheDocument();
    expect(screen.queryByText(/Request receipt.*foreign/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Preference for chat-a/ }));
    await waitFor(() => expect(mocks.ui).toHaveBeenLastCalledWith(
      { workspaceId: "workspace", conversationId: "chat-a", agentId: "lead" },
      { action: "set-context", selection: { ...selection, excludedMemoryIds: ["memory-1"] } },
    ));
  });

  it("ignores late context from a conversation that is no longer selected", async () => {
    let resolveOld!: (value: ReturnType<typeof preview>) => void;
    mocks.ui.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(preview("chat-b"));
    mocks.attempts.mockResolvedValue([]);
    const mounted = render(<ContextInspector {...props} />);
    fireEvent.click(screen.getByText("Context"));
    await waitFor(() => expect(mocks.ui).toHaveBeenCalledTimes(1));
    mounted.rerender(<ContextInspector {...props} conversationId="chat-b" />);
    await screen.findByText("Preference for chat-b");
    resolveOld(preview("chat-a"));
    await waitFor(() => expect(screen.queryByText("Preference for chat-a")).not.toBeInTheDocument());
  });
});
