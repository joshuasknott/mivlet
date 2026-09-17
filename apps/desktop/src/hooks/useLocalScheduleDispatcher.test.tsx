import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([schedule]); mocks.claim.mockResolvedValue(claim);
  mocks.run.mockImplementation(async (input: ScheduledResearchRunInput) => {
    await input.onQueued({} as Parameters<ScheduledResearchRunInput["onQueued"]>[0]);
    return { terminal: "completed", threadId: "result" };
  });
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
});
