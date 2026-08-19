import { fireEvent, render, screen } from "@testing-library/react";
import type { FableAgentProfile } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentSidebar } from "./AgentSidebar";
import { AgentAvatar, nextAgentColor } from "./agent-icons";

const chief: FableAgentProfile = {
  id: "chief-of-staff",
  name: "Chief of Staff",
  instructions: "Keep priorities clear.",
  modelId: "",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

const developer: FableAgentProfile = {
  ...chief,
  id: "developer",
  name: "Developer",
  icon: "agent",
  iconColor: "#3581FB"
};

describe("agent surface", () => {
  it("assigns the next unused colour while keeping one shared agent mark", () => {
    expect(nextAgentColor([chief.iconColor])).toBe(developer.iconColor);
    expect(chief.icon).toBe("agent");
    expect(developer.icon).toBe("agent");

    const { container } = render(
      <>
        <AgentAvatar color={chief.iconColor} />
        <AgentAvatar color={developer.iconColor} />
      </>
    );
    const marks = container.querySelectorAll('[data-agent-mark="fold"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.closest(".agent-avatar")).toHaveStyle({ "--agent-icon-base": chief.iconColor });
    expect(marks[1]?.closest(".agent-avatar")).toHaveStyle({ "--agent-icon-base": developer.iconColor });
  });

  it("keeps agents conversational and opens one workspace-wide search surface", () => {
    const onSelectAgent = vi.fn();
    const onCreateAgent = vi.fn();
    const onOpenSearch = vi.fn();
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
        onOpenSearch={onOpenSearch}
        onEditAgent={vi.fn()}
        onOpenKnowledge={vi.fn()}
        onOpenConnectors={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText("Your priorities are ready")).toBeVisible();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeVisible();
    expect(screen.getByText("Agents")).toBeVisible();
    expect(screen.getByRole("button", { name: "Connections" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
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
      suggestedColor: "#2CC663",
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
