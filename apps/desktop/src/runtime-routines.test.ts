import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeRoutine,
  listenRuntimeRoutineRunRequest,
  listRuntimeRoutines,
  migrateLegacyRoutines,
  pauseRuntimeRoutine,
  renewRuntimeRoutineLease,
  reportRuntimeRoutineAttempt
} from "./runtime";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope
} from "./runtime-scope";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("Routine runtime boundary", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("filters native Routine events to the active scope and preserves driver fencing", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-1");
    let handler: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      handler = callback;
      return vi.fn();
    });
    mocks.invoke.mockResolvedValue(true);
    const onRun = vi.fn();
    await listenRuntimeRoutineRunRequest(onRun);
    const request = {
      workspaceId: "workspace-1",
      routineId: "routine-1",
      routineVersion: 2,
      triggerId: "trigger-1",
      occurrenceId: "occurrence-1",
      runId: "run-1",
      scheduledAt: "2026-07-24T09:00:00.000Z",
      action: {
        kind: "direct-request" as const,
        title: "Brief",
        instruction: "Summarize."
      },
      routePolicy: { kind: "resolve-at-run" as const },
      writerEpoch: 4,
      leaseToken: "lease-1",
      attemptNumber: 1
    };
    handler?.({ payload: { ...request, workspaceId: "workspace-2" } });
    handler?.({ payload: request });
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun).toHaveBeenCalledWith(request);

    await renewRuntimeRoutineLease({
      occurrenceId: request.occurrenceId,
      writerEpoch: request.writerEpoch,
      leaseToken: request.leaseToken
    });
    await reportRuntimeRoutineAttempt({
      occurrenceId: request.occurrenceId,
      writerEpoch: request.writerEpoch,
      leaseToken: request.leaseToken,
      runId: request.runId,
      attemptNumber: 1,
      status: "completed"
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "routine_driver_renew", {
      input: {
        occurrenceId: "occurrence-1",
        writerEpoch: 4,
        leaseToken: "lease-1"
      }
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "routine_driver_report", {
      input: {
        occurrenceId: "occurrence-1",
        writerEpoch: 4,
        leaseToken: "lease-1",
        runId: "run-1",
        attemptNumber: 1,
        status: "completed"
      }
    });
  });

  it("does not simulate encrypted Routine durability in browser preview", async () => {
    await expect(listRuntimeRoutines()).resolves.toBeNull();
    await expect(
      createRuntimeRoutine({
        title: "Daily brief",
        instruction: "Summarize today.",
        trigger: {
          kind: "time-once",
          at: "2026-07-24T09:00:00.000Z",
          timezone: "Europe/London"
        }
      })
    ).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes simple intent while native code owns ids and authenticated scope", async () => {
    setNative(true);
    mocks.invoke.mockResolvedValue({ routine: { id: "routine-1" } });
    const input = {
      title: "Daily brief",
      instruction: "Summarize today.",
      trigger: {
        kind: "time-once" as const,
        at: "2026-07-24T09:00:00.000Z",
        timezone: "Europe/London"
      }
    };
    await createRuntimeRoutine(input);
    await pauseRuntimeRoutine({
      routineId: "routine-1",
      expectedRevision: 1,
      reason: "Not needed this week."
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["routine_create", { input }],
      [
        "routine_pause",
        {
          input: {
            routineId: "routine-1",
            expectedRevision: 1,
            reason: "Not needed this week."
          }
        }
      ]
    ]);
  });

  it("plans only from the exact authenticated native snapshot before applying", async () => {
    setNative(true);
    const evidence = {
      plannedAt: "2026-07-23T12:00:00.000Z",
      sources: [],
      pinnedRouteEvidence: []
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "routine_migration_capture") return evidence;
      if (command === "routine_migration_apply") {
        return {
          id: "batch-1",
          inputHash: `sha256:${"1".repeat(64)}`,
          planHash: `sha256:${"2".repeat(64)}`,
          status: "applied",
          plannedAt: evidence.plannedAt,
          appliedAt: evidence.plannedAt,
          candidateCount: 0,
          occurrenceCount: 0,
          quarantineCount: 0
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(evidence.plannedAt));
    const result = await migrateLegacyRoutines();
    expect(result?.plan).toEqual({
      plannedAt: evidence.plannedAt,
      candidates: [],
      occurrences: [],
      classifications: []
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "routine_migration_capture", {
      input: { plannedAt: evidence.plannedAt }
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "routine_migration_apply", {
      input: { evidence, plan: result?.plan }
    });
    vi.useRealTimers();
  });
});
