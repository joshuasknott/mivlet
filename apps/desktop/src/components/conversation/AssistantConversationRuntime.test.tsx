import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationMessageView } from "../../lib/conversation-runtime";
import { AssistantConversationRuntime, assistantStoreMessages } from "./AssistantConversationRuntime";
import { AssistantMessageActions } from "./AssistantMessageActions";

afterEach(cleanup);

function view(
  id: string,
  kind: "user" | "assistant",
  content: string,
  parentMessageId?: string,
) {
  return {
    message: {
      id,
      kind,
      threadId: "thread-1",
      sequence: 1,
      createdAt: "2026-10-08T10:00:00.000Z",
      parentMessageId,
      previousMessageId: parentMessageId,
    },
    currentRevision: {
      state: "terminal",
      content,
      checkpointedAt: "2026-10-08T10:00:01.000Z",
    },
  } as unknown as ConversationMessageView;
}

describe("assistant-ui conversation bridge", () => {
  it("opens a real editor, retains its draft across refresh and submits the durable source id", async () => {
    const onEdit = vi.fn();
    const messages = [view("user-1", "user", "Original request")];
    const ui = (snapshot: typeof messages) => (
      <AssistantConversationRuntime threadId="thread-1" messages={snapshot} selectedHeadId="user-1" onEdit={onEdit}>
        <AssistantMessageActions messageId="user-1" />
      </AssistantConversationRuntime>
    );
    const mounted = render(ui(messages));
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const input = screen.getByRole("textbox", { name: "Edit earlier message" });
    expect(input).toHaveValue("Original request");
    fireEvent.change(input, { target: { value: "Revised request" } });
    mounted.rerender(ui([...messages]));
    expect(screen.getByRole("textbox", { name: "Edit earlier message" })).toHaveValue("Revised request");
    fireEvent.click(screen.getByRole("button", { name: "Send edited message" }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith("user-1", "Revised request"));
  });

  it("cancels an edit without execution and regenerates using the original user anchor", async () => {
    const onEdit = vi.fn();
    const onReload = vi.fn();
    render(
      <AssistantConversationRuntime threadId="thread-1" selectedHeadId="answer-1"
        messages={[view("user-1", "user", "Request"), view("answer-1", "assistant", "Answer", "user-1")]}
        onEdit={onEdit} onReload={onReload}>
        <AssistantMessageActions messageId="user-1" />
        <AssistantMessageActions messageId="answer-1" />
      </AssistantConversationRuntime>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    await waitFor(() => expect(onReload).toHaveBeenCalledWith("user-1"));
  });

  it("keeps durable message ids and parent links in the external repository", () => {
    const rows = assistantStoreMessages([
      view("user-1", "user", "Original request"),
      view("answer-1", "assistant", "First answer", "user-1"),
    ]);

    expect(rows.map((row) => row.parentId)).toEqual([null, "user-1"]);
    expect(rows[1]?.message.id).toBe("answer-1");
  });

  it("restores redacted content without exposing the stored payload", () => {
    const [row] = assistantStoreMessages([
      {
        ...view("answer-1", "assistant", "private response"),
        currentRevision: {
          state: "redacted",
          content: "private response",
          checkpointedAt: "2026-10-08T10:00:01.000Z",
        },
      } as unknown as ConversationMessageView,
    ]);

    expect(row?.message.content).toEqual([
      { type: "text", text: "[Content unavailable]" },
    ]);
  });

  it("keeps a paginated page readable when its first row has an older parent", () => {
    const [row] = assistantStoreMessages([
      view("answer-2", "assistant", "Later answer", "answer-1"),
    ]);

    expect(row?.parentId).toBeNull();
    expect(row?.message.id).toBe("answer-2");
  });
});
