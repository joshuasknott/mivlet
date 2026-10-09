import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollaborationSnapshot,
  CollaborationWorkItem,
} from "@mivlet/protocol";
import { WorkspaceExecution } from "../lib/workspace-execution";
import { useBackgroundWork } from "./useBackgroundWork";

const native = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../runtime/domains/background-worker", () => ({
  backgroundWorkerStatus: native.status,
}));

const work: CollaborationWorkItem = {
  id: "native",
  agentId: "agent",
  agentName: "Agent",
  workspaceId: "fixture",
  conversationId: "conversation",
  rootId: "native",
  permissionMode: "read-only",
  executionOwner: "native-background",
  prompt: "Request",
  userRequest: "Request",
  status: "running",
  dependencies: [],
  waitingFor: [],
  prerequisites: [],
  awaitingUser: false,
  generation: 1,
  conversationGeneration: 1,
  contextRevision: 0,
  depth: 0,
  turnCount: 0,
  tokenUsage: 0,
  maxTurns: 1,
  maxTokens: 8192,
  runIds: ["attempt"],
  modelOptionId: "codex::fixture",
  outputs: [],
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
};

function fixture(initial: CollaborationWorkItem[] = []) {
  let data: CollaborationSnapshot = {
    conversations: [],
    authors: [],
    teams: [],
    facts: [],
    work: initial,
    layout: null,
  };
  const load = vi.fn(async () => data);
  const command = vi.fn(async () => data);
  const service = new WorkspaceExecution("fixture", { load, command });
  const history = vi.spyOn(service, "loadHistory").mockResolvedValue();
  return {
    service,
    load,
    command,
    history,
    update: (items: CollaborationWorkItem[]) => {
      data = { ...data, work: items };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  native.status.mockReset().mockResolvedValue({ running: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native background views", () => {
  it("discovers native scheduled work when the renderer was idle", async () => {
    const { service, load, command, update, history } = fixture();
    const hook = renderHook(() => useBackgroundWork(service));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    update([work]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(service.getSnapshot().data.work).toEqual([work]);
    expect(history).toHaveBeenCalledWith("conversation", true);
    const reads = load.mock.calls.length;
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(load).toHaveBeenCalledTimes(reads);
    expect(command).not.toHaveBeenCalled();
  });

  it("refreshes a durable Stop even if the control pipe disconnects", async () => {
    const { service, update, history, command } = fixture([work]);
    await service.refresh();
    update([{ ...work, status: "cancelled", generation: 2 }]);
    native.status.mockRejectedValue(new Error("Control pipe disconnected."));
    const hook = renderHook(() => useBackgroundWork(service));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(service.getSnapshot().data.work[0].status).toBe("cancelled");
    expect(history).toHaveBeenCalledWith("conversation", true);
    expect(command).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("retries a failed transcript read without waiting for a new Work revision", async () => {
    const { service, history } = fixture([work]);
    history.mockRejectedValueOnce(new Error("Temporary read failure."));
    const hook = renderHook(() => useBackgroundWork(service));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(history).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
