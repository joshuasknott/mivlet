import { renderHook, waitFor } from "@testing-library/react";
import { useState, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledJob } from "@fable/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { runtimeScheduleQueryKeys, useRuntimeSchedules } from "./useRuntimeSchedules";
import * as runtime from "../runtime";

vi.mock("../runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime")>();
  return {
    wireToWorkflowRun: actual.wireToWorkflowRun,
    enqueueRuntimeJobRun: vi.fn(async () => null),
    listRuntimeSchedulerJobs: vi.fn(async () => []),
    listRuntimeSchedulerQueue: vi.fn(async () => []),
    listRuntimeWorkflowDefinitions: vi.fn(async () => []),
    listRuntimeWorkflowRuns: vi.fn(async () => []),
    saveRuntimeScheduledJob: vi.fn(async () => null)
  };
});

function wrapper({ children }: PropsWithChildren) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { networkMode: "always", retry: false },
      mutations: { networkMode: "always", retry: false }
    }
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    schemaVersion: 1,
    name: "Daily digest",
    description: "Summarize the day.",
    workflowDefinitionId: "workflow-job-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" }
    },
    missedRunPolicy: "run-once",
    status: "active",
    nextRunAt: "",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-07-04T09:00:00.000Z",
    updatedAt: "2026-07-04T09:00:00.000Z",
    ...overrides
  };
}

describe("runtimeScheduleQueryKeys", () => {
  it("scopes keys by workspace and project", () => {
    expect(runtimeScheduleQueryKeys.workspace({ workspaceId: "preview-default", projectId: null })).toEqual([
      "runtime-schedules",
      "preview-default",
      "workspace"
    ]);
    expect(
      runtimeScheduleQueryKeys.workspace({ workspaceId: "team-a", projectId: "project-1" })
    ).toEqual(["runtime-schedules", "team-a", "project-1"]);
  });
});

describe("useRuntimeSchedules", () => {
  beforeEach(() => {
    vi.mocked(runtime.listRuntimeSchedulerJobs).mockResolvedValue([]);
    vi.mocked(runtime.listRuntimeSchedulerQueue).mockResolvedValue([]);
    vi.mocked(runtime.listRuntimeWorkflowDefinitions).mockResolvedValue([]);
    vi.mocked(runtime.listRuntimeWorkflowRuns).mockResolvedValue([]);
    vi.mocked(runtime.enqueueRuntimeJobRun).mockResolvedValue(null);
    vi.mocked(runtime.saveRuntimeScheduledJob).mockResolvedValue(null);
  });

  it("hydrates schedule jobs from the Rust-backed runtime query", async () => {
    vi.mocked(runtime.listRuntimeSchedulerJobs).mockResolvedValue([makeJob()]);
    const { result } = renderHook(
      () => useRuntimeSchedules({ workspaceId: "preview-default", projectId: null }),
      { wrapper }
    );

    await waitFor(() => expect(runtime.listRuntimeSchedulerJobs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.scheduledJobs).toHaveLength(1));

    expect(result.current.scheduledJobs[0].name).toBe("Daily digest");
    expect(runtime.listRuntimeSchedulerJobs).toHaveBeenCalledTimes(1);
  });

  it("surfaces load errors and retries through the query", async () => {
    vi.mocked(runtime.listRuntimeSchedulerJobs)
      .mockRejectedValueOnce(new Error("store locked"))
      .mockRejectedValueOnce(new Error("store locked"))
      .mockResolvedValueOnce([makeJob({ id: "job-2", name: "Recovered" })]);

    const { result } = renderHook(
      () => useRuntimeSchedules({ workspaceId: "preview-default", projectId: null }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.scheduleLoadError).toBe("store locked"), {
      timeout: 3_000
    });
    await result.current.retryScheduleLoad();

    await waitFor(() => expect(result.current.scheduleLoadError).toBeNull());
    expect(result.current.scheduledJobs[0].name).toBe("Recovered");
  }, 10_000);
});
