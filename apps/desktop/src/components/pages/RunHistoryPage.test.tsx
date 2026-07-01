import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  JobAttempt,
  NotificationRecord,
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { RunHistoryPage } from "./RunHistoryPage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Run History lifecycle coverage. The page is rendered with a stubbed
 * ShellRuntime so list rendering, status filtering, empty states, navigation
 * to the detail view, and the retry/cancel action guards can be asserted
 * against the callbacks the hook owns — without driving the full App + Tauri
 * boundary.
 */


function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    definitionId: "def-1",
    definitionVersion: 1,
    status: "completed",
    trigger: "schedule",
    scheduledJobId: "job-1",
    input: {},
    steps: [],
    startedAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:30.000Z",
    finishedAt: "2026-07-01T09:00:30.000Z",
    ...overrides
  };
}

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    schemaVersion: 1,
    name: "Weekly digest",
    description: "Summarize the week.",
    workflowDefinitionId: "def-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Fri"], hour: 9, minute: 0 }
    },
    missedRunPolicy: "skip",
    status: "active",
    nextRunAt: "",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function makeAttempt(overrides: Partial<JobAttempt> = {}): JobAttempt {
  return {
    runId: "run-1",
    status: "succeeded",
    attemptNumber: 1,
    startedAt: "2026-07-01T09:00:00.000Z",
    finishedAt: "2026-07-01T09:00:30.000Z",
    ...overrides
  };
}

function makeQueue(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
  return {
    jobId: "job-1",
    runId: "run-1",
    scheduledAt: "2026-07-01T09:00:00.000Z",
    state: "done",
    leaseHolder: "",
    leaseExpiresAt: "",
    attempts: [makeAttempt()],
    deduplicationKey: "job-1:2026-07-01T09:00:00.000Z",
    ...overrides
  };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "def-1",
    version: 1,
    name: "Weekly digest",
    description: "Summarize the week.",
    steps: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

interface StubState {
  runs: WorkflowRun[];
  jobs: ScheduledJob[];
  queue: SchedulerQueueEntry[];
  definitions: WorkflowDefinition[];
  notifications?: NotificationRecord[];
  retryingRunIds?: string[];
  runHistoryJobId?: string | null;
}

function stubRuntime(state: StubState): ShellRuntime & {
  _calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  return {
    _calls: calls,
    workflowRuns: state.runs,
    scheduledJobs: state.jobs,
    schedulerQueue: state.queue,
    workflowDefinitions: state.definitions,
    notificationHistory: state.notifications ?? [],
    retryingRunIds: state.retryingRunIds ?? [],
    runHistoryJobId: state.runHistoryJobId ?? null,
    refreshWorkflowRuns: vi.fn(async () => record("refreshWorkflowRuns")()),
    retryWorkflowRun: vi.fn(record("retryWorkflowRun")),
    cancelScheduledRun: vi.fn(record("cancelScheduledRun")),
    openRunHistoryForJob: vi.fn(record("openRunHistoryForJob")),
    clearRunHistoryJobId: vi.fn(record("clearRunHistoryJobId"))
  } as unknown as ShellRuntime & { _calls: Record<string, unknown[][]> };
}

function renderPage(runtime: ShellRuntime) {
  return render(<RunHistoryPage runtime={runtime} />);
}

describe("RunHistoryPage — list + filtering", () => {
  it("lists runs with name, status, duration, and when", () => {
    const runtime = stubRuntime({
      runs: [makeRun()],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);

    const list = screen.getByRole("list", { name: "Workflow runs" });
    expect(within(list).getByText("Weekly digest")).toBeInTheDocument();
    expect(within(list).getByText(/Succeeded/i)).toBeInTheDocument();
    expect(within(list).getByText("30.0s")).toBeInTheDocument();
  });

  it("shows the empty state when there are no runs at all", async () => {
    const runtime = stubRuntime({
      runs: [],
      jobs: [],
      queue: [],
      definitions: []
    });
    renderPage(runtime);
    // The cold-load blocker shows first; the empty state appears once the
    // durable refresh settles.
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
  });

  it("shows a filtered empty state when no runs match the status filter", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun({ status: "completed" })],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.getByText("No runs match these filters.")).toBeInTheDocument();
  });

  it("filters runs by status", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [
        makeRun({ id: "run-ok", status: "completed" }),
        makeRun({ id: "run-bad", status: "failed", failureReason: "boom" })
      ],
      jobs: [makeJob()],
      queue: [
        makeQueue({ runId: "run-ok" }),
        makeQueue({
          runId: "run-bad",
          state: "failed",
          attempts: [makeAttempt({ status: "failed" })]
        })
      ],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.getByText("1 run")).toBeInTheDocument();
  });

  it("opens the detail view when a run is selected", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun()],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    expect(screen.getByText("Back to run history")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
  });
});

