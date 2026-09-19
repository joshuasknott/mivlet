import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProvider, MivletAgentProfile } from "@mivlet/protocol";
import type { ScheduledResearchRunInput } from "../lib/agent-run-service";
import type { LocalSchedule, LocalScheduleDispatchClaim } from "../runtime/domains/local-schedules";
import { useLocalScheduleDispatcher } from "./useLocalScheduleDispatcher";

const mocks = vi.hoisted(() => ({ list: vi.fn(), claim: vi.fn(), run: vi.fn(), bind: vi.fn(), finish: vi.fn(), renew: vi.fn(), abandon: vi.fn() }));
vi.mock("../runtime/domains/local-schedules", () => ({
  listLocalSchedules: mocks.list, claimLocalScheduleDispatch: mocks.claim,
  bindLocalScheduleDispatch: mocks.bind, finishLocalScheduleDispatch: mocks.finish,
  renewLocalScheduleDispatch: mocks.renew, abandonLocalScheduleDispatch: mocks.abandon,
}));
vi.mock("../lib/agent-run-service", () => ({ AgentRunService: class { runScheduledResearch = mocks.run; } }));

const agent: MivletAgentProfile = { id: "researcher", name: "Researcher", modelId: "codex::fixture", reasoningEffort: "high", instructions: "Research carefully.", icon: "agent", iconColor: "blue", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };
const provider = { id: "codex", backendType: "codex-app-server", authState: "connected", models: [{ id: "fixture", available: true, capabilities: { streaming: true } }] } as BackendProvider;
const schedule: LocalSchedule = { id: "schedule", agentId: agent.id, providerId: "codex", model: "fixture", reasoningEffort: "low", prompt: "Read official release notes.", timezone: "UTC", trigger: { kind: "daily", localTime: "09:00" }, status: "enabled", revision: 2, promptRevision: 1, nextRunAt: "2020-01-01T09:00:00Z", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" };
const claim: LocalScheduleDispatchClaim = { scheduleId: schedule.id, occurrenceId: "occurrence", scheduleRevision: 2, promptRevision: 1, scheduledFor: schedule.nextRunAt!, claimToken: "fixture-token", leaseExpiresAt: "2099-01-01T00:00:00Z", agentId: agent.id, providerId: "codex", model: "fixture", reasoningEffort: "low", prompt: schedule.prompt };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([schedule]); mocks.claim.mockResolvedValue(claim);
  mocks.run.mockImplementation(async (input: ScheduledResearchRunInput) => {
    await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
    return { terminal: "completed", threadId: "result" };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled reasoning selection", () => {
  it.each(["low", undefined])("dispatches the saved %s effort independently of later agent changes", async effort => {
    mocks.claim.mockResolvedValue({ ...claim, reasoningEffort: effort });
    renderHook(() => useLocalScheduleDispatcher({ workspaceId: "workspace", agents: [agent], providers: [provider], runtimeReady: true }));
    await waitFor(() => expect(mocks.finish).toHaveBeenCalled());
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0][0].agent.reasoningEffort).toBe(effort);
    expect(mocks.bind).toHaveBeenCalledWith(expect.objectContaining({ occurrenceId: "occurrence", claimToken: "fixture-token" }));
  });

  it("does not let a late status poll cancel the next run", async () => {
    vi.useFakeTimers();
    const staleStatus = deferred<LocalSchedule[]>();
    const firstRun = deferred<void>();
    const secondRun = deferred<void>();
    const cancelFirst = vi.fn(async () => undefined);
    const cancelSecond = vi.fn(async () => undefined);
    let listCalls = 0;
    let claimCalls = 0;
    mocks.list.mockImplementation(() => {
      listCalls += 1;
      return listCalls === 2 ? staleStatus.promise : Promise.resolve([schedule]);
    });
    mocks.claim.mockImplementation(async () => ({ ...claim, occurrenceId: `occurrence-${++claimCalls}`, claimToken: `token-${claimCalls}` }));
    mocks.run
      .mockImplementationOnce(async (input: ScheduledResearchRunInput) => {
        await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
        input.onBackendReady?.(cancelFirst);
        await firstRun.promise;
        return { terminal: "completed", threadId: "first" };
      })
      .mockImplementationOnce(async (input: ScheduledResearchRunInput) => {
        await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
        input.onBackendReady?.(cancelSecond);
        await secondRun.promise;
        return { terminal: "completed", threadId: "second" };
      });

    const { unmount } = renderHook(() => useLocalScheduleDispatcher({ workspaceId: "workspace", agents: [agent], providers: [provider], runtimeReady: true }));
    await act(async () => flush());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => { firstRun.resolve(); await flush(); });
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); await flush(); });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    await act(async () => { staleStatus.resolve([{ ...schedule, status: "paused" }]); await flush(); });
    expect(cancelFirst).not.toHaveBeenCalled();
    expect(cancelSecond).not.toHaveBeenCalled();
    await act(async () => { secondRun.resolve(); await flush(); });
    unmount();
  });

  it("does not let a late renewal rejection cancel the next run", async () => {
    vi.useFakeTimers();
    const staleRenewal = deferred<string>();
    const firstRun = deferred<void>();
    const secondRun = deferred<void>();
    const cancelFirst = vi.fn(async () => undefined);
    const cancelSecond = vi.fn(async () => undefined);
    mocks.renew.mockImplementationOnce(() => staleRenewal.promise);
    mocks.claim
      .mockResolvedValueOnce({ ...claim, occurrenceId: "occurrence-first", claimToken: "token-first" })
      .mockResolvedValueOnce({ ...claim, occurrenceId: "occurrence-second", claimToken: "token-second" });
    mocks.run
      .mockImplementationOnce(async (input: ScheduledResearchRunInput) => {
        await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
        input.onBackendReady?.(cancelFirst);
        await firstRun.promise;
        return { terminal: "completed", threadId: "first" };
      })
      .mockImplementationOnce(async (input: ScheduledResearchRunInput) => {
        await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
        input.onBackendReady?.(cancelSecond);
        await secondRun.promise;
        return { terminal: "completed", threadId: "second" };
      });

    const { unmount } = renderHook(() => useLocalScheduleDispatcher({ workspaceId: "workspace", agents: [agent], providers: [provider], runtimeReady: true }));
    await act(async () => flush());
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    await act(async () => { firstRun.resolve(); await flush(); await vi.advanceTimersByTimeAsync(15_000); await flush(); });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    await act(async () => { staleRenewal.reject(new Error("stale lease")); await flush(); });
    expect(cancelFirst).not.toHaveBeenCalled();
    expect(cancelSecond).not.toHaveBeenCalled();
    await act(async () => { secondRun.resolve(); await flush(); });
    unmount();
  });

  it("finalizes an interrupted occurrence after a current status pause", async () => {
    vi.useFakeTimers();
    const interrupted = deferred<void>();
    let cancelAttempts = 0;
    const cancel = vi.fn(async () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error("temporary cancel failure");
      interrupted.resolve();
    });
    mocks.list.mockResolvedValueOnce([schedule]).mockResolvedValue([{ ...schedule, status: "paused" }]);
    mocks.run.mockImplementation(async (input: ScheduledResearchRunInput) => {
      await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
      input.onBackendReady?.(cancel);
      await interrupted.promise;
      return { terminal: "interrupted", threadId: "result", message: "Paused" };
    });
    const { unmount } = renderHook(() => useLocalScheduleDispatcher({ workspaceId: "workspace", agents: [agent], providers: [provider], runtimeReady: true }));
    await act(async () => { await flush(); await vi.advanceTimersByTimeAsync(10_000); await flush(); });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "interrupted" }));
    expect(cancel).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("revokes a project run before backend readiness and contains cancellation rejection", async () => {
    const backendReady = deferred<void>();
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    let boundCancel: (() => Promise<void>) | undefined;
    let current: (() => boolean) | undefined;
    mocks.claim.mockResolvedValue({ ...claim, projectId: "project" });
    mocks.run.mockImplementation(async (input: ScheduledResearchRunInput) => {
      current = input.isCurrent;
      await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
      await backendReady.promise;
      input.onBackendReady?.(cancel);
      return { terminal: "interrupted", threadId: "result", message: "Stopped" };
    });
    const { unmount } = renderHook(() => useLocalScheduleDispatcher({
      workspaceId: "workspace", agents: [agent], providers: [provider], runtimeReady: true,
      onBound: async (_attemptId, requestCancel) => { boundCancel = requestCancel; return () => undefined; },
    }));
    await waitFor(() => expect(boundCancel).toBeDefined());
    await act(async () => { await boundCancel!(); await flush(); });
    expect(current?.()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { backendReady.resolve(); await flush(); });
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    unmount();
  });
});
