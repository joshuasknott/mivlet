import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostedAgentRoutineSnapshot } from "@fable/protocol";
import { HostedAgentRoutinesPanel, type HostedAgentRoutinesPanelState } from "./HostedAgentRoutinesPanel";

function routine(overrides: Partial<HostedAgentRoutineSnapshot> = {}): HostedAgentRoutineSnapshot {
  return {
    routineId: "routine-weekly-review-123",
    requestKey: "agent-routine-request-123",
    runId: "routine-weekly-review",
    title: "Weekly review",
    instruction: "Review /workspace/notes and update /workspace/reports/weekly.md.",
    lifecycle: "active",
    firstRunAt: "2026-08-26T09:00:00.000Z",
    intervalSeconds: 86_400,
    capabilities: ["workspace-read", "workspace-write"],
    maxSteps: 6,
    nextRunAt: "2026-08-26T09:00:00.000Z",
    generation: 1,
    updatedAt: "2026-08-25T18:00:00.000Z",
    ...overrides
  };
}

function state(overrides: Partial<HostedAgentRoutinesPanelState> = {}): HostedAgentRoutinesPanelState {
  return {
    scopeKey: "workspace:agent:device",
    agentName: "Research Partner",
    ready: true,
    routines: [],
    routinesLoading: false,
    routinesError: null,
    runs: [],
    runsLoading: false,
    runsError: null,
    onRefresh: vi.fn(async () => {}),
    onCreate: vi.fn(async () => {}),
    onCancel: vi.fn(async () => {}),
    onPause: vi.fn(async () => {}),
    onResume: vi.fn(async () => {}),
    ...overrides
  };
}

describe("HostedAgentRoutinesPanel", () => {
  it("creates a recurring outcome with explicit standing authority", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<HostedAgentRoutinesPanel state={state({ onCreate })} />);
    await user.click(screen.getByRole("button", { name: "New agent routine" }));
    await user.type(screen.getByLabelText("Name"), "Weekly evidence review");
    await user.type(screen.getByLabelText("Outcome and boundaries"), "Read /workspace/notes and update the weekly report without guessing.");
    fireEvent.change(screen.getByLabelText("First run"), { target: { value: "2026-08-26T09:00" } });
    await user.selectOptions(screen.getByLabelText("Repeat"), "604800");
    await user.click(screen.getByLabelText(/Run generated programs/i));
    await user.click(screen.getByRole("button", { name: "Review and enable" }));
    expect(onCreate).toHaveBeenCalledWith({
      title: "Weekly evidence review",
      instruction: "Read /workspace/notes and update the weekly report without guessing.",
      firstRunAt: "2026-08-26T09:00",
      intervalSeconds: 604_800,
      allowWorkspaceWrite: true,
      allowProcessRun: true,
      maxSteps: 6
    });
  });

  it("shows durable results and supports pause, resume, and explicit cancellation", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn(async () => {});
    const onResume = vi.fn(async () => {});
    const onCancel = vi.fn(async () => {});
    render(<HostedAgentRoutinesPanel state={state({
      routines: [
        routine({ lastRunAt: "2026-08-25T09:00:00.000Z", lastRunLifecycle: "completed", lastResult: "Updated /workspace/reports/weekly.md." }),
        routine({ routineId: "routine-paused-review-123", title: "Paused review", lifecycle: "paused", nextRunAt: undefined })
      ],
      runs: [{
        occurrenceId: "occurrence-1787734800000",
        routineId: "routine-weekly-review-123",
        runId: "routine-weekly-review:1787734800000",
        scheduledAt: "2026-08-25T09:00:00.000Z",
        lifecycle: "completed",
        result: "Updated /workspace/reports/weekly.md.",
        tools: [{ tool: "workspace-write", summary: "Wrote /workspace/reports/weekly.md", status: "completed" }],
        startedAt: "2026-08-25T09:00:00.000Z",
        endedAt: "2026-08-25T09:00:04.000Z",
        generation: 1,
        updatedAt: "2026-08-25T09:00:04.000Z"
      }],
      onPause,
      onResume,
      onCancel
    })} />);
    expect(screen.getByText("Latest result")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause Weekly review" }));
    await user.click(screen.getByRole("button", { name: "Resume Paused review" }));
    await user.click(screen.getByRole("button", { name: "Cancel Weekly review" }));
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(onPause).toHaveBeenCalledWith("routine-weekly-review-123");
    expect(onResume).toHaveBeenCalledWith("routine-paused-review-123");
    expect(onCancel).toHaveBeenCalledWith("routine-weekly-review-123");
  });
});
