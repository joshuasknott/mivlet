import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage, type ProjectKnowledgeView, type ProjectMemoryView, type ProjectPageRecord } from "./ProjectPage";
import type { ProjectActivityView } from "../../hooks/useProjectActivity";
import { getRuntimeArtifact } from "../../runtime";

vi.mock("../../runtime", () => ({
  acceptRuntimeArtifactHandoff: vi.fn(),
  exportRuntimeArtifact: vi.fn(),
  getRuntimeArtifact: vi.fn(),
  getRuntimeArtifactSourceProjectId: vi.fn(async () => null),
  proposeRuntimeArtifactHandoff: vi.fn()
}));
vi.mock("../../lib/project-runtime", () => ({
  listRuntimeProjects: vi.fn(async () => [])
}));

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
  actionStatus: null,
  refresh: async () => undefined,
  importFile: async () => undefined,
  search: async () => [],
  toggleDisabled: async () => undefined,
  remove: async () => undefined,
  updateFile: async () => undefined
};

const emptyMemory: ProjectMemoryView = {
  records: [],
  disabled: false,
  loading: false,
  error: null,
  refresh: async () => undefined,
  promote: async () => undefined,
  edit: async () => undefined,
  togglePin: async () => undefined,
  toggleDisabled: async () => undefined,
  forget: async () => undefined,
  exportText: async () => "# Memory export"
};

