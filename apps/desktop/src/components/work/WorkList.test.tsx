import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem } from "@fable/protocol";
import { WorkList } from "./WorkCard";

const item = (patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
  id: "work", rootId: "work", workspaceId: "workspace", conversationId: "room",
  agentId: "agent", agentName: "Researcher", prompt: "Assignment", userRequest: "Original request",
  status: "queued", permissionMode: "trusted-scope",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, generation: 1,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 0, tokenUsage: 0,
  maxTurns: 12, maxTokens: 64000, runIds: [], modelOptionId: "codex::fixture", outputs: [],
  createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:00:00Z",
  ...patch,
});

describe("reusable Work list and compact cards", () => {
  it("shows every status with its working label and surfaces the empty state", () => {
    const onOpen = vi.fn(), onStop = vi.fn(), onContinue = vi.fn(), onSteer = vi.fn();
    render(
      <WorkList
        work={[
          item({ id: "q", status: "queued" }),
          item({ id: "r", status: "running" }),
          item({ id: "w", status: "waiting" }),
          item({ id: "b", status: "blocked" }),
          item({ id: "a", status: "awaiting-approval" }),
          item({ id: "u", status: "awaiting-user" }),
          item({ id: "d", status: "completed" }),
          item({ id: "f", status: "failed" }),
          item({ id: "s", status: "cancelled" }),
        ]}
        empty="No work yet"
        onOpen={onOpen}
        onStop={onStop}
        onContinue={onContinue}
        onSteer={onSteer}
      />,
    );
    // Blocked, awaiting-approval, awaiting-user and cancelled collapse into
    // the unified badge states; their reasons stay as secondary detail.
    const badges = [...document.querySelectorAll("span.work-status-badge")].map(
      (badge) => badge.textContent,
    );
    expect(badges).toEqual([
      "Queued",
      "Working",
      "Waiting",
      "Waiting",
      "Working",
      "Waiting",
      "Completed",
      "Failed",
      "Stopped",
    ]);
    expect(screen.getByTitle("Needs outcome review")).toBeVisible();
    expect(screen.getByTitle("A delegated assignment is unresolved")).toBeVisible();
    expect(screen.getByTitle("Awaiting approval")).toBeVisible();
    expect(screen.queryByText("No work yet")).toBeNull();
  });

  it("shows Scheduled only for queued schedule-origin work", () => {
    const onOpenWork = vi.fn();
    const { rerender } = render(
      <WorkList
        work={[item({ id: "scheduled", origin: "schedule", status: "queued" })]}
        empty=""
        onOpen={vi.fn()}
        onOpenWork={onOpenWork}
        onStop={vi.fn()}
        onContinue={vi.fn()}
        onSteer={vi.fn()}
      />,
    );
    expect(screen.getByText("Scheduled")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Work details" }));
    expect(onOpenWork).toHaveBeenCalledWith("scheduled");
    // A running scheduled request shows its real progress, not Scheduled.
    rerender(
      <WorkList
        work={[item({ id: "scheduled", origin: "schedule", status: "running" })]}
        empty=""
        onOpen={vi.fn()} onStop={vi.fn()} onContinue={vi.fn()} onSteer={vi.fn()}
      />,
    );
    expect(screen.getByText("Working")).toBeVisible();
    expect(screen.queryByText("Scheduled")).toBeNull();
    expect(screen.getByTitle("Scheduled research")).toBeVisible();
  });

  it("routes stop, retry and steer through narrow callbacks", async () => {
    const onOpen = vi.fn(), onStop = vi.fn(), onContinue = vi.fn(), onSteer = vi.fn();
    render(
      <WorkList
        work={[item({ id: "active" }), item({ id: "failed-one", status: "failed" })]}
        empty=""
        onOpen={onOpen}
        onStop={onStop}
        onContinue={onContinue}
        onSteer={onSteer}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("active");
    // Real gestures settle between actions; the duplicate-action guard must
    // release before the next action on the same card is accepted.
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
    expect(onContinue).toHaveBeenCalledWith("failed-one", 1);
    await Promise.resolve();
    fireEvent.click(screen.getAllByRole("button", { name: "Steer" })[0]);
    fireEvent.change(screen.getAllByPlaceholderText(/Adjust this request/)[0], {
      target: { value: "Narrow it" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply steering" })[0]);
    expect(onSteer).toHaveBeenCalledWith("active", 1, "Narrow it");
    fireEvent.click(screen.getAllByRole("button", { name: "Open conversation" })[0]);
    expect(onOpen).toHaveBeenCalledWith("room");
  });

  it("never offers blind retry on a started request from the compact card", () => {
    render(
      <WorkList
        work={[item({ id: "started", status: "failed", runIds: ["run"], turnCount: 1 })]}
        empty=""
        onOpen={vi.fn()} onStop={vi.fn()} onContinue={vi.fn()} onSteer={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});