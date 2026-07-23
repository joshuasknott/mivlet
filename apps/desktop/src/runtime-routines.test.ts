import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeRoutine,
  listRuntimeRoutines,
  migrateLegacyRoutines,
  pauseRuntimeRoutine
} from "./runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

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
    setNative(false);
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
