import { render, screen } from "@testing-library/react";
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
import { RunDetail } from "./RunDetail";

/**
 * RunDetail inspection + control coverage. Focuses on the surfaces the page
 * tests only touch indirectly: attempt history, audit events, structured
 * output rendering, and the retry/cancel confirmation + pending states.
 */

function makeAttempt(overrides: Partial<JobAttempt> = {}): JobAttempt {
  return {
    runId: "run-1",
    status: "failed",
    attemptNumber: 1,
    startedAt: "2026-07-01T09:00:00.000Z",
    finishedAt: "2026-07-01T09:00:20.000Z",
    error: "Transient connection error",
    retryable: true,
    ...overrides
  };
}

function makeQueue(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
  return {
    jobId: "job-1",
    runId: "run-1",
    scheduledAt: "2026-07-01T09:00:00.000Z",
    state: "dead",
    leaseHolder: "",
    leaseExpiresAt: "",
    attempts: [makeAttempt()],
    deduplicationKey: "job-1:2026-07-01T09:00:00.000Z",
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

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    definitionId: "def-1",
    definitionVersion: 2,
    status: "failed",
    trigger: "schedule",
    scheduledJobId: "job-1",
    input: {},
    steps: [],
    failureReason: "Agent run failed.",
    startedAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:20.000Z",
    finishedAt: "2026-07-01T09:00:20.000Z",
    ...overrides
  };
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "def-1",
    version: 2,
    name: "Weekly digest",
    description: "Summarize the week.",
    steps: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function makeNotification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "note-1",
    kind: "run-failed",
    runId: "run-1",
    definitionId: "def-1",
    title: "Run failed",
    body: "The weekly digest could not complete.",
    suppressed: false,
    createdAt: "2026-07-01T09:00:21.000Z",
    delivered: true,
    ...overrides
  };
}

describe("RunDetail — lifecycle + inspection", () => {
  it("renders status, timing, duration, attempt, and workflow version", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue({ state: "failed" })]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("20.0s")).toBeInTheDocument();
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("renders attempt history with status, retryable flag, and error", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("retryable")).toBeInTheDocument();
    expect(screen.getByText("Transient connection error")).toBeInTheDocument();
  });

  it("renders audit events scoped to this run", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[
          makeNotification(),
          makeNotification({ id: "note-2", runId: "other-run", title: "Other" })
        ]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    expect(screen.getByText("The weekly digest could not complete.")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("renders the run error block", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByText("Agent run failed.")).toBeInTheDocument();
  });
});

describe("RunDetail — structured output is secret-free", () => {
  it("redacts credentials in step outputs and tool call payloads", () => {
    render(
      <RunDetail
        run={makeRun({
          status: "completed",
          failureReason: undefined,
          steps: [
            {
              stepId: "step-1",
              status: "succeeded",
              output: { token: "sk-secret-1234567890", safe: "visible" },
              toolCalls: [
                {
                  tool: "fetch-inbox",
                  arguments: '{"apiKey":"sk-leaked-1234567890"}',
                  ok: true,
                  output: '{"count":3}'
                }
              ],
              startedAt: "2026-07-01T09:00:00.000Z",
              finishedAt: "2026-07-01T09:00:10.000Z"
            }
          ]
        })}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue({ state: "done", attempts: [makeAttempt({ status: "succeeded", error: undefined, retryable: undefined })] })]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.queryByText("sk-secret-1234567890")).not.toBeInTheDocument();
    expect(screen.queryByText("sk-leaked-1234567890")).not.toBeInTheDocument();
    // Redaction markers appear in both the step output and the tool call args.
    expect(screen.getAllByText(/\[REDACTED\]/).length).toBeGreaterThanOrEqual(2);
    // Safe content still renders.
    expect(screen.getByText(/"safe": "visible"/)).toBeInTheDocument();
  });
});

describe("RunDetail — retry control", () => {
  it("requires confirmation before retrying a failed run", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob({ status: "active" })}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={onRetry}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    // First click reveals the confirmation, does not retry yet.
    await user.click(screen.getByRole("button", { name: /Retry run/i }));
    expect(onRetry).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm retry" }));
    expect(onRetry).toHaveBeenCalledWith("run-1");
  });

  it("shows a pending state and disables retry while retrying", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob({ status: "active" })}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={true}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Retrying/i })).toBeDisabled();
  });

  it("hides retry when the job is paused (unsupported action)", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob({ status: "paused" })}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /Retry run/i })).not.toBeInTheDocument();
  });
});

describe("RunDetail — cancel control", () => {
  it("offers cancel for a running run with confirmation", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RunDetail
        run={makeRun({ status: "running", finishedAt: undefined, failureReason: undefined })}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue({ state: "running" })]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={onCancel}
        onBack={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /Cancel run/i }));
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(onCancel).toHaveBeenCalledWith("run-1");
  });

  it("hides cancel for a terminal run", () => {
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /Cancel run/i })).not.toBeInTheDocument();
  });
});

describe("RunDetail — definition <-> execution link", () => {
  it("calls onOpenSchedule when the schedule link is clicked", async () => {
    const user = userEvent.setup();
    const onOpenSchedule = vi.fn();
    render(
      <RunDetail
        run={makeRun()}
        job={makeJob()}
        definition={makeDefinition()}
        queue={[makeQueue()]}
        notifications={[]}
        retrying={false}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onBack={vi.fn()}
        onOpenSchedule={onOpenSchedule}
      />
    );
    // The schedule link is the second "Weekly digest" element (the title is an
    // h1, the link is a button). Scope to the facts list.
    const facts = screen.getByText("Schedule").closest("dl")!;
    const link = facts.querySelector("button")!;
    await user.click(link);
    expect(onOpenSchedule).toHaveBeenCalledWith("job-1");
  });
});
