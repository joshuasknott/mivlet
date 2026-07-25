import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRuntimeRoutines,
  listRuntimeThreadMissionProgress,
  searchRuntimeArtifacts
} from "../runtime";
import { listRuntimeProjectConnectionOptions } from "../lib/project-runtime";
import { useProjectActivity } from "./useProjectActivity";

vi.mock("../runtime", () => ({
  listRuntimeRoutines: vi.fn(),
  listRuntimeThreadMissionProgress: vi.fn(),
  searchRuntimeArtifacts: vi.fn()
}));
vi.mock("../lib/project-runtime", () => ({
  listRuntimeProjectConnectionOptions: vi.fn()
}));

const threads = [{
  id: "thread-project",
  title: "Launch plan",
  kind: "project" as const,
  description: "Project conversation",
  updatedAt: "2026-07-24T10:00:00Z",
  pinnedContextIds: []
}];

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRuntimeThreadMissionProgress).mockResolvedValue({
    progress: [{
      runId: "run-1",
      progress: {
        version: 1,
        state: "waiting",
        summary: "Prepare launch",
        runStatus: "running",
        completedSteps: 2,
        totalSteps: 3,
        runningWorkers: 0,
        readyWorkers: 0,
        waitingSteps: 1,
        blockedSteps: 0,
        steps: [],
        usage: {
          records: 2,
          inputTokens: 10,
          outputTokens: 20,
          toolCalls: 0,
          durationMs: 100,
          costObservations: []
        },
        budget: {},
        acceptance: [],
        nextAction: "Review the final draft."
      }
    }],
    unavailableCount: 0,
    truncated: false
  });
  vi.mocked(listRuntimeRoutines).mockResolvedValue([{
    routine: {
      id: "routine-1",
      title: "Weekly launch check",
      status: "active",
      currentVersion: 1
    },
    currentVersion: {},
    triggers: [{
      spec: {
        kind: "connection-event",
        connectionId: "connection-1",
        eventType: "item.updated"
      }
    }]
  }] as never);
  vi.mocked(searchRuntimeArtifacts).mockResolvedValue([{
    artifact: {
      id: "artifact-1",
      title: "Launch brief",
      status: "accepted",
      kind: "document",
      sourceProvenance: [{
        kind: "connection",
        connectionId: "connection-1",
        observedAt: "2026-07-24T10:00:00Z"
      }]
    },
    currentVersion: {
      version: 2,
      citations: []
    },
    matchedOn: []
  }] as never);
  vi.mocked(listRuntimeProjectConnectionOptions).mockResolvedValue([{
    connectionId: "connection-1",
    displayName: "GitHub · work",
    healthState: "healthy",
    selectable: true
  }]);
});

describe("useProjectActivity", () => {
  it("projects only the exact project reads into calm activity summaries", async () => {
    const { result } = renderHook(() => useProjectActivity({
      workspaceId: "workspace-1",
      projectId: "project-1",
      connectionIds: [],
      threads,
      enabled: true
    }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listRuntimeThreadMissionProgress).toHaveBeenCalledWith("thread-project", 6);
    expect(listRuntimeRoutines).toHaveBeenCalledWith("project-1");
    expect(searchRuntimeArtifacts).toHaveBeenCalledWith({
      projectId: "project-1",
      limit: 20
    });
    expect(result.current.missions).toEqual([{
      runId: "run-1",
      threadId: "thread-project",
      title: "Prepare launch",
      state: "Waiting",
      detail: "2 of 3 steps · Review the final draft.",
      conversation: "Launch plan"
    }]);
    expect(result.current.routines[0]).toMatchObject({
      title: "Weekly launch check",
      status: "Active",
      detail: "Runs from a project-used Connection"
    });
    expect(result.current.artifacts[0]).toMatchObject({
      title: "Launch brief",
      status: "Accepted",
      detail: "Document · Version 2"
    });
    expect(result.current.connections).toEqual([{
      id: "connection-1",
      name: "GitHub · work",
      status: "Available"
    }]);
    expect(result.current.connectionOptions).toEqual([{
      id: "connection-1",
      name: "GitHub · work",
      status: "Available",
      selectable: true
    }]);
  });

  it("shows a deliberately selected Project Connection before it is used", async () => {
    vi.mocked(listRuntimeRoutines).mockResolvedValue([]);
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([]);
    vi.mocked(listRuntimeProjectConnectionOptions).mockResolvedValue([{
      connectionId: "connection-selected",
      displayName: "Selected Drive",
      healthState: "healthy",
      selectable: true
    }]);
    const { result } = renderHook(() => useProjectActivity({
      workspaceId: "workspace-1",
      projectId: "project-1",
      connectionIds: ["connection-selected"],
      threads: [],
      enabled: true
    }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([{
      id: "connection-selected",
      name: "Selected Drive",
      status: "Available"
    }]);
  });

  it("does not expose an unavailable referenced Connection as connected", async () => {
    vi.mocked(listRuntimeProjectConnectionOptions).mockResolvedValue([]);
    const { result } = renderHook(() => useProjectActivity({
      workspaceId: "workspace-1",
      projectId: "project-1",
      connectionIds: [],
      threads,
      enabled: true
    }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connections).toEqual([{
      id: "connection-1",
      name: "Connection unavailable",
      status: "Needs attention"
    }]);
  });

  it("surfaces native project-read failures without substituting fixtures", async () => {
    vi.mocked(searchRuntimeArtifacts).mockRejectedValue(new Error("Project artifacts are unavailable."));
    const { result } = renderHook(() => useProjectActivity({
      workspaceId: "workspace-1",
      projectId: "project-1",
      connectionIds: [],
      threads,
      enabled: true
    }), { wrapper: wrapper() });

    await waitFor(
      () => expect(result.current.error).toBe("Project artifacts are unavailable."),
      { timeout: 3_000 }
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.artifacts).toEqual([]);
  });
});
