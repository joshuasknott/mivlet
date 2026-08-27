import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostedProcessScheduleRunSnapshot, HostedProcessScheduleSnapshot } from "@fable/protocol";
import { HostedSchedulesPanel, type HostedSchedulesPageState } from "./HostedSchedulesPanel";

function schedule(overrides: Partial<HostedProcessScheduleSnapshot> = {}): HostedProcessScheduleSnapshot {
  return {
    scheduleId: "schedule-digest-123",
    requestKey: "schedule-request-123",
    runId: "weekly-digest",
    lifecycle: "active",
    firstRunAt: "2026-08-25T18:00:00.000Z",
    intervalSeconds: 3_600,
    nextRunAt: "2026-08-25T19:00:00.000Z",
    generation: 1,
    updatedAt: "2026-08-25T18:00:00.000Z",
    ...overrides
  };
}

function state(overrides: Partial<HostedSchedulesPageState> = {}): HostedSchedulesPageState {
  return {
    scopeKey: "workspace-hosted:agent-research:device-desktop",
    agentName: "Research Partner",
    available: true,
    status: "ready",
    keepAlive: true,
    loading: false,
    provisioning: false,
    schedules: [],
    schedulesLoading: false,
    schedulesRefreshing: false,
    schedulesError: null,
    scheduleRuns: [],
    scheduleRunsLoading: false,
    scheduleRunsError: null,
    agentRoutines: [],
    agentRoutinesLoading: false,
    agentRoutinesError: null,
    agentRoutineRuns: [],
    agentRoutineRunsLoading: false,
    agentRoutineRunsError: null,
    onProvision: vi.fn(),
    onRefresh: vi.fn(async () => {}),
    onCreate: vi.fn(async () => {}),
    onCancel: vi.fn(async () => {}),
    onPause: vi.fn(async () => {}),
    onResume: vi.fn(async () => {}),
    onInspectRun: vi.fn(async (processId: string) => ({
      requestKey: "scheduled:schedule-digest-123:1787680800000",
      runId: "weekly-digest:1787680800000",
      lifecycle: "completed" as const,
      processId,
      stdout: "Digest uploaded.",
      stderr: "",
      outputTruncated: false
    })),
    onCreateAgentRoutine: vi.fn(async () => {}),
    onCancelAgentRoutine: vi.fn(async () => {}),
    onPauseAgentRoutine: vi.fn(async () => {}),
    onResumeAgentRoutine: vi.fn(async () => {}),
    ...overrides
  };
}

function run(overrides: Partial<HostedProcessScheduleRunSnapshot> = {}): HostedProcessScheduleRunSnapshot {
  return {
    occurrenceId: "occurrence-1787680800000",
    scheduleId: "schedule-digest-123",
    scheduledAt: "2026-08-25T18:00:00.000Z",
    requestKey: "scheduled:schedule-digest-123:1787680800000",
    runId: "weekly-digest:1787680800000",
    lifecycle: "completed",
    processId: "process-history-123",
    startedAt: "2026-08-25T18:00:00.000Z",
    endedAt: "2026-08-25T18:00:05.000Z",
    exitCode: 0,
    generation: 1,
    updatedAt: "2026-08-25T18:00:05.000Z",
    ...overrides
  };
}

