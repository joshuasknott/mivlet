import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage, type ProjectKnowledgeView, type ProjectPageRecord } from "./ProjectPage";

const project: ProjectPageRecord = {
  id: "project-1",
  title: "Launch",
  description: "Prepare the release.",
  instructions: "Keep the writing clear.",
  lifecycle: "active",
  revision: 3,
  threads: [{
    id: "thread-project",
    title: "Release notes",
    kind: "project",
    description: "Project conversation",
    updatedAt: "2026-07-11T10:00:00Z",
    pinnedContextIds: []
  }]
};

const emptyKnowledge: ProjectKnowledgeView = {
  sources: [],
  loading: false,
  error: null,
  refresh: async () => undefined,
  importFile: async () => undefined,
  search: async () => []
};

describe("ProjectPage", () => {
  it("edits durable guidance and opens only the supplied project conversations", async () => {
    const user = userEvent.setup();
    const onSaveGuidance = vi.fn().mockResolvedValue(undefined);
    const onSelectThread = vi.fn();
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        onSaveGuidance={onSaveGuidance}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={onSelectThread}
      />
    );

    expect(screen.getByRole("heading", { name: "Launch" })).toBeInTheDocument();
    expect(screen.getByText("Keep the writing clear.")).toBeInTheDocument();
    expect(screen.queryByText("Standalone chat")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit guidance" }));
    const guidance = screen.getByLabelText("Guidance for Fable");
    await user.clear(guidance);
    await user.type(guidance, "Use plain language.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaveGuidance).toHaveBeenCalledWith({
      description: "Prepare the release.",
      instructions: "Use plain language."
    }));

    await user.click(screen.getByRole("button", { name: /release notes/i }));
    expect(onSelectThread).toHaveBeenCalledWith(project.threads[0]);
  });

  it("keeps conflict errors visible and offers a reload", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        onSaveGuidance={vi.fn().mockRejectedValue(new Error("Project revision changed"))}
        onReload={onReload}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit guidance" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed somewhere else");
    await user.click(screen.getByRole("button", { name: "Reload project" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("shows a calm empty conversation state and starts a project chat", async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(
      <ProjectPage
        project={{ ...project, threads: [] }}
        knowledge={emptyKnowledge}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={onNewChat}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("No conversations yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("shows only supplied project knowledge and imports a supported file", async () => {
    const user = userEvent.setup();
    const importFile = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectPage
        project={project}
        knowledge={{
          ...emptyKnowledge,
          sources: [{ id: "source-project", title: "Launch brief", provenance: "Local file", freshness: "Updated today", status: "ok" }],
          importFile
        }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    expect(screen.getByRole("list", { name: "Project knowledge sources" })).toHaveTextContent("Launch brief");
    expect(screen.queryByText("Other workspace source")).not.toBeInTheDocument();
    const file = new File(["# Launch"], "launch.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Choose a project knowledge file"), file);
    await waitFor(() => expect(importFile).toHaveBeenCalledWith(file));
  });

  it("searches through the authorized project callback", async () => {
    const user = userEvent.setup();
    const search = vi.fn().mockResolvedValue([
      { id: "result-1", title: "Pricing notes", provenance: "Local file", freshness: "Updated yesterday", status: "ok" }
    ]);
    render(
      <ProjectPage
        project={project}
        knowledge={{ ...emptyKnowledge, sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Updated today" }], search }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.type(screen.getByRole("searchbox", { name: "Search project knowledge" }), "pricing");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenCalledWith("pricing");
    expect(await screen.findByText("Pricing notes")).toBeInTheDocument();
    expect(screen.queryByText("Launch brief")).not.toBeInTheDocument();
  });

  it("preserves native authorization errors from project search", async () => {
    const user = userEvent.setup();
    render(
      <ProjectPage
        project={project}
        knowledge={{ ...emptyKnowledge, search: vi.fn().mockRejectedValue(new Error("Project knowledge is unavailable for this workspace.")) }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.type(screen.getByRole("searchbox", { name: "Search project knowledge" }), "roadmap");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Project knowledge is unavailable for this workspace.");
  });

  it("keeps archived knowledge read-only and exposes load recovery", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ProjectPage
        project={{ ...project, lifecycle: "archived" }}
        knowledge={{ ...emptyKnowledge, error: "Project knowledge could not be loaded.", refresh }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add files" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(
      <ProjectPage
        project={{ ...project, lifecycle: "archived" }}
        knowledge={{ ...emptyKnowledge, loading: true }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading project knowledge");
  });
});
