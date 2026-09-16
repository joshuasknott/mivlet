import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { AgentLearningDialog } from "./AgentLearningDialog";
import { AgentSidebar } from "./AgentSidebar";

const agent: MivletAgentProfile = {
  id: "agent-1",
  name: "Mira",
  instructions: "Help with product writing.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
};

describe("quiet agent surface", () => {
  it("opens projects and agents directly without standalone group routing", () => {
    const onSelect = vi.fn(),
      onSelectAgent = vi.fn(),
      onSelectProject = vi.fn();
    render(
      <AgentSidebar
        agents={[agent]}
        activeAgentId={agent.id}
        profileName="Local"
        connectors={[]}
        previews={{}}
        marketplaceActive={false}
        projects={[{ id: "project", name: "Launch", threadId: "main" }]}
        conversations={[
          {
            id: "private",
            title: "Private draft",
            kind: "direct",
            participants: [{ agentId: agent.id }],
          },
          {
            id: "focused",
            title: "Shared plan",
            kind: "group",
            projectId: "project",
          },
          {
            id: "group",
            title: "Review group",
            kind: "group",
            participants: [
              { agentId: agent.id, name: "Mira" },
              { agentId: "missing", name: "Former teammate" },
            ],
          },
        ]}
        onSelectConversation={onSelect}
        onSelectProject={onSelectProject}
        onCreateProject={vi.fn()}
        onSelectAgent={onSelectAgent}
        onCreateAgent={vi.fn()}
        onEditAgent={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenUsage={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    // Legacy standalone groups are not routed from the sidebar; they stay
    // reachable by reference through search and migrate into projects through
    // the conversation menu.
    expect(screen.queryByRole("button", { name: /Review group/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New group" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mira" }));
    expect(onSelectAgent).toHaveBeenCalledWith(agent);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(onSelectProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project" }),
    );
    expect(screen.queryByRole("button", { name: "Private draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shared plan" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Show conversations/ }),
    ).toBeNull();
  });
  it("keeps agents reachable in collapsed navigation even after a search", () => {
    const onSelectAgent = vi.fn();
    const sidebar = (collapsed: boolean) => (
      <AgentSidebar
        agents={[agent]}
        activeAgentId={agent.id}
        profileName="Local"
        connectors={[]}
        previews={{}}
        marketplaceActive={false}
        onSelectAgent={onSelectAgent}
        onCreateAgent={vi.fn()}
        onEditAgent={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenUsage={vi.fn()}
        onSignOut={vi.fn()}
        collapsed={collapsed}
        onToggleCollapsed={vi.fn()}
      />
    );
    const view = render(sidebar(false));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "No match" },
    });
    expect(screen.queryByRole("button", { name: /^Mira/ })).toBeNull();
    view.rerender(sidebar(true));
    expect(
      screen.getByRole("button", { name: "Expand navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Mira" }));
    expect(onSelectAgent).toHaveBeenCalledWith(agent);
  });
  it("shows work in progress, then a completion dot until selected, and rearms for the next task", () => {
    const onSelectAgent = vi.fn();
    const sidebar = (presence: "idle" | "working" | "service" | "done" | "waiting" | "blocked", completionId = "turn-1") => (
      <AgentSidebar agents={[agent]} activeAgentId={agent.id} profileName="Local" connectors={[]}
        marketplaceActive={false} previews={{ [agent.id]: { message: "Draft", time: "", presence,
          status: presence === "working" || presence === "service" ? "running" : "idle", completionId } }}
        onSelectAgent={onSelectAgent} onCreateAgent={vi.fn()} onEditAgent={vi.fn()}
        onOpenMarketplace={vi.fn()} onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} onSignOut={vi.fn()} />
    );
    const { rerender } = render(sidebar("idle"));
    expect(screen.getByRole("img", { name: "Mivlet" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(sidebar("working"));
    expect(screen.getByRole("status", { name: "Working" })).toHaveClass("agent-status--working");
    rerender(sidebar("service"));
    expect(screen.getByRole("status", { name: "Waiting for provider" })).toHaveClass("agent-status--service");
    expect(screen.getByRole("status", { name: "Waiting for provider" })).not.toHaveClass("agent-status--working");
    rerender(sidebar("done"));
    expect(
      screen.getByRole("status", { name: "New completed work" }),
    ).toHaveClass("agent-status--unread");
    rerender(sidebar("idle"));
    expect(
      screen.getByRole("status", { name: "New completed work" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Mira" }));
    expect(onSelectAgent).toHaveBeenCalledOnce();
    rerender(sidebar("done"));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(sidebar("working", "turn-2"));
    rerender(sidebar("waiting", "turn-2"));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(sidebar("blocked", "turn-2"));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(sidebar("done", "turn-2"));
    expect(
      screen.getByRole("status", { name: "New completed work" }),
    ).toBeVisible();
  });

  it("keeps agent switching and settings in the sidebar without product navigation", () => {
    const onCreateAgent = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenMarketplace = vi.fn();
    render(
      <AgentSidebar
        agents={[agent]}
        activeAgentId={agent.id}
        previews={{
          [agent.id]: {
            message: "Draft launch copy",
            time: "09:30",
            status: "idle",
          },
        }}
        profileName="Local workspace"
        connectors={[]}
        marketplaceActive={false}
        onSelectAgent={vi.fn()}
        onCreateAgent={onCreateAgent}
        onEditAgent={vi.fn()}
        onOpenMarketplace={onOpenMarketplace}
        onOpenSettings={onOpenSettings}
        onOpenUsage={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Mira" })).toBeVisible();
    expect(screen.getByText("Draft launch copy")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Search" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Plugins/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    fireEvent.click(screen.getByRole("button", { name: /Local workspace/i }));
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(onOpenMarketplace).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("stores learned responsibilities without exposing a scheduler", () => {
    const onChange = vi.fn();
    render(
      <AgentLearningDialog
        open
        agent={agent}
        startCreating
        onClose={vi.fn()}
        onChange={onChange}
        onRun={vi.fn()}
      />,
    );

    expect(screen.queryByText(/routine/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Responsibility"), {
      target: { value: "Launch notes" },
    });
    fireEvent.change(screen.getByLabelText("What to repeat"), {
      target: { value: "Draft a concise launch note with evidence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Teach task" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Launch notes",
        instruction: "Draft a concise launch note with evidence.",
      }),
    ]);
  });

  it("opens the real skill form from the marketplace create action", () => {
    render(
      <AgentLearningDialog
        open
        agent={agent}
        startCreating
        onClose={vi.fn()}
        onChange={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Responsibility")).toBeVisible();
    expect(screen.getByLabelText("What to repeat")).toBeVisible();
  });

});
