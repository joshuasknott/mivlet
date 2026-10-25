import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import type { WorkspaceExecution } from "../../lib/workspace-execution";
import { ConversationWorkControls } from "./ConversationWorkControls";

vi.mock("../hosted/HostedTaskControls", () => ({ HostedTaskControls: ({ item }: { item: CollaborationWorkItem }) => <div data-testid="cloud-control">Cloud control {item.id}</div> }));

const item = (id: string, patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
  id, rootId: id, workspaceId: "workspace", conversationId: "room", agentId: "agent", agentName: "Atlas",
  prompt: `Request ${id}`, userRequest: `Request ${id}`, permissionMode: "read-only", status: "queued",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, generation: 4,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 0, tokenUsage: 0,
  maxTurns: 6, maxTokens: 128000, runIds: [], modelOptionId: "codex::fixture", outputs: [],
  createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", queue: { order: 1, held: false }, ...patch,
});
function setup(work: CollaborationWorkItem[], command = vi.fn().mockResolvedValue({ work })) {
  const service = { command, stop: vi.fn().mockResolvedValue(undefined), steerQueued: vi.fn().mockResolvedValue(undefined) } as unknown as WorkspaceExecution;
  const onGoalDraftChange = vi.fn();
  render(<ConversationWorkControls work={work} conversationId="room" service={service} onGoalDraftChange={onGoalDraftChange} />);
  return { service, command, onGoalDraftChange };
}

describe("conversation Work controls", () => {
  it("keeps reconciled cloud history out of the composer while unresolved work stays reachable", async () => {
    const hosted = (phase: NonNullable<CollaborationWorkItem["hostedTask"]>["phase"]) => ({ phase }) as NonNullable<CollaborationWorkItem["hostedTask"]>;
    setup([item("old", { status: "completed", hostedTask: hosted("reconciled") }), item("pending", { status: "awaiting-user", hostedTask: hosted("reconcile-required") })]);
    expect(await screen.findByText("Cloud control pending")).toBeVisible();
    expect(screen.queryByText("Cloud control old")).toBeNull();
  });
  it("uses exact generation-bound queue edits and preserves failed input", async () => {
    const command = vi.fn().mockRejectedValue(new Error("The request already started."));
    setup([item("one")], command);
    fireEvent.click(screen.getByRole("button", { name: "Options for queued request 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit queued request" }), { target: { value: "Check keyboard navigation" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(command).toHaveBeenCalledWith({ action: "edit-queued-work", id: "one", expectedGeneration: 4, prompt: "Check keyboard navigation" });
    expect(screen.getByRole("alert")).toHaveTextContent("The request already started.");
    expect(screen.getByRole("textbox", { name: "Edit queued request" })).toHaveValue("Check keyboard navigation");
  });

  it("moves, pauses and removes queued roots without touching running work", async () => {
    const { command, service } = setup([item("running", { status: "running", currentRunId: "run", runIds: ["run"] }), item("one"), item("two", { queue: { order: 2, held: false } })]);
    fireEvent.click(screen.getByRole("button", { name: "Options for queued request 1" }));
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Options for queued request 2" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Move up" })));
    expect(command).toHaveBeenLastCalledWith({ action: "move-queued-work", id: "two", expectedGeneration: 4, beforeId: "one" });
    fireEvent.click(screen.getByRole("button", { name: "Options for queued request 1" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Pause" })));
    expect(command).toHaveBeenLastCalledWith({ action: "set-work-held", id: "one", expectedGeneration: 4, held: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove queued request 1" })));
    expect(service.stop).toHaveBeenCalledWith("one");
    expect(screen.queryByText("Request running")).toBeNull();
  });

  it("does not render an idle outcome goal affordance or leave an empty controls gap", () => {
    const { onGoalDraftChange } = setup([]);
    expect(screen.queryByRole("button", { name: "Add an outcome goal" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Goal and queued requests" })).toBeNull();
    expect(onGoalDraftChange).not.toHaveBeenCalled();
  });

  it("shows only the queued message and compact actions before opening options", async () => {
    const { service } = setup([item("active", { status: "running", currentRunId: "run", runIds: ["run"] }), item("one")]);
    expect(screen.queryByText("Guide active work")).toBeNull();
    expect(screen.queryByText(/Up next/)).toBeNull();
    expect(screen.queryByText("Atlas")).toBeNull();
    expect(screen.queryByText("Cloud options")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Steer with queued request 1" })));
    expect(service.steerQueued).toHaveBeenCalledWith("one", 4);
  });

  it("leaves no guidance button or empty controls gap while an agent is running", () => {
    setup([item("active", { status: "running", currentRunId: "run", runIds: ["run"] })]);
    expect(screen.queryByRole("region", { name: "Goal and queued requests" })).toBeNull();
  });

  it("opens queue options with the keyboard and restores focus on Escape", async () => {
    const user = userEvent.setup();
    setup([item("one")]);
    const trigger = screen.getByRole("button", { name: "Options for queued request 1" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps cloud review reachable in queue options", async () => {
    setup([item("one")]);
    fireEvent.click(screen.getByRole("button", { name: "Options for queued request 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cloud options" }));
    expect(await screen.findByText("Cloud control one")).toBeVisible();
  });

  it.each(["completed", "blocked", "budget-exhausted"] as const)("allows a new goal after a %s report while retaining its history", (status) => {
    const { onGoalDraftChange, command } = setup([item("previous", { status: "completed", outcomeGoal: {
      objective: "Previous outcome", successCriteria: "Previous evidence", status,
    } })]);
    expect(screen.getByText("Goal: Previous outcome")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New goal for next request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Outcome" }), { target: { value: "Next outcome" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Success criteria" }), { target: { value: "Next evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Use for next request" }));
    expect(onGoalDraftChange).toHaveBeenCalledWith({ objective: "Next outcome", successCriteria: "Next evidence", maxTurns: 6, maxTokens: 128000 });
    expect(command).not.toHaveBeenCalled();
    expect(screen.getByText("Goal: Previous outcome")).toBeTruthy();
  });

  it.each([
    { modelOptionId: "claude::fixture" },
    { executionOwner: "native-background" as const },
    { agentId: "another-agent" },
    { status: "awaiting-approval" as const },
  ])("disables steering without a supported matching foreground turn: %j", (patch) => {
    const { service } = setup([item("active", { status: "running", currentRunId: "run", runIds: ["run"], ...patch }), item("one")]);
    const steer = screen.getByRole("button", { name: "Steer with queued request 1" });
    expect(steer).toBeDisabled();
    fireEvent.click(steer);
    expect(service.steerQueued).not.toHaveBeenCalled();
  });

  it("disables steering for oversized text, attachments and goals", () => {
    setup([item("active", { status: "running", currentRunId: "run", runIds: ["run"] }),
      item("long", { userRequest: "x".repeat(2001) }),
      item("file", { attachments: [{ id: "file" }] as CollaborationWorkItem["attachments"] }),
      item("goal", { outcomeGoal: { objective: "Outcome", successCriteria: "Evidence", status: "active" } }),
    ]);
    for (const button of screen.getAllByRole("button", { name: /Steer with queued request/ })) expect(button).toBeDisabled();
  });

  it("keeps a rejected steering message visible and reports the error", async () => {
    const { service } = setup([item("active", { status: "running", currentRunId: "run", runIds: ["run"] }), item("one")]);
    vi.mocked(service.steerQueued).mockRejectedValue(new Error("Delivery uncertain. Review the paused request."));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Steer with queued request 1" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Delivery uncertain");
    expect(screen.getByText("Request one")).toBeVisible();
  });
});
