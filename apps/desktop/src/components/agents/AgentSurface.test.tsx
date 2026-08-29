import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { AgentLearningDialog } from "./AgentLearningDialog";
import { AgentSidebar } from "./AgentSidebar";
import { AgentWorkspaceHeader } from "./AgentWorkspaceHeader";

const agent: FableAgentProfile = {
  id: "agent-1",
  name: "Mira",
  instructions: "Help with product writing.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

describe("quiet teammate surface", () => {
  it("keeps teammate switching and settings in the sidebar without product navigation", () => {
    const onCreateAgent = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <AgentSidebar
        agents={[agent]}
        activeAgentId={agent.id}
        previews={{
          [agent.id]: { message: "Draft launch copy", time: "09:30", status: "idle" }
        }}
        profileName="Local workspace"
        onSelectAgent={vi.fn()}
        onCreateAgent={onCreateAgent}
        onEditAgent={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    );

    expect(screen.getByText("Draft launch copy")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create teammate" }));
    fireEvent.click(screen.getByRole("button", { name: /Local workspace/i }));
    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("stores learned responsibilities without exposing a scheduler", () => {
    const onChange = vi.fn();
    render(
      <AgentLearningDialog
        open
        agent={agent}
        source={{ prompt: "Write a launch note", response: "Here is the note." }}
        onClose={vi.fn()}
        onChange={onChange}
        onRun={vi.fn()}
      />
    );

    expect(screen.queryByText(/routine/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Responsibility"), {
      target: { value: "Launch notes" }
    });
    fireEvent.change(screen.getByLabelText("What to repeat"), {
      target: { value: "Draft a concise launch note with evidence." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Teach task" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Launch notes",
        instruction: "Draft a concise launch note with evidence."
      })
    ]);
  });

  it("shows learned work and the teammate computer without team orchestration", () => {
    render(
      <AgentWorkspaceHeader
        agent={agent}
        learnedCount={2}
        learnedOpen={false}
        onOpenLearned={vi.fn()}
        newConversationDisabled={false}
        onNewConversation={vi.fn()}
        attentionCount={1}
        panelOpen={false}
        onTogglePanel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Learned work, 2/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open work panel, 1 needs attention/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /teammates/i })).not.toBeInTheDocument();
  });
});
