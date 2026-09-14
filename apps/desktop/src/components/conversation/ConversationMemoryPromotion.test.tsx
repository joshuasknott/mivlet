import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationMemoryPromotion } from "./ConversationMemoryPromotion";

describe("ConversationMemoryPromotion", () => {
  const scopes = [
    {
      id: "thread" as const,
      label: "This conversation",
      description: "Only this chat inherits it.",
    },
    {
      id: "agent" as const,
      label: "Mira",
      description: "Mira's conversations inherit it.",
    },
  ];

  it("saves the exact conclusion and selected scope", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationMemoryPromotion
        chatTitle="Research notes"
        defaultTitle="Deadline"
        defaultValue="Use the two week deadline."
        scopes={scopes}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue("Deadline")).toBeVisible();
    expect(screen.getByDisplayValue("Use the two week deadline.")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /Mira/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save to Memory" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        title: "Deadline",
        value: "Use the two week deadline.",
        scopeId: "agent",
      }),
    );
  });

  it("requires a title and conclusion", () => {
    const onSave = vi.fn();
    render(
      <ConversationMemoryPromotion
        chatTitle="Research notes"
        scopes={scopes}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save to Memory" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Only a title" },
    });
    expect(screen.getByRole("button", { name: "Save to Memory" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Conclusion"), {
      target: { value: "Now a conclusion" },
    });
    expect(screen.getByRole("button", { name: "Save to Memory" })).toBeEnabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("surfaces a native Memory rejection without closing", async () => {
    const onClose = vi.fn();
    render(
      <ConversationMemoryPromotion
        chatTitle="Research notes"
        defaultTitle="Deadline"
        defaultValue="Use the two week deadline."
        scopes={scopes}
        onSave={vi
          .fn()
          .mockRejectedValue(new Error("Memory is disabled."))}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save to Memory" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Memory is disabled."),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
