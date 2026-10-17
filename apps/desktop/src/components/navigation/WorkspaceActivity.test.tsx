import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, WorkStatus } from "@mivlet/protocol";
import { WorkspaceActivity } from "./WorkspaceActivity";

vi.mock("../agents/agent-icons", () => ({
  ProfileAgentAvatar: () => <span />,
}));
const item = (id: string, status: WorkStatus = "running") =>
  ({
    id,
    status,
    prompt: "Task " + id,
    userRequest: "Task " + id,
    agentId: "mira",
    agentName: "Mira",
    updatedAt: "2026-10-15T09:00:00Z",
  }) as CollaborationWorkItem;
const props = (work: CollaborationWorkItem[] = []) => ({
  workspaceId: "workspace",
  work,
  agents: [],
  files: [],
  memories: [],
  memoryDisabled: false,
  onInspect: vi.fn(),
  onStop: vi.fn().mockResolvedValue(undefined),
  onOpen: vi.fn(),
  onNavigate: vi.fn(),
});

describe("bounded Activity summary", () => {
  it("keeps a large output collection in a closed disclosure with a bounded preview and a Files link", () => {
    const input = { ...props(), files: Array.from({ length: 150 }, (_, index) => ({
      id: "output-" + index, title: "Output " + index + ".md", detail: "Created here", origin: "created" as const, updatedAt: "2026-10-17",
      tab: { id: "output-" + index, kind: "file" as const, title: "Output " + index + ".md", text: "Retained file contents" },
    })) };
    render(<WorkspaceActivity {...input} />);
    expect(screen.getByText("Output 0.md")).not.toBeVisible();
    fireEvent.click(screen.getByText("Recent files"));
    expect(screen.getAllByRole("button", { name: /^Open Output/ })).toHaveLength(2);
    expect(screen.queryByText("Output 149.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View all files" }));
    expect(input.onNavigate).toHaveBeenCalledWith("files");
  });


  it("shows only the latest completed work and a bounded timeline with exact work navigation", () => {
    const input = props(
      Array.from({ length: 150 }, (_, index) =>
        item("done-" + index, "completed"),
      ),
    );
    render(<WorkspaceActivity {...input} />);
    expect(
      screen.getByRole("region", { name: "Latest completed work" }),
    ).toBeVisible();
    expect(
      screen
        .getByRole("region", { name: "Recent activity" })
        .querySelectorAll("li"),
    ).toHaveLength(3);
    expect(screen.queryByText("Task done-149")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View result" }));
    expect(input.onInspect).toHaveBeenCalledWith("done-0");
    expect(input.onNavigate).toHaveBeenCalledWith("history");
  });

  it("keeps a large completed history out of the current-work overview", () => {
    const input = props([
      ...Array.from({ length: 200 }, (_, index) =>
        item("finished-" + index, "completed"),
      ),
      ...Array.from({ length: 12 }, (_, index) => item(String(index))),
      item("review", "awaiting-user"),
    ]);
    render(<WorkspaceActivity {...input} />);
    expect(screen.queryByText("Task finished-0")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Task/ })).toHaveLength(4);
    expect(screen.getByText("Task review")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "View all 13 active assignments" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(input.onInspect).toHaveBeenCalledWith("review");
    expect(input.onNavigate).toHaveBeenCalledWith("history");
  });

  it("stops only the selected assignment and reports a rejected Stop", async () => {
    const input = props([item("one"), item("two")]);
    input.onStop.mockRejectedValueOnce(
      new Error("The execution changed. Refresh first."),
    );
    render(<WorkspaceActivity {...input} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Stop" })[1]);
    expect(input.onStop).toHaveBeenCalledWith("two");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The execution changed",
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(2),
    );
  });

  it("never offers a fabricated completed-result review when nothing is active", () => {
    render(<WorkspaceActivity {...props([item("completed", "completed")])} />);
    expect(screen.getByRole("button", { name: "View result" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });
});