const projectActivity: ProjectActivityView = {
  missions: [{
    runId: "run-1",
    threadId: "thread-project",
    title: "Prepare launch",
    state: "Waiting",
    detail: "2 of 3 steps · Review the final draft.",
    conversation: "Release notes"
  }],
  routines: [{
    id: "routine-1",
    title: "Weekly launch check",
    lifecycle: "active",
    revision: 3,
    status: "Active",
    detail: "Weekly schedule"
  }],
  artifacts: [{
    id: "artifact-1",
    title: "Launch brief",
    status: "Accepted",
    detail: "Document · Version 2"
  }],
  connections: [{
    id: "connection-1",
    name: "GitHub · work",
    status: "Available"
  }],
  connectionOptions: [{
    id: "connection-1",
    name: "GitHub · work",
    status: "Available",
    selectable: true
  }],
  loading: false,
  error: null,
  truncated: false,
  refresh: async () => undefined,
  changeRoutine: async () => undefined
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

  it("shows scoped project activity and opens a Mission's project conversation", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        activity={projectActivity}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={onSelectThread}
      />
    );

    expect(screen.getByRole("list", { name: "Project Mission runs" }))
      .toHaveTextContent("Prepare launch");
    expect(screen.getByRole("list", { name: "Project Routines" }))
      .toHaveTextContent("Weekly launch check");
    expect(screen.getByRole("list", { name: "Project Artifacts" }))
      .toHaveTextContent("Launch brief");
    expect(screen.getByRole("list", { name: "Connections used by this project" }))
      .toHaveTextContent("GitHub · workAvailable");
    await user.click(screen.getByRole("button", { name: /prepare launch/i }));
    expect(onSelectThread).toHaveBeenCalledWith(project.threads[0]);
  });

  it("deliberately selects existing Connections without implying a grant", async () => {
    const user = userEvent.setup();
    const onSaveConnections = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectPage
        project={{ ...project, connectionIds: [] }}
        knowledge={emptyKnowledge}
        activity={projectActivity}
        onSaveGuidance={vi.fn()}
        onSaveConnections={onSaveConnections}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    expect(screen.getByText(/does not grant new access/i)).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("listbox", { name: "Connections available to this Project" }),
      "connection-1"
    );
    await user.click(screen.getByRole("button", { name: "Save Connections" }));
    await waitFor(() => expect(onSaveConnections).toHaveBeenCalledWith(["connection-1"]));
    expect(await screen.findByRole("status")).toHaveTextContent("Project Connections saved.");
  });

  it("changes a Project Routine through its exact revision-fenced action", async () => {
    const user = userEvent.setup();
    const changeRoutine = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        activity={{ ...projectActivity, changeRoutine }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(changeRoutine).toHaveBeenCalledWith(
      projectActivity.routines[0],
      "pause"
    ));
    expect(screen.getByRole("status")).toHaveTextContent("Routine paused.");
  });

  it("opens the complete exact Project Artifact detail", async () => {
    const user = userEvent.setup();
    vi.mocked(getRuntimeArtifact).mockResolvedValue({
      artifact: {
        id: "artifact-1",
        title: "Launch brief",
        kind: "document",
        status: "accepted",
        context: { workspaceId: "workspace-1", projectId: "project-1" },
        ownerMemberId: "member-1",
        sourceProvenance: [],
        reviews: [{
          id: "review-1",
          versionId: "version-1",
          status: "accepted"
        }]
      },
      currentVersion: {
        id: "version-1",
        version: 1,
        content: { kind: "inline", text: "Approved launch copy." },
        provenance: { kind: "run" },
        citations: [{ id: "citation-1", label: "Release source" }]
      },
      versions: [{
        id: "version-1",
        version: 1,
        content: { kind: "inline", text: "Approved launch copy." },
        provenance: { kind: "run" },
        citations: [{ id: "citation-1", label: "Release source" }]
      }]
    } as never);
    render(
      <ProjectPage
        project={project}
        workspaceId="workspace-1"
        knowledge={emptyKnowledge}
        activity={projectActivity}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /Launch brief/i }));
    const detail = await screen.findByRole("region", {
      name: "Artifact details for Launch brief"
    });
    expect(detail).toHaveTextContent("Approved launch copy.");
    expect(detail).toHaveTextContent("Review: Accepted");
    expect(detail).toHaveTextContent("Release source");
  });

  it("surfaces project activity failures and retries the exact read", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        activity={{
          ...projectActivity,
          missions: [],
          routines: [],
          artifacts: [],
          connections: [],
          error: "Project activity is unavailable.",
          refresh
        }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Project activity is unavailable.");
    expect(screen.queryByText("No Mission runs yet.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
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
        activity={projectActivity}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add files" })).not.toBeInTheDocument();
    expect(screen.getByText("Project conversation · Read only")).toBeInTheDocument();
    expect(screen.getByText("Prepare launch").closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
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

  it("remembers a project knowledge source through the deliberate callback", async () => {
    const user = userEvent.setup();
    const promote = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectPage
        project={project}
        knowledge={{ ...emptyKnowledge, sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today" }] }}
        memory={{ ...emptyMemory, promote }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith("source-1"));
  });

  it("edits, pins, disables and forgets a project memory with confirmation", async () => {
    const user = userEvent.setup();
    const edit = vi.fn().mockResolvedValue(undefined);
    const togglePin = vi.fn().mockResolvedValue(undefined);
    const toggleDisabled = vi.fn().mockResolvedValue(undefined);
    const forget = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        memory={{
          ...emptyMemory,
          records: [{ id: "memory-1", title: "Launch date", value: "Friday", source: "Launch brief", freshness: "Approved now", pinned: false, disabled: false }],
          edit,
          togglePin,
          toggleDisabled,
          forget
        }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("What Fable should remember"));
    await user.type(screen.getByLabelText("What Fable should remember"), "Monday");
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    expect(edit).toHaveBeenCalledWith("memory-1", { title: "Launch date", value: "Monday" });
    await user.click(screen.getByRole("button", { name: "Pin" }));
    expect(togglePin).toHaveBeenCalledWith("memory-1");
    await user.click(screen.getByRole("button", { name: "Stop using" }));
    expect(toggleDisabled).toHaveBeenCalledWith("memory-1");
    await user.click(screen.getByRole("button", { name: "Forget" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith("memory-1");
  });

  it("keeps long remembered documents calm until the user edits them", () => {
    const longValue = `Important launch context ${"with supporting detail ".repeat(30)}`;
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        memory={{
          ...emptyMemory,
          records: [{ id: "memory-1", title: "Launch brief", value: longValue, source: "Local file", freshness: "Approved now", pinned: true, disabled: false }]
        }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    const summary = screen.getByText((content) => content.startsWith("Important launch context"));
    expect(summary.textContent?.length).toBeLessThanOrEqual(280);
    expect(summary).toHaveTextContent(/\.\.\.$/);
    expect(screen.queryByText(longValue)).not.toBeInTheDocument();
  });

  it("keeps archived memory readable and exportable but hides every mutation", async () => {
    const user = userEvent.setup();
    const exportText = vi.fn().mockResolvedValue("# Memory export\n\nLaunch date");
    render(
      <ProjectPage
        project={{ ...project, lifecycle: "archived" }}
        knowledge={{ ...emptyKnowledge, sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today" }] }}
        memory={{
          ...emptyMemory,
          records: [{ id: "memory-1", title: "Launch date", value: "Friday", source: "Launch brief", freshness: "Approved now", pinned: true, disabled: false }],
          exportText
        }}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Archived projects are read only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit guidance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remember" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose a project knowledge file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByLabelText("Project memory export")).toHaveTextContent("Launch date");
  });

  it("disables, re-enables, and confirms deletion of project sources", async () => {
    const user = userEvent.setup();
    const toggleDisabled = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = render(
      <ProjectPage
        project={project}
        knowledge={{
          ...emptyKnowledge,
          sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today" }],
          toggleDisabled,
          remove
        }}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Stop using" }));
    expect(toggleDisabled).toHaveBeenCalledWith("source-1");

    rerender(
      <ProjectPage
        project={project}
        knowledge={{
          ...emptyKnowledge,
          sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today", disabled: true }],
          toggleDisabled,
          remove
        }}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Not in use")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remember" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use again" }));
    expect(toggleDisabled).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(window.confirm).toHaveBeenCalledWith('Delete "Launch brief" from this project?');
    expect(remove).toHaveBeenCalledWith("source-1");
  });

  it("hides project source lifecycle controls when archived", () => {
    render(
      <ProjectPage
        project={{ ...project, lifecycle: "archived" }}
        knowledge={{ ...emptyKnowledge, sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today", disabled: true }] }}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Not in use")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose the current version of Launch brief")).not.toBeInTheDocument();
  });

  it("surfaces native project source lifecycle rejections", async () => {
    const user = userEvent.setup();
    render(
      <ProjectPage
        project={project}
        knowledge={{
          ...emptyKnowledge,
          sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today" }],
          toggleDisabled: vi.fn().mockRejectedValue(new Error("Archived projects are read-only."))
        }}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Stop using" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Archived projects are read-only.");
  });

  it("chooses a one-shot current file for project source updates", async () => {
    const user = userEvent.setup();
    let finishUpdate!: () => void;
    const updateFile = vi.fn(() => new Promise<void>((resolve) => { finishUpdate = resolve; }));
    render(
      <ProjectPage
        project={project}
        knowledge={{ ...emptyKnowledge, sources: [{ id: "source-1", title: "Launch brief", provenance: "Local file", freshness: "Today" }], updateFile }}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
      />
    );
    expect(screen.getByText("Choose the current version of this file. Fable won't keep access to its location.")).toBeInTheDocument();
    const file = new File(["new"], "launch.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Choose the current version of Launch brief"), file);
    expect(screen.getByText("Updating...")).toBeInTheDocument();
    await waitFor(() => expect(updateFile).toHaveBeenCalledWith("source-1", file));
    finishUpdate();
    await waitFor(() => expect(screen.queryByText("Updating...")).not.toBeInTheDocument());
  });

  it("exports an exact project copy to a new local file", async () => {
    const user = userEvent.setup();
    const onExportCopy = vi.fn().mockResolvedValue(true);
    render(
      <ProjectPage
        project={project}
        knowledge={emptyKnowledge}
        memory={emptyMemory}
        onSaveGuidance={vi.fn()}
        onReload={vi.fn()}
        onNewChat={vi.fn()}
        onSelectThread={vi.fn()}
        onExportCopy={onExportCopy}
      />
    );

    await user.type(
      screen.getByLabelText("New project-copy file"),
      "C:\\Exports\\launch.json"
    );
    await user.click(screen.getByRole("button", { name: "Export project copy" }));

    await waitFor(() => {
      expect(onExportCopy).toHaveBeenCalledWith("C:\\Exports\\launch.json");
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Project copy created.");
    expect(screen.getByLabelText("New project-copy file")).toHaveValue("");
  });
});
