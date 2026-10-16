import type { MivletAgentProfile } from "@mivlet/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FirstAgentOnboardingPage } from "./FirstAgentOnboardingPage";

const agent: MivletAgentProfile = {
  id: "chief-of-staff",
  name: "Chief of Staff",
  instructions: "Coordinate my work.",
  modelId: "",
  icon: "agent",
  iconColor: "#865DFA",
  avatarSeed: "blob-v1:chief-of-staff",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
};

describe("first agent onboarding", () => {
  it("requires no extra account step and saves the original profile once", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<FirstAgentOnboardingPage agent={agent} onSave={onSave} />);

    expect(
      screen.getByRole("heading", { name: "Make your first agent." }),
    ).toHaveFocus();
    expect(screen.getByDisplayValue("Chief of Staff")).toBeVisible();
    const nameField = screen.getByDisplayValue("Chief of Staff");
    await user.clear(nameField);
    await user.type(nameField, "Mira");
    const instructionsField = screen.getByDisplayValue("Coordinate my work.");
    await user.clear(instructionsField);
    await user.type(
      instructionsField,
      "Turn priorities into next steps.",
    );
    await user.click(screen.getByRole("button", { name: "Enter workspace" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "Mira",
      instructions: "Turn priorities into next steps.",
      avatarSeed: "blob-v1:chief-of-staff",
      iconColor: "#865DFA",
    });
  });

  it("requires a name and surfaces save errors without losing the draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("Workspace is busy."));
    render(<FirstAgentOnboardingPage agent={agent} onSave={onSave} />);
    const nameField = screen.getByDisplayValue("Chief of Staff");
    await user.clear(nameField);
    const submit = screen.getByRole("button", { name: "Enter workspace" });
    expect(submit).toBeDisabled();
    await user.type(nameField, "Mira");
    expect(nameField).toHaveAttribute("maxlength", "80");
    await user.click(submit);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mira" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace is busy.",
    );
    expect(screen.getByRole("button", { name: "Enter workspace" })).toBeEnabled();
  });

});
