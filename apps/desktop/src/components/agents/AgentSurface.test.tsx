import { fireEvent, render, screen } from "@testing-library/react";
import type { FableAgentProfile } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentSidebar } from "./AgentSidebar";
import { nextAgentColor } from "./agent-icons";

const chief: FableAgentProfile = {
  id: "chief-of-staff",
  name: "Chief of Staff",
  instructions: "Keep priorities clear.",
  modelId: "",
  icon: "agent",
  iconColor: "#6D5DF7",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

const developer: FableAgentProfile = {
  ...chief,
  id: "developer",
  name: "Developer",
  icon: "agent",
  iconColor: "#2672E8"
};

describe("agent surface", () => {
  it("assigns the next unused colour while keeping one shared agent mark", () => {
    expect(nextAgentColor([chief.iconColor])).toBe(developer.iconColor);
    expect(chief.icon).toBe("agent");
    expect(developer.icon).toBe("agent");
  });

  it("keeps agents compact and exposes knowledge and connectors as native utilities", () => {
    const onSelectAgent = vi.fn();
    const onCreateAgent = vi.fn();
    render(
      <AgentSidebar
        agents={[chief, developer]}
        activeAgentId={chief.id}
        previews={{
          [chief.id]: { message: "Your priorities are ready", time: "Now", status: "running" },
          [developer.id]: { message: "Start a conversation", time: "", status: "idle" }
        }}
        workspaceName="Fable"
        profileName="Joshua"
        onSelectAgent={onSelectAgent}
        onCreateAgent={onCreateAgent}
        onEditAgent={vi.fn()}
        onOpenKnowledge={vi.fn()}
        onOpenConnectors={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText("Your priorities are ready")).toBeVisible();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connectors" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(onCreateAgent).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Developer"));
    expect(onSelectAgent).toHaveBeenCalledWith(developer);
  });

  it("protects the sole agent and allows deletion once another agent exists", () => {
    const onDelete = vi.fn();
    const baseProps = {
      open: true,
      agent: chief,
      models: [],
      connectors: [],
      knowledgeSources: [],
      suggestedColor: "#13966F",
      onClose: vi.fn(),
      onSave: vi.fn(),
      onDelete
    };
    const { rerender } = render(<AgentEditor {...baseProps} canDelete={false} />);

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Chief of Staff");
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Permissions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Violet icon" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Upload image" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    rerender(<AgentEditor {...baseProps} canDelete />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
