import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage, type ProjectPageRecord } from "./ProjectPage";

const project: ProjectPageRecord = {
  id: "project-1",
  title: "Launch",
  description: "Prepare the release.",
  instructions: "Keep the writing clear.",
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

describe("ProjectPage", () => {
  it("edits durable guidance and opens only the supplied project conversations", async () => {
    const user = userEvent.setup();
    const onSaveGuidance = vi.fn().mockResolvedValue(undefined);
    const onSelectThread = vi.fn();
    render(
      <ProjectPage
        project={project}
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
});
