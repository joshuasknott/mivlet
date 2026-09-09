import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { AgentSidebar } from "../agents/AgentSidebar";
import {
  ProjectEditor,
  ProjectFiles,
  ProjectParticipants,
} from "./ProjectWorkspace";

const agent: FableAgentProfile = {
  id: "agent-1",
  name: "Mira",
  instructions: "Review the launch copy.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
};

describe("project room components", () => {
  it("adds project navigation above the existing agent list", () => {
    const onSelectProject = vi.fn();
    render(
      <AgentSidebar
        agents={[agent]}
        activeAgentId={agent.id}
        previews={{}}
        profileName="Local"
        connectors={[]}
        marketplaceActive={false}
        projects={[{ id: "project-1", name: "Website launch" }]}
        selectedProjectId="project-1"
        onSelectProject={onSelectProject}
        onCreateProject={vi.fn()}
        onSelectAgent={vi.fn()}
        onCreateAgent={vi.fn()}
        onEditAgent={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenUsage={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    const project = screen.getByRole("button", { name: /Website launch/ });
    expect(project).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: /Mira Start a conversation/ }),
    ).not.toHaveAttribute("aria-current");
    fireEvent.click(project);
    expect(onSelectProject).toHaveBeenCalledWith({
      id: "project-1",
      name: "Website launch",
    });
  });

  it("routes a project message to all agents or one selected agent", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ProjectParticipants
        agents={[agent]}
        recipientAgentId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /All agents/ }));
    const picker = screen.getByRole("dialog", {
      name: "Choose who should answer",
    });
    await waitFor(() =>
      expect(
        within(picker).getByRole("option", { name: /All agents/ }),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(within(picker).getByRole("option", { name: /Mira/ })).toHaveFocus();
    fireEvent.click(within(picker).getByRole("option", { name: /Mira/ }));
    expect(onSelect).toHaveBeenCalledWith("agent-1");

    rerender(
      <ProjectParticipants
        agents={[agent]}
        recipientAgentId="agent-1"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Mira/ }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("option", {
        name: /All agents/,
      }),
    );
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("attaches only real eligible source ids and removes by source id", () => {
    const onAttach = vi.fn();
    const onRemove = vi.fn();
    const onOpen = vi.fn();
    render(
      <ProjectFiles
        files={[
          {
            sourceId: "source-brief",
            name: "Brief.md",
            mediaType: "text/markdown",
            sizeBytes: 3072,
          },
        ]}
        eligibleSources={[
          { sourceId: "source-brief", name: "Brief.md" },
          {
            sourceId: "source-research",
            name: "Research.md",
            provenance: "Local file · 8 KB",
          },
        ]}
        onAttach={onAttach}
        onRemove={onRemove}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add project file" }));
    expect(
      screen.queryByText("All matching files are already attached."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Research.md/ }));
    expect(onAttach).toHaveBeenCalledWith("source-research");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Brief.md from project",
      }),
    );
    expect(onRemove).toHaveBeenCalledWith("source-brief");
    fireEvent.click(screen.getByRole("button", { name: /^Brief.md MARKDOWN/ }));
    expect(onOpen).toHaveBeenCalledWith("source-brief");
  });

  it("creates a project with trimmed name and optional instructions", () => {
    const onSave = vi.fn();
    render(
      <ProjectEditor open project={null} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Website launch  " },
    });
    fireEvent.change(screen.getByLabelText(/Instructions/), {
      target: { value: "  Keep the tone concise.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(onSave).toHaveBeenCalledWith({
      name: "Website launch",
      instructions: "Keep the tone concise.",
    });
  });

  it("locks the editor while saving and exposes archive as the destructive action", () => {
    render(
      <ProjectEditor
        open
        project={{ id: "project-1", name: "Launch", instructions: "Ship it." }}
        pending
        error="The project changed. Reload it and try again."
        onClose={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("project changed");
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Close project editor" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
