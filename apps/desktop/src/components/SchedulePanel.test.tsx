import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduledJob, ScheduledExecutionRoute, WorkflowRun, ConnectorManifest } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { SchedulePanel } from "./SchedulePanel";

const connectedManifests = [
  {
    id: "github",
    name: "GitHub",
    status: "connected",
    permissions: ["Read repositories and files"],
    healthSummary: "Connected",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    supportsSearch: true,
    supportedActions: ["github.comment"]
  },
  {
    id: "vercel",
    name: "Vercel",
    status: "connected",
    permissions: ["Read deployments"],
    healthSummary: "Connected",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    supportsSearch: true,
    supportedActions: ["vercel.promote"]
  }
] as unknown as ConnectorManifest[];

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    schemaVersion: 1,
    name: "Weekly digest",
    description: "Summarize the week.",
    workflowDefinitionId: "workflow-job-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Mon"], hour: 9, minute: 0, timezone: "UTC" }
    },
    missedRunPolicy: "run-once",
    status: "active",
    nextRunAt: "2026-07-06T09:00:00.000Z",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    definitionId: "workflow-job-1",
    definitionVersion: 1,
    status: "completed",
    trigger: "schedule",
    scheduledJobId: "job-1",
    input: {},
    steps: [],
    startedAt: "2026-06-08T09:00:00.000Z",
    updatedAt: "2026-06-08T09:05:00.000Z",
    ...overrides
  };
}

function renderPanel(props: Partial<Parameters<typeof SchedulePanel>[0]> = {}) {
  const handlers = {
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onRequestCloseCreateModal: vi.fn()
  };
  const result = render(
    <SchedulePanel
      jobs={[]}
      runs={[]}
      queue={[]}
      isCreateModalOpen={false}
      definitions={[]}
      {...handlers}
      {...props}
    />
  );
  return { ...result, handlers };
}