describe("RunHistoryPage — retry + cancel action guards", () => {
  it("offers retry for a failed run on an active job, with confirmation", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun({ status: "failed", failureReason: "agent error" })],
      jobs: [makeJob({ status: "active" })],
      queue: [
        makeQueue({ state: "dead", attempts: [makeAttempt({ status: "failed" })] })
      ],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    const retryButton = screen.getByRole("button", { name: /Retry run/i });
    await user.click(retryButton);
    const confirm = screen.getByRole("button", { name: "Confirm retry" });
    await user.click(confirm);

    expect(runtime.retryWorkflowRun).toHaveBeenCalledWith("run-1");
  });

  it("does not offer retry when the owning job is paused", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun({ status: "failed" })],
      jobs: [makeJob({ status: "paused" })],
      queue: [
        makeQueue({ state: "dead", attempts: [makeAttempt({ status: "failed" })] })
      ],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    expect(screen.queryByRole("button", { name: /Retry run/i })).not.toBeInTheDocument();
  });

  it("offers cancel for a running run, with confirmation", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun({ status: "running", finishedAt: undefined })],
      jobs: [makeJob()],
      queue: [makeQueue({ state: "running" })],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    await user.click(screen.getByRole("button", { name: /Cancel run/i }));
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));

    expect(runtime.cancelScheduledRun).toHaveBeenCalledWith("run-1");
  });

  it("does not offer cancel for a terminal succeeded run", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun({ status: "completed" })],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    expect(screen.queryByRole("button", { name: /Cancel run/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry run/i })).not.toBeInTheDocument();
  });
});

describe("RunHistoryPage — secret-free structured output", () => {
  it("never renders a leaked credential from a connector output", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [
        makeRun({
          status: "completed",
          steps: [
            {
              stepId: "step-1",
              status: "succeeded",
              output: {
                summary: "ok",
                connection: { api_key: "sk-leaked-1234567890123" }
              },
              startedAt: "2026-07-01T09:00:00.000Z",
              finishedAt: "2026-07-01T09:00:10.000Z"
            }
          ]
        })
      ],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    expect(screen.queryByText("sk-leaked-1234567890123")).not.toBeInTheDocument();
    // The redaction marker must appear somewhere in the rendered output block.
    const outputBlocks = screen.getAllByText(/\[REDACTED\]/);
    expect(outputBlocks.length).toBeGreaterThan(0);
  });
});

describe("RunHistoryPage — definition <-> executions link", () => {
  it("seeds the schedule filter from a deep link and clears it on mount", () => {
    const runtime = stubRuntime({
      runs: [makeRun()],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()],
      runHistoryJobId: "job-1"
    });
    renderPage(runtime);

    // The one-shot filter is consumed + cleared immediately.
    expect(runtime.clearRunHistoryJobId).toHaveBeenCalled();
  });

  it("navigates back to the list filtered by the owning schedule from detail", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      runs: [makeRun()],
      jobs: [makeJob()],
      queue: [makeQueue()],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open run Weekly digest" }));

    // The detail view links back to the schedule's filtered list.
    const scheduleLink = screen.getByRole("button", { name: "Weekly digest" });
    await user.click(scheduleLink);
    // Back on the list, the schedule filter is applied (1 run).
    expect(screen.getByText("1 run")).toBeInTheDocument();
  });
});

describe("RunHistoryPage — status treatment", () => {
  it("renders a distinct badge for each lifecycle state", () => {
    const runtime = stubRuntime({
      runs: [
        makeRun({ id: "r-queued", status: "queued", finishedAt: undefined }),
        makeRun({ id: "r-running", status: "running", finishedAt: undefined }),
        makeRun({ id: "r-ok", status: "completed" }),
        makeRun({ id: "r-fail", status: "failed", failureReason: "x" }),
        makeRun({ id: "r-interrupted", status: "blocked-auth" }),
        makeRun({ id: "r-cancel", status: "cancelled" })
      ],
      jobs: [makeJob()],
      queue: [
        makeQueue({ runId: "r-queued", state: "queued", attempts: [] }),
        makeQueue({ runId: "r-running", state: "running" }),
        makeQueue({ runId: "r-ok" }),
        makeQueue({
          runId: "r-fail",
          state: "failed",
          attempts: [makeAttempt({ status: "failed" })]
        }),
        makeQueue({ runId: "r-interrupted", state: "blocked-auth" }),
        makeQueue({ runId: "r-cancel", state: "cancelled" })
      ],
      definitions: [makeDefinition()]
    });
    renderPage(runtime);

    const list = screen.getByRole("list", { name: "Workflow runs" });
    expect(within(list).getByText("Queued")).toBeInTheDocument();
    expect(within(list).getByText("Running")).toBeInTheDocument();
    expect(within(list).getByText("Succeeded")).toBeInTheDocument();
    expect(within(list).getByText("Failed")).toBeInTheDocument();
    expect(within(list).getByText("Interrupted")).toBeInTheDocument();
    expect(within(list).getByText("Cancelled")).toBeInTheDocument();
  });
});
