import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SchedulePanel } from "../SchedulePanel";
import { RunHistoryPage } from "./RunHistoryPage";
import type { ScheduledJob, WorkflowRun, SchedulerQueueEntry, WorkflowDefinition } from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-integration",
    schemaVersion: 1,
    name: "Nightly Sync",
    description: "Backup database.",
    workflowDefinitionId: "def-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 2, minute: 0, timezone: "UTC" }
    },
    missedRunPolicy: "skip",
    status: "active",
    nextRunAt: "2026-07-02T02:00:00.000Z",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    retryPolicy: { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 5000 },
    ...overrides
  } as any;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-integration",
    definitionId: "def-1",
    definitionVersion: 1,
    status: "failed",
    trigger: "schedule",
    scheduledJobId: "job-integration",
    input: {},
    steps: [],
    failureReason: "Backup server timed out.",
    startedAt: "2026-07-01T02:00:00.000Z",
    updatedAt: "2026-07-01T02:00:20.000Z",
    finishedAt: "2026-07-01T02:00:20.000Z",
    ...overrides
  };
}

function makeQueue(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
  return {
    jobId: "job-integration",
    runId: "run-integration",
    scheduledAt: "2026-07-01T02:00:00.000Z",
    state: "dead",
    leaseHolder: "",
    leaseExpiresAt: "",
    attempts: [
      {
        runId: "run-integration",
        status: "failed",
        attemptNumber: 1,
        startedAt: "2026-07-01T02:00:00.000Z",
        finishedAt: "2026-07-01T02:00:20.000Z",
        error: "Backup server timed out.",
        retryable: true
      }
    ],
    deduplicationKey: "job-integration:2026-07-01T02:00:00.000Z",
    retryPolicy: { maxAttempts: 3, initialBackoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 5000 },
    ...overrides
  } as any;
}

function makeDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "def-1",
    version: 1,
    name: "Backup Workflow",
    description: "Backup database workflow.",
    steps: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
}

function stubRuntime(overrides: Partial<ShellRuntime> = {}): ShellRuntime {
  return {
    workflowRuns: [],
    scheduledJobs: [],
    schedulerQueue: [],
    workflowDefinitions: [],
    notificationHistory: [],
    retryingRunIds: [],
    runHistoryJobId: null,
    refreshWorkflowRuns: vi.fn(async () => {}),
    retryWorkflowRun: vi.fn(async () => {}),
    cancelScheduledRun: vi.fn(async () => {}),
    openRunHistoryForJob: vi.fn(),
    clearRunHistoryJobId: vi.fn(),
    ...overrides
  } as unknown as ShellRuntime;
}

describe("Schedules + Run History UI Integration", () => {
  it("renders active and paused schedules in the SchedulePanel", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const activeJob = makeJob({ name: "Active Backup", status: "active" });
    const pausedJob = makeJob({ id: "job-paused", name: "Paused Cleanup", status: "paused" });

    render(
      <SchedulePanel
        jobs={[activeJob, pausedJob]}
        runs={[]}
        queue={[]}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onToggle={onToggle}
        onDelete={vi.fn()}
      />
    );

    // Active schedule shows "Enabled" badge and "Pause" button
    expect(screen.getByText("Active Backup")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    const pauseBtn = screen.getByRole("button", { name: /^pause$/i });
    expect(pauseBtn).toBeInTheDocument();

    // Paused schedule shows "Paused" badge and "Resume" button
    expect(screen.getByText("Paused Cleanup")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    const resumeBtn = screen.getByRole("button", { name: /resume/i });
    expect(resumeBtn).toBeInTheDocument();

    // Pausing active job requires confirmation click
    await user.click(pauseBtn);
    expect(onToggle).not.toHaveBeenCalled();
    const confirmPauseBtn = screen.getByRole("button", { name: /confirm pause/i });
    await user.click(confirmPauseBtn);
    expect(onToggle).toHaveBeenCalledWith(activeJob);

    // Resuming paused job works immediately
    await user.click(resumeBtn);
    expect(onToggle).toHaveBeenCalledWith(pausedJob);
  });

  it("integrates RunHistoryPage navigation, viewing failed run detail, and triggering retry", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      workflowRuns: [makeRun()],
      scheduledJobs: [makeJob()],
      schedulerQueue: [makeQueue()],
      workflowDefinitions: [makeDefinition()]
    } as any);

    render(<RunHistoryPage runtime={runtime} />);

    // Shows the runs list
    expect(screen.getByText("Backup Workflow")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();

    // Clicking the row opens details
    await user.click(screen.getByRole("button", { name: "Open run Backup Workflow" }));
    expect(screen.getByText("Back to run history")).toBeInTheDocument();
    expect(screen.getAllByText("Backup server timed out.")).toHaveLength(2);

    // Retry run button is present and triggers the confirmation
    const retryBtn = screen.getByRole("button", { name: /retry run/i });
    await user.click(retryBtn);
    expect(runtime.retryWorkflowRun).not.toHaveBeenCalled();

    const confirmRetryBtn = screen.getByRole("button", { name: "Confirm retry" });
    await user.click(confirmRetryBtn);
    expect(runtime.retryWorkflowRun).toHaveBeenCalledWith("run-integration");
  });
});
