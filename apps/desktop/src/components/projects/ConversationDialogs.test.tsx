import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { ConversationDialog } from "./ConversationDialogs";

const agents: FableAgentProfile[] = ["Chief", "Product", "Researcher"].map(name => ({
  id: name.toLowerCase(), name, instructions: "Help with this project.",
  modelId: "codex::gpt-5.6-luna", icon: "agent", iconColor: "#865DFA",
  connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me",
}));

describe("conversation participants", () => {
  it("replaces an automatic lead while retaining people explicitly selected", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ConversationDialog agents={agents} initial={{ kind: "project" }} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch" } });
    fireEvent.change(screen.getByLabelText("Lead"), { target: { value: "product" } });
    expect(screen.getByRole("checkbox", { name: "Chief" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Chief" }));
    fireEvent.change(screen.getByLabelText("Lead"), { target: { value: "researcher" } });
    expect(screen.getByRole("checkbox", { name: "Chief" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Product" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Researcher Lead" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ participantIds: ["chief", "researcher"], facilitatorId: "researcher" })));
  });

  it("retains the existing team when changing an established conversation's lead", () => {
    render(<ConversationDialog agents={agents} edit initial={{ kind: "project", title: "Launch", participantIds: ["chief", "product"], facilitatorId: "chief" }} onSave={vi.fn()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Lead"), { target: { value: "product" } });
    expect(screen.getByRole("checkbox", { name: "Chief" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Product Lead" })).toBeChecked();
  });
});
