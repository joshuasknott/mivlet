import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScheduledJob, ScheduledExecutionRoute, WorkflowRun } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { SchedulePanel } from "./SchedulePanel";

/**
 * Component-level coverage for the Schedules management UI. The App-level
 * tests own the full create/edit/pause/delete round trips through the runtime;
 * these tests cover the list-state surface (invalid, attention, paused), the
 * read-only route metadata, and the loading state — the parts driven by
 * pre-built job/run fixtures rather than the create form.
 */

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
    onDelete: vi.fn()
  };
  const result = render(
    <SchedulePanel
      jobs={[]}
      runs={[]}
      queue={[]}
      {...handlers}
      {...props}
    />
  );
  return { ...result, handlers };
}

describe("SchedulePanel — list states", () => {
  it("shows the empty state when there are no jobs and not loading", () => {
    renderPanel();
    expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
  });

  it("shows a loading indicator while jobs are hydrating", () => {
    renderPanel({ loading: true });
    expect(screen.getByText(/loading schedules/i)).toBeInTheDocument();
    expect(screen.queryByText(/no schedules yet/i)).not.toBeInTheDocument();
  });

  it("renders an enabled badge and the recurrence summary for an active job", () => {
    renderPanel({ jobs: [makeJob()] });
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText(/Weekly on Mon at 9:00 AM/i)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
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

describe("SchedulePanel — connector selection", () => {
  const connectedManifests = [
    {
      id: "github",
      name: "GitHub",
      status: "connected",
      permissions: ["Read repositories and files"],
      healthSummary: "Connected",
      lastCheckedAt: "2026-06-27T09:00:00.000Z",
      supportedActions: ["github.repository.read"]
    },
    {
      id: "vercel",
      name: "Vercel",
      status: "connected",
      permissions: ["Read deployments"],
      healthSummary: "Connected",
      lastCheckedAt: "2026-06-27T09:00:00.000Z",
      supportedActions: ["vercel.deployment.read"]
    }
  ] as unknown as import("@fable/protocol").ConnectorManifest[];

  it("offers connected connectors with read capabilities as data-source chips", () => {
    renderPanel({ connectors: connectedManifests });
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vercel" })).toBeInTheDocument();
  });

  it("hides the data-source section when no connected connectors are available", () => {
    renderPanel({ connectors: [] });
    expect(screen.queryByRole("group", { name: /data sources/i })).not.toBeInTheDocument();
  });

  it("passes the selected connector ids through onCreate", async () => {
    const user = userEvent.setup();
    const { handlers } = renderPanel({ connectors: connectedManifests });

    await user.type(screen.getByLabelText(/schedule task name/i), "Connector digest");
    await user.type(screen.getByLabelText(/schedule description/i), "Summarize repos.");
    await user.click(screen.getByRole("button", { name: "GitHub" }));
    await user.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(handlers.onCreate).toHaveBeenCalledTimes(1);
    expect(handlers.onCreate.mock.calls[0][0].connectorIds).toEqual(["github"]);
  });

  it("excludes disconnected connectors from the picker", () => {
    const manifests = [
      ...connectedManifests,
      {
        id: "linear",
        name: "Linear",
        status: "needs-auth",
        permissions: [],
        healthSummary: "Needs auth",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        supportedActions: []
      }
    ] as unknown as import("@fable/protocol").ConnectorManifest[];
    renderPanel({ connectors: manifests });
    expect(screen.queryByRole("button", { name: "Linear" })).not.toBeInTheDocument();
  });
});