describe("HostedSchedulesPanel", () => {
  it("makes laptop-independent execution and the empty next action explicit", () => {
    render(<HostedSchedulesPanel state={state()} />);
    expect(screen.getByText(/while every client is closed/i)).toBeInTheDocument();
    expect(screen.getByText("No agent routines yet")).toBeInTheDocument();
    expect(screen.getByText("No program schedules")).toBeInTheDocument();
    expect(screen.getByText(/Local schedules below still require Fable to be running/i)).toBeInTheDocument();
  });

  it("shows active, paused, failed, cancelled, and stale durable state", () => {
    render(<HostedSchedulesPanel state={state({
      schedules: [
        schedule({ lastRunAt: "2026-08-25T18:00:00.000Z" }),
        schedule({ scheduleId: "schedule-failed-123", runId: "failed-sync", lastErrorCode: "process-launch-failed" }),
        schedule({ scheduleId: "schedule-paused-123", runId: "paused-sync", lifecycle: "paused", nextRunAt: undefined }),
        schedule({ scheduleId: "schedule-cancelled-123", runId: "old-sync", lifecycle: "cancelled", nextRunAt: undefined }),
        schedule({ scheduleId: "schedule-stale-123", runId: "stale-sync", lifecycle: "stale", nextRunAt: undefined })
      ]
    })} />);
    expect(screen.getByRole("list", { name: "Research Partner always-on schedules" })).toBeInTheDocument();
    expect(screen.getByText("weekly-digest")).toBeInTheDocument();
    expect(screen.getAllByText("Every hour")).toHaveLength(5);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(/Last run: process-launch-failed/i)).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Computer changed")).toBeInTheDocument();
  });

  it("pauses and resumes reversible always-on schedules", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn(async () => {});
    const onResume = vi.fn(async () => {});
    render(<HostedSchedulesPanel state={state({
      schedules: [
        schedule(),
        schedule({ scheduleId: "schedule-paused-123", runId: "paused-sync", lifecycle: "paused", nextRunAt: undefined })
      ],
      onPause,
      onResume
    })} />);
    await user.click(screen.getByRole("button", { name: "Pause weekly-digest" }));
    await user.click(screen.getByRole("button", { name: "Resume paused-sync" }));
    expect(onPause).toHaveBeenCalledWith("schedule-digest-123");
    expect(onResume).toHaveBeenCalledWith("schedule-paused-123");
  });

  it("requires an explicit confirmation before requesting cancellation", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn(async () => {});
    render(<HostedSchedulesPanel state={state({ schedules: [schedule()], onCancel })} />);
    await user.click(screen.getByRole("button", { name: "Cancel weekly-digest" }));
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(onCancel).toHaveBeenCalledWith("schedule-digest-123");
  });

  it("creates an always-on program from explicit fields without parsing a shell command", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<HostedSchedulesPanel state={state({ onCreate })} />);
    await user.click(screen.getByRole("button", { name: "Schedule program" }));
    await user.type(screen.getByLabelText("Name"), "Weekly digest");
    await user.type(screen.getByLabelText(/Program in \/workspace/i), "scripts/digest.mjs");
    fireEvent.change(screen.getByLabelText("First run"), { target: { value: "2026-08-26T18:00" } });
    await user.selectOptions(screen.getByLabelText("Repeat"), "86400");
    await user.type(screen.getByLabelText(/Arguments/i), "--format{enter}markdown");
    await user.click(screen.getByRole("button", { name: "Review and create" }));
    expect(onCreate).toHaveBeenCalledWith({
      label: "Weekly digest",
      programPath: "scripts/digest.mjs",
      arguments: ["--format", "markdown"],
      firstRunAt: "2026-08-26T18:00",
      intervalSeconds: 86_400
    });
    expect(screen.queryByText("Schedule a program")).not.toBeInTheDocument();
  });

  it("shows bounded per-occurrence success and failure evidence", async () => {
    const user = userEvent.setup();
    render(<HostedSchedulesPanel state={state({
      schedules: [schedule()],
      scheduleRuns: [
        run(),
        run({
          occurrenceId: "occurrence-1787684400000",
          scheduledAt: "2026-08-25T19:00:00.000Z",
          lifecycle: "failed",
          processId: "process-history-124",
          exitCode: 1,
          errorCode: "process-exit-nonzero"
        })
      ]
    })} />);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    await user.click(screen.getByText("2 recent runs"));
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("process-exit-nonzero")).toBeInTheDocument();
  });

  it("fetches a run's output only after an explicit request and does not imply persistence", async () => {
    const user = userEvent.setup();
    const onInspectRun = vi.fn(async (processId: string) => ({
      requestKey: "scheduled:schedule-digest-123:1787680800000",
      runId: "weekly-digest:1787680800000",
      lifecycle: "completed" as const,
      processId,
      stdout: "Digest uploaded.",
      outputTruncated: false
    }));
    render(<HostedSchedulesPanel state={state({
      schedules: [schedule()],
      scheduleRuns: [run()],
      onInspectRun
    })} />);
    await user.click(screen.getByText("1 recent run"));
    expect(screen.queryByText("Digest uploaded.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View output" }));
    expect(await screen.findByText("Digest uploaded.")).toBeInTheDocument();
    expect(screen.getByText(/Output is not stored in schedule history/i)).toBeInTheDocument();
    expect(onInspectRun).toHaveBeenCalledWith("process-history-123");
  });

  it("discards inspected output when the hosted computer scope changes", async () => {
    const user = userEvent.setup();
    let resolveOutput!: (snapshot: Awaited<ReturnType<HostedSchedulesPageState["onInspectRun"]>>) => void;
    const pendingOutput = new Promise<Awaited<ReturnType<HostedSchedulesPageState["onInspectRun"]>>>((resolve) => {
      resolveOutput = resolve;
    });
    const view = render(<HostedSchedulesPanel state={state({
      schedules: [schedule()],
      scheduleRuns: [run()],
      onInspectRun: vi.fn(() => pendingOutput)
    })} />);
    await user.click(screen.getByText("1 recent run"));
    await user.click(screen.getByRole("button", { name: "View output" }));
    view.rerender(<HostedSchedulesPanel state={state({
      scopeKey: "workspace-other:agent-research:device-other",
      schedules: [schedule()],
      scheduleRuns: [run()]
    })} />);
    resolveOutput({
      requestKey: "scheduled:schedule-digest-123:1787680800000",
      runId: "weekly-digest:1787680800000",
      lifecycle: "completed",
      processId: "process-history-123",
      stdout: "Private prior workspace output"
    });
    await pendingOutput;
    await Promise.resolve();
    expect(screen.getByText("1 recent run")).toBeInTheDocument();
    expect(screen.queryByText("Private prior workspace output")).not.toBeInTheDocument();
  });

  it("surfaces cancellation and loading failures without hiding durable rows", async () => {
    const user = userEvent.setup();
    const cancellationView = render(<HostedSchedulesPanel state={state({
      schedules: [schedule()],
      onCancel: vi.fn(async () => { throw new Error("Approval expired."); })
    })} />);
    await user.click(screen.getByRole("button", { name: "Cancel weekly-digest" }));
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Approval expired.");
    expect(screen.getByText("weekly-digest")).toBeInTheDocument();
    cancellationView.unmount();

    const onRefresh = vi.fn(async () => {});
    const view = render(<HostedSchedulesPanel state={state({
      schedulesError: "Runner unavailable.",
      onRefresh
    })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Runner unavailable.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalled();
    view.unmount();
  });

  it("distinguishes sign-in, provisioning, and computer setup states", () => {
    const view = render(<HostedSchedulesPanel state={state({ available: false, status: undefined, keepAlive: false })} />);
    expect(screen.getByText("Hosted workspace required")).toBeInTheDocument();
    view.rerender(<HostedSchedulesPanel state={state({ status: "provisioning", keepAlive: false, provisioning: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Starting Research Partner's cloud computer");
    view.rerender(<HostedSchedulesPanel state={state({ status: undefined, keepAlive: false })} />);
    expect(screen.getByText("No cloud computer yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up computer" })).toBeInTheDocument();
  });
});
