import { act, fireEvent, render, screen } from "@testing-library/react";
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
  const service = { command, stop: vi.fn().mockResolvedValue(undefined), liveSteer: vi.fn().mockResolvedValue(undefined), reply: vi.fn().mockResolvedValue(undefined) } as unknown as WorkspaceExecution;
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
    fireEvent.click(screen.getByRole("button", { name: "Edit queued request 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit queued request" }), { target: { value: "Check keyboard navigation" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(command).toHaveBeenCalledWith({ action: "edit-queued-work", id: "one", expectedGeneration: 4, prompt: "Check keyboard navigation" });
    expect(screen.getByRole("alert")).toHaveTextContent("The request already started.");
    expect(screen.getByRole("textbox", { name: "Edit queued request" })).toHaveValue("Check keyboard navigation");
  });

  it("moves, pauses and removes queued roots without touching running work", async () => {
    const { command, service } = setup([item("running", { status: "running", runIds: ["run"] }), item("one"), item("two", { queue: { order: 2, held: false } })]);
    expect(screen.getByRole("button", { name: "Move queued request 1 up" })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move queued request 2 up" })));
    expect(command).toHaveBeenLastCalledWith({ action: "move-queued-work", id: "two", expectedGeneration: 4, beforeId: "one" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause queued request 1" })));
    expect(command).toHaveBeenLastCalledWith({ action: "set-work-held", id: "one", expectedGeneration: 4, held: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove queued request 1" })));
    expect(service.stop).toHaveBeenCalledWith("one");
    expect(screen.queryByText("Request running")).toBeNull();
  });

  it("stages a bounded goal for the next submission and exposes attributed status", () => {
    const { onGoalDraftChange } = setup([]);
    fireEvent.click(screen.getByRole("button", { name: "Add an outcome goal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Outcome" }), { target: { value: "Portfolio ready" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Success criteria" }), { target: { value: "Keyboard and mobile checks pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Use for next request" }));
    expect(onGoalDraftChange).toHaveBeenCalledWith({ objective: "Portfolio ready", successCriteria: "Keyboard and mobile checks pass", maxTurns: 6, maxTokens: 128000 });
  });

  it("offers Codex live guidance and keeps other routes at the next safe turn", async () => {
    const { service } = setup([item("active", { status: "running", runIds: ["run"] })]);
    fireEvent.click(screen.getByRole("button", { name: "Guide active work" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Guidance for Atlas" }), { target: { value: "Keep the parser unchanged" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send live guidance" })));
    expect(service.liveSteer).toHaveBeenCalledWith("active", 4, "Keep the parser unchanged");
    expect(screen.getByRole("status")).toHaveTextContent("Live guidance saved");
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

  it("never advertises in-flight steering for unsupported or native background routes", async () => {
    const { service } = setup([item("active", { status: "running", runIds: ["run"], modelOptionId: "claude::fixture" })]);
    fireEvent.click(screen.getByRole("button", { name: "Guide active work" }));
    expect(screen.queryByRole("button", { name: "Send live guidance" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Guidance for Atlas" }), { target: { value: "Check the final paragraph" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Queue for next turn" })));
    expect(service.reply).toHaveBeenCalledWith("active", 4, "Check the final paragraph");
  });
});
