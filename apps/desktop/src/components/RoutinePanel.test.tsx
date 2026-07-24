import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import { RoutinePanel } from "./RoutinePanel";

vi.mock("../runtime", () => ({
  beginRuntimeRoutineSchedulerShadow: vi.fn(),
  createRuntimeRoutine: vi.fn(),
  cutoverRuntimeRoutineScheduler: vi.fn(),
  deleteRuntimeRoutine: vi.fn(),
  editRuntimeRoutine: vi.fn(),
  getRuntimeRoutineSchedulerStatus: vi.fn(),
  listRuntimeRoutineHistory: vi.fn(),
  listRuntimeRoutines: vi.fn(),
  migrateLegacyRoutines: vi.fn(),
  pauseRuntimeRoutine: vi.fn(),
  rollbackRuntimeRoutineScheduler: vi.fn(),
  resumeRuntimeRoutine: vi.fn()
}));

const schedulerStatus = {
  authority: {
    workspaceId: "workspace-1",
    writer: "routine" as const,
    phase: "routine" as const,
    epoch: 2,
    fenceToken: "fence",
    updatedAt: "2026-07-01T00:00:00.000Z"
  },
  readyForCutover: true,
  blockers: [],
  activeLegacyJobs: 0,
  mappedLegacyJobs: 0,
  futureLegacyOccurrences: 0,
  terminalLegacyOccurrences: 0,
  routineDriverOccurrences: 1
};

function weeklyRoutine() {
  return {
    routine: {
      id: "routine-1",
      title: "Weekly digest",
      status: "active",
      revision: 4
    },
    currentVersion: {
      action: {
        kind: "direct-request",
        title: "Weekly digest",
        instruction: "Summarize the week."
      }
    },
    triggers: [
      {
        id: "trigger-1",
        status: "active",
        spec: {
          kind: "time-recurring",
          timezone: "Europe/London",
          recurrence: {
            frequency: "weekly",
            expression:
              'legacy-rrule-lite:v1:{"frequency":"weekly","interval":1,"byWeekday":["Fri"],"byMonthDay":null,"hour":9,"minute":30}'
          },
          missedRunPolicy: "run-once"
        }
      }
    ]
  };
}

describe("RoutinePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runtime.listRuntimeRoutines).mockResolvedValue([weeklyRoutine()] as never);
    vi.mocked(runtime.getRuntimeRoutineSchedulerStatus).mockResolvedValue(schedulerStatus);
    vi.mocked(runtime.editRuntimeRoutine).mockResolvedValue(null);
    vi.mocked(runtime.listRuntimeRoutineHistory).mockResolvedValue([]);
  });

  it("edits weekly and monthly time details without dropping recurrence semantics", async () => {
    const user = userEvent.setup();
    render(<RoutinePanel onRun={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Routine frequency")).toHaveValue("weekly");
    expect(screen.getByLabelText("Routine weekday")).toHaveValue("Fri");
    expect(screen.getByLabelText("Routine time")).toHaveValue("09:30");

    await user.selectOptions(screen.getByLabelText("Routine frequency"), "monthly");
    await user.clear(screen.getByLabelText("Routine day of month"));
    await user.type(screen.getByLabelText("Routine day of month"), "15");
    await user.clear(screen.getByLabelText("Routine time"));
    await user.type(screen.getByLabelText("Routine time"), "10:45");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(runtime.editRuntimeRoutine).toHaveBeenCalledWith({
        routineId: "routine-1",
        expectedRevision: 4,
        title: "Weekly digest",
        instruction: "Summarize the week.",
        trigger: {
          kind: "time-recurring",
          timezone: expect.any(String),
          recurrence: {
            frequency: "monthly",
            expression:
              'legacy-rrule-lite:v1:{"frequency":"monthly","interval":1,"byWeekday":[],"byMonthDay":15,"hour":10,"minute":45}'
          },
          missedRunPolicy: "run-once"
        }
      })
    );
  });

  it("does not replace an unchanged trigger when only copy changes", async () => {
    const user = userEvent.setup();
    render(<RoutinePanel onRun={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const instruction = screen.getByLabelText("What should Fable do?");
    await user.clear(instruction);
    await user.type(instruction, "Summarize the current week.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(runtime.editRuntimeRoutine).toHaveBeenCalledWith({
        routineId: "routine-1",
        expectedRevision: 4,
        title: "Weekly digest",
        instruction: "Summarize the current week."
      })
    );
  });

  it("opens a transient chat draft without saving until the user confirms a time", async () => {
    const consumed = vi.fn();
    render(
      <RoutinePanel
        onRun={vi.fn()}
        draft={{ title: "Summarize the project", instruction: "Summarize the project weekly." }}
        onDraftConsumed={consumed}
      />
    );

    expect(await screen.findByRole("heading", { name: "New routine" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Summarize the project");
    expect(screen.getByLabelText("What should Fable do?")).toHaveValue(
      "Summarize the project weekly."
    );
    expect(runtime.createRuntimeRoutine).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledOnce();
  });
});
