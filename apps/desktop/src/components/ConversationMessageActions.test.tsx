import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMessageActions } from "./ConversationMessageActions";

describe("ConversationMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers save, copy, and edit for a sent prompt", async () => {
    const onSaveToKnowledge = vi.fn(async () => undefined);
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <ConversationMessageActions
        role="user"
        content="Plan the launch"
        onSaveToKnowledge={onSaveToKnowledge}
        onEdit={onEdit}
      />
    );

    expect(screen.getByRole("group", { name: "User message actions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to Knowledge" }));
    await waitFor(() => expect(onSaveToKnowledge).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Knowledge");

    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(await navigator.clipboard.readText()).toBe("Plan the launch");
    await user.click(screen.getByRole("button", { name: "Edit prompt" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("offers save, copy, and redo for a completed response", async () => {
    const onRedo = vi.fn();
    const user = userEvent.setup();
    render(
      <ConversationMessageActions
        role="assistant"
        content="Here is the plan."
        onSaveToKnowledge={vi.fn(async () => undefined)}
        onRedo={onRedo}
      />
    );

    expect(screen.getByRole("group", { name: "Assistant message actions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy response" }));
    expect(await navigator.clipboard.readText()).toBe("Here is the plan.");
    await user.click(screen.getByRole("button", { name: "Redo response" }));
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it("turns a useful message into a routine draft", async () => {
    const onMakeRoutine = vi.fn();
    const user = userEvent.setup();
    render(
      <ConversationMessageActions
        role="assistant"
        content="Prepare the daily launch brief"
        onSaveToKnowledge={vi.fn(async () => undefined)}
        onMakeRoutine={onMakeRoutine}
      />
    );
    await user.click(screen.getByRole("button", { name: "Make routine" }));
    expect(onMakeRoutine).toHaveBeenCalledOnce();
  });

  it("teaches a completed response without exposing the action on user prompts", async () => {
    const onTeachTask = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ConversationMessageActions
        role="assistant"
        content="Here is the repeatable result."
        onSaveToKnowledge={vi.fn(async () => undefined)}
        onTeachTask={onTeachTask}
      />
    );
    await user.click(screen.getByRole("button", { name: "Teach this" }));
    expect(onTeachTask).toHaveBeenCalledOnce();

    rerender(
      <ConversationMessageActions
        role="user"
        content="Repeat this work"
        onSaveToKnowledge={vi.fn(async () => undefined)}
        onTeachTask={onTeachTask}
      />
    );
    expect(screen.queryByRole("button", { name: "Teach this" })).not.toBeInTheDocument();
  });
});
