import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "./AgentSidebar";
import { DEFAULT_SIDEBAR_PREFERENCES } from "../../lib/sidebar-preferences";
import { defaultShellState } from "../../hooks/shell-runtime/defaults";

const agents = Array.from({ length: 20 }, (_, index) => ({ ...defaultShellState.agents![0], id: `agent-${index}`, name: `Agent ${index}` }));
const projects = Array.from({ length: 40 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, threadId: `chat-${index}` }));
const props = {
  agents, projects, activeAgentId: agents[0].id, previews: {}, profileName: "Local", connectors: [], marketplaceActive: false,
  onSelectAgent: vi.fn(), onSelectProject: vi.fn(), onCreateAgent: vi.fn(), onCreateProject: vi.fn(), onNewConversation: vi.fn(),
  onOpenMarketplace: vi.fn(), onOpenSettings: vi.fn(), onOpenUsage: vi.fn(), onSignOut: vi.fn(),
};
const rows = (label: string) => [...screen.getByRole("region", { name: label }).querySelectorAll("[data-sidebar-entity]")]
  .map((node) => node.getAttribute("data-sidebar-entity"));

describe("inline workspace navigation", () => {
  it("keeps 40 projects and 20 agents inline, with stable mixed pins and activity ordering", () => {
    render(<AgentSidebar {...props} preferences={{ ...DEFAULT_SIDEBAR_PREFERENCES, pinned: [{ kind: "project", id: projects[0].id }, { kind: "agent", id: agents[0].id }] }}
      projectActivity={new Map([[projects[39].id, 100], [projects[0].id, 200]])} agentActivity={new Map([[agents[19].id, 100]])} />);
    expect(rows("Pinned")).toEqual(["project:project-0", "agent:agent-0"]);
    expect(rows("Projects")).toHaveLength(39);
    expect(rows("Agents")).toHaveLength(19);
    expect(rows("Projects")[0]).toBe("project:project-39");
    expect(rows("Agents")[0]).toBe("agent:agent-19");
    expect(screen.getAllByRole("button", { name: "Project 0" })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project 39" }));
    expect(props.onSelectProject).toHaveBeenCalledWith(projects[39]);
    fireEvent.click(screen.getByRole("button", { name: "Agent 19" }));
    expect(props.onSelectAgent).toHaveBeenCalledWith(agents[19]);
  });

  it("pins only entities and supports manual ordering without losing the previous manual order", () => {
    const onPreferencesChange = vi.fn();
    render(<AgentSidebar {...props} onPreferencesChange={onPreferencesChange}
      projectActivity={new Map([[projects[2].id, 100]])} conversations={[{ id: "chat", title: "Project chat", kind: "group", projectId: projects[0].id }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Organize Project 0" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(rows("Pinned")).toEqual(["project:project-0"]);
    fireEvent.click(screen.getByRole("button", { name: "Organize projects" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Manual order" }));
    expect(rows("Projects").slice(0, 2)).toEqual(["project:project-2", "project:project-1"]);
    fireEvent.click(screen.getByRole("button", { name: "Organize Project 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(rows("Projects").slice(0, 2)).toEqual(["project:project-1", "project:project-2"]);
    fireEvent.click(screen.getByRole("button", { name: "Organize projects" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Most recent" }));
    expect(rows("Projects")[0]).toBe("project:project-2");
    fireEvent.click(screen.getByRole("button", { name: "Organize projects" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Manual order" }));
    expect(rows("Projects")[0]).toBe("project:project-1");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Project chat" } });
    expect(screen.getByRole("button", { name: "Project chat" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Organize Project chat" })).toBeNull();
    expect(onPreferencesChange).toHaveBeenLastCalledWith(expect.objectContaining({ pinned: [{ kind: "project", id: "project-0" }], projectSort: "manual" }));
  });

  it("collapses in place and keeps menus keyboard reachable with focus restoration", () => {
    render(<AgentSidebar {...props} />);
    const projectsToggle = screen.getByRole("button", { name: "Projects" });
    const list = document.getElementById(projectsToggle.getAttribute("aria-controls")!)!;
    list.scrollTop = 250;
    fireEvent.click(projectsToggle);
    expect(projectsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Project 0" })).toBeNull();
    expect(screen.getByRole("button", { name: "Agent 0" })).toBeVisible();
    fireEvent.click(projectsToggle);
    expect(list.scrollTop).toBe(0);
    const trigger = screen.getByRole("button", { name: "Organize projects" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "Most recent" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "Manual order" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("creates the right object directly and opens workspace search", () => {
    const onSearch = vi.fn();
    render(<AgentSidebar {...props} onSearch={onSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Search workspace" }));
    expect(props.onNewConversation).toHaveBeenCalled();
    expect(props.onCreateProject).toHaveBeenCalled();
    expect(props.onCreateAgent).toHaveBeenCalled();
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("keeps the empty Projects state concise and leaves creation in the section action", () => {
    render(<AgentSidebar {...props} projects={[]} />);
    expect(screen.getByText("No projects yet")).toBeVisible();
    expect(screen.queryByText("Keep related chats together.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Organize projects" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create project" })).toBeVisible();
  });

  it("shows Needs you only while actionable work remains and opens its exact target", () => {
    const item = { id: "waiting", conversationId: "chat-2", agentId: "agent-1", label: "Launch review", detail: "Agent 1 · Approval needed", kind: "approval" as const, count: 2 };
    const onOpenAttention = vi.fn();
    const view = render(<AgentSidebar {...props} attention={[item]} onOpenAttention={onOpenAttention} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Needs you" })).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: /Launch review/ }));
    expect(onOpenAttention).toHaveBeenCalledWith(item);
    view.rerender(<AgentSidebar {...props} attention={[]} onOpenAttention={onOpenAttention} />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });
});