describe("SchedulePanel — Search and Layout", () => {
  it("renders search input field by default", () => {
    renderPanel();
    expect(screen.getByPlaceholderText("Search tasks...")).toBeInTheDocument();
  });

  it("filters jobs case-insensitively by name and description", async () => {
    const user = userEvent.setup();
    const job1 = makeJob({ id: "job-1", name: "Backup Database", description: "Save mysql dump." });
    const job2 = makeJob({ id: "job-2", name: "Cleanup logs", description: "Delete old files." });
    renderPanel({ jobs: [job1, job2] });

    expect(screen.getByText("Backup Database")).toBeInTheDocument();
    expect(screen.getByText("Cleanup logs")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search tasks...");
    await user.type(searchInput, "backup");
    expect(screen.getByText("Backup Database")).toBeInTheDocument();
    expect(screen.queryByText("Cleanup logs")).not.toBeInTheDocument();

    await user.clear(searchInput);
    await user.type(searchInput, "OLD FILES");
    expect(screen.queryByText("Backup Database")).not.toBeInTheDocument();
    expect(screen.getByText("Cleanup logs")).toBeInTheDocument();
  });

  it("renders distinct no-search-results state", async () => {
    const user = userEvent.setup();
    const job1 = makeJob({ id: "job-1", name: "Backup Database" });
    renderPanel({ jobs: [job1] });

    const searchInput = screen.getByPlaceholderText("Search tasks...");
    await user.type(searchInput, "nonexistent");
    expect(screen.getByTestId("schedule-no-results")).toBeInTheDocument();
    expect(screen.getByText("No tasks match your search.")).toBeInTheDocument();
    expect(screen.queryByText("Backup Database")).not.toBeInTheDocument();
  });
});

describe("SchedulePanel — Modal Creation Flow", () => {
  it("keeps the modal closed initially by default", () => {
    renderPanel({ isCreateModalOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the modal and displays exact Name, Schedule, Prompt sections, omitting Project and Flash copy", () => {
    renderPanel({ isCreateModalOpen: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("New Scheduled Task")).toBeInTheDocument();

    expect(screen.getByLabelText(/^Name$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Schedule$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Prompt$/i)).toBeInTheDocument();

    expect(screen.queryByText(/Project/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/All scheduled tasks run as Flash/i)).not.toBeInTheDocument();
  });

  it("submits the modal with Name, Schedule, Prompt and triggers onCreate and close", async () => {
    const user = userEvent.setup();
    const onRequestClose = vi.fn();
    const { handlers } = renderPanel({
      isCreateModalOpen: true,
      onRequestCloseCreateModal: onRequestClose
    });

    await user.type(screen.getByLabelText(/^Name$/i), "New Custom Task");
    await user.type(screen.getByLabelText(/^Prompt$/i), "Summarize metrics.");
    await user.click(screen.getByRole("button", { name: "Add Scheduled Task" }));

    expect(handlers.onCreate).toHaveBeenCalledTimes(1);
    expect(handlers.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "New Custom Task",
      description: "Summarize metrics."
    }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("handles keyboard Escape key and backdrop click to close modal", async () => {
    const user = userEvent.setup();
    const onRequestClose = vi.fn();
    renderPanel({
      isCreateModalOpen: true,
      onRequestCloseCreateModal: onRequestClose
    });

    // Close via X button
    await user.click(screen.getByLabelText(/Close dialog/i));
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    // Close via Escape key
    onRequestClose.mockClear();
    await user.keyboard("{Escape}");
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    // Close via backdrop click
    onRequestClose.mockClear();
    const overlay = screen.getByTestId("schedule-modal-overlay");
    await user.click(overlay);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});

describe("SchedulePanel — list states", () => {
  it("shows the empty state when there are no jobs and not loading", () => {
    renderPanel();
    expect(screen.getByText(/no local schedules yet/i)).toBeInTheDocument();
  });

  it("shows a loading indicator while jobs are hydrating", () => {
    renderPanel({ loading: true });
    expect(screen.getByText(/loading schedules/i)).toBeInTheDocument();
    expect(screen.queryByText(/no schedules yet/i)).not.toBeInTheDocument();
  });

  it("renders an enabled badge and the recurrence summary for an active job", () => {
    renderPanel({ jobs: [makeJob()] });
    const savedList = screen.getByRole("list", { name: /saved schedules/i });
    expect(within(savedList).getByText("Weekly digest")).toBeInTheDocument();
    expect(within(savedList).getByText(/Weekly on Mon at 9:00 AM/i)).toBeInTheDocument();
    expect(within(savedList).getByText("Enabled")).toBeInTheDocument();
  });

  it("renders a paused badge for a paused job and dims the row", () => {
    renderPanel({ jobs: [makeJob({ status: "paused" })] });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Resume")).toBeInTheDocument();
  });

  it("renders an invalid badge and the engine error for a malformed trigger", () => {
    const job = makeJob({
      trigger: {
        kind: "recurring",
        rule: { frequency: "monthly", interval: 1, byMonthDay: 40, hour: 8, minute: 0 }
      }
    });
    renderPanel({ jobs: [job] });
    expect(screen.getByText("Invalid trigger")).toBeInTheDocument();
    expect(screen.getByText(/day from 1 to 31/i)).toBeInTheDocument();
  });

  it("renders a needs-attention badge when the last run failed", () => {
    const runs = [makeRun({ status: "failed", failureReason: "Backend offline.", updatedAt: "2026-06-09T09:00:00.000Z" })];
    renderPanel({ jobs: [makeJob()], runs });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(/Last run failed: Backend offline/i)).toBeInTheDocument();
  });

  it("renders a needs-attention badge when the last run is blocked on auth", () => {
    const runs = [makeRun({ status: "blocked-auth", updatedAt: "2026-06-09T09:00:00.000Z" })];
    renderPanel({ jobs: [makeJob()], runs });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(/blocked — backend reconnecting/i)).toBeInTheDocument();
  });
});

describe("SchedulePanel — route metadata", () => {
  it("surfaces the frozen execution route and permission mode read-only", () => {
    const route: ScheduledExecutionRoute = {
      policy: "pinned",
      backendId: "openai",
      modelId: "gpt-5",
      permissionMode: "trusted-scope"
    };
    renderPanel({ jobs: [makeJob({ execution: route })] });
    expect(screen.getByText(/Pinned to the connected backend/i)).toBeInTheDocument();
    expect(screen.getByText(/Trusted scope/i)).toBeInTheDocument();
  });

  it("omits the route line when no route was captured", () => {
    renderPanel({ jobs: [makeJob({ execution: undefined })] });
    expect(screen.queryByText(/connected backend/i)).not.toBeInTheDocument();
  });
});

describe("SchedulePanel — pause/resume confirmation", () => {
  it("requires a confirmation step before pausing", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ jobs: [makeJob()] });

    await user.click(screen.getByRole("button", { name: /^pause$/i }));
    expect(handlers.onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /confirm pause/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /confirm pause/i }));
    expect(handlers.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });

  it("cancelling the pause confirmation disarms it without toggling", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ jobs: [makeJob()] });

    await user.click(screen.getByRole("button", { name: /^pause$/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(handlers.onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
  });

  it("resumes immediately without a confirmation step", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ jobs: [makeJob({ status: "paused" })] });

    await user.click(screen.getByRole("button", { name: /resume/i }));
    expect(handlers.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });
});

describe("SchedulePanel — delete", () => {
  it("calls onDelete with the job", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ jobs: [makeJob()] });

    await user.click(screen.getByRole("button", { name: /delete schedule weekly digest/i }));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
  });
});

describe("SchedulePanel — connector selection in edit mode", () => {
  it("offers connected searchable connectors as data-source chips in edit mode", async () => {
    const user = userEvent.setup();
    renderPanel({
      jobs: [makeJob()],
      connectors: connectedManifests
    });

    await user.click(screen.getByRole("button", { name: /edit schedule weekly digest/i }));
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vercel" })).toBeInTheDocument();
  });

  it("passes selected connector ids through onEdit", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({
      jobs: [makeJob()],
      connectors: connectedManifests
    });

    await user.click(screen.getByRole("button", { name: /edit schedule weekly digest/i }));
    await user.click(screen.getByRole("button", { name: "GitHub" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(handlers.onEdit).toHaveBeenCalledTimes(1);
    expect(handlers.onEdit.mock.calls[0][0].connectorIds).toEqual(["github"]);
  });
});
