import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectRuntimeHostedProcess,
  inspectRuntimeHostedProcessSchedule,
  listRuntimeHostedProcessSchedules,
  listRuntimeHostedProcessScheduleRuns,
  cancelRuntimeHostedProcessSchedule,
  actRuntimeHostedBrowser,
  killRuntimeHostedProcess,
  launchRuntimeHostedProcess,
  createRuntimeHostedProcessSchedule,
  loadRuntimeHostedComputer,
  navigateRuntimeHostedBrowser,
  prepareRuntimeHostedBrowser,
  prepareRuntimeHostedBrowserAction,
  prepareRuntimeHostedProcess,
  prepareRuntimeHostedProcessSchedule,
  prepareRuntimeHostedProcessScheduleCancel,
  provisionRuntimeHostedComputer,
  snapshotRuntimeHostedBrowser
} from "./runtime";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("hosted computer runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
  });

  it("does not simulate cloud computers in browser preview", async () => {
    await expect(loadRuntimeHostedComputer("workspace-a", "agent-a")).resolves.toBeNull();
    await expect(provisionRuntimeHostedComputer("workspace-a", "agent-a", "device-a")).resolves.toBeNull();
    await expect(prepareRuntimeHostedProcess({
      workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a", runId: "run-a", argv: ["node"]
    })).resolves.toBeNull();
    await expect(prepareRuntimeHostedBrowser({
      workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a", url: "https://example.com/"
    })).resolves.toBeNull();
    await expect(prepareRuntimeHostedBrowserAction({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "button",
      controlName: "Continue",
      action: "click"
    })).resolves.toBeNull();
    await expect(prepareRuntimeHostedProcessSchedule({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      scheduleId: "schedule-example-123",
      runId: "scheduled-example",
      argv: ["node", "worker.mjs"],
      firstRunAt: "2026-08-25T13:00:00.000Z",
      intervalSeconds: 3600
    })).resolves.toBeNull();
    await expect(prepareRuntimeHostedProcessScheduleCancel({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      scheduleId: "schedule-example-123"
    })).resolves.toBeNull();
    await expect(listRuntimeHostedProcessSchedules({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a"
    })).resolves.toBeNull();
    await expect(listRuntimeHostedProcessScheduleRuns({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a"
    })).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("uses fixed native commands and passes only public coordination ids", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce({ executionNodeId: "node-a", status: "ready" })
      .mockResolvedValueOnce({ requestKey: "request-a", status: "pending" });
    await loadRuntimeHostedComputer("workspace-a", "agent-a");
    await provisionRuntimeHostedComputer("workspace-a", "agent-a", "device-a");
    expect(mocks.invoke.mock.calls).toEqual([
      ["hosted_computer_status", { workspaceId: "workspace-a", agentId: "agent-a" }],
      ["hosted_computer_provision", { workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a" }]
    ]);
  });

  it("surfaces native provisioning failures", async () => {
    setNative(true);
    mocks.invoke.mockRejectedValueOnce({ message: "Hosted runner is unavailable." });
    await expect(provisionRuntimeHostedComputer("workspace-a", "agent-a", "device-a"))
      .rejects.toThrow("Hosted runner is unavailable.");
  });

  it("keeps hosted capabilities behind fixed native process commands", async () => {
    setNative(true);
    const draft = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      runId: "run-a",
      argv: ["node", "worker.mjs"] as [string, ...string[]],
      cwd: "/workspace/project",
      timeoutMs: 60_000
    };
    const proposal = { ...draft, requestKey: "process-a" };
    const approval = {
      id: "approval-a",
      service: "Fable cloud computer",
      action: "Run node on this teammate's cloud computer",
      mode: "full-access" as const,
      riskLevel: "critical" as const,
      dataUsed: ["program: node"],
      consequence: "Runs the displayed program.",
      requestedAt: "2026-08-24T12:00:00.000Z",
      decisions: ["once" as const, "deny" as const],
      confirmationPhrase: "run on cloud computer"
    };
    const resolution = {
      request: approval,
      decision: "once" as const,
      decidedAt: "2026-08-24T12:00:01.000Z",
      confirmationText: "run on cloud computer"
    };
    const target = {
      workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a", processId: "process-id-a"
    };
    mocks.invoke.mockResolvedValue({ lifecycle: "running", processId: "process-id-a" });

    await prepareRuntimeHostedProcess(draft);
    await launchRuntimeHostedProcess(proposal, resolution, resolution);
    await inspectRuntimeHostedProcess(target);
    await killRuntimeHostedProcess(target);

    expect(mocks.invoke.mock.calls).toEqual([
      ["hosted_process_prepare", { draft }],
      ["hosted_process_launch", { request: { proposal, resolution, sourceResolution: resolution } }],
      ["hosted_process_status", { target }],
      ["hosted_process_kill", { target }]
    ]);
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("FableCapability");
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("runnerUrl");
  });

  it("keeps browser capabilities native while returning only the intended view", async () => {
    setNative(true);
    const draft = {
      workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a", url: "https://example.com/"
    };
    const proposal = { ...draft, requestKey: "browser-request-a" };
    const approval = {
      id: "approval-browser-a",
      service: "Fable cloud computer",
      action: "Open this page in the teammate's cloud browser",
      mode: "full-access" as const,
      riskLevel: "critical" as const,
      dataUsed: ["page: https://example.com/"],
      consequence: "Loads the page.",
      requestedAt: "2026-08-25T12:00:00.000Z",
      decisions: ["once" as const, "deny" as const],
      confirmationPhrase: "open cloud browser"
    };
    const resolution = {
      request: approval,
      decision: "once" as const,
      decidedAt: "2026-08-25T12:00:01.000Z",
      confirmationText: "open cloud browser"
    };
    const target = { workspaceId: "workspace-a", agentId: "agent-a", deviceId: "device-a" };
    mocks.invoke.mockResolvedValue({
      currentUrl: "https://example.com/",
      title: "Example Domain",
      previewDataUrl: "data:image/jpeg;base64,/9j/",
      observationId: "observation-1234567890abcdef",
      viewport: { scrollX: 0, scrollY: 0, width: 1280, height: 800, documentWidth: 1280, documentHeight: 1600, canScrollUp: false, canScrollDown: true },
      navigation: { canGoBack: false, canGoForward: false },
      controls: [],
      updatedAt: "2026-08-25T12:00:02.000Z"
    });

    await prepareRuntimeHostedBrowser(draft);
    await navigateRuntimeHostedBrowser(proposal, resolution, resolution);
    await snapshotRuntimeHostedBrowser(target);

    expect(mocks.invoke.mock.calls).toEqual([
      ["hosted_browser_prepare", { draft }],
      ["hosted_browser_navigate", { request: { proposal, resolution, sourceResolution: resolution } }],
      ["hosted_browser_snapshot", { target }]
    ]);
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("FableCapability");
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("runnerUrl");
  });

  it("keeps browser control refs and approvals behind fixed native action commands", async () => {
    setNative(true);
    const draft = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "button",
      controlName: "Continue",
      action: "click" as const
    };
    const proposal = { ...draft, requestKey: "browser-action-a" };
    const approval = {
      id: "approval-browser-action-a",
      service: "Fable cloud computer",
      action: "Click control control-1234567890abcdef-1",
      mode: "full-access" as const,
      riskLevel: "critical" as const,
      dataUsed: ["control name: Continue"],
      consequence: "Uses one observed control.",
      requestedAt: "2026-08-25T12:02:00.000Z",
      decisions: ["once" as const, "deny" as const],
      confirmationPhrase: "act in cloud browser"
    };
    const resolution = {
      request: approval,
      decision: "once" as const,
      decidedAt: "2026-08-25T12:02:01.000Z",
      confirmationText: "act in cloud browser"
    };
    mocks.invoke.mockResolvedValue({ currentUrl: "https://example.com/", controls: [] });

    await prepareRuntimeHostedBrowserAction(draft);
    await actRuntimeHostedBrowser(proposal, resolution, resolution);

    expect(mocks.invoke.mock.calls).toEqual([
      ["hosted_browser_action_prepare", { draft }],
      ["hosted_browser_action", { request: { proposal, resolution, sourceResolution: resolution } }]
    ]);
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("FableCapability");
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain("runnerUrl");
  });

  it("keeps durable hosted schedules behind fixed native commands", async () => {
    setNative(true);
    const draft = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      scheduleId: "schedule-example-123",
      runId: "scheduled-example",
      argv: ["node", "worker.mjs"] as [string, ...string[]],
      firstRunAt: "2026-08-25T17:00:00.000Z",
      intervalSeconds: 3600
    };
    const proposal = { ...draft, requestKey: "schedule-request-a" };
    const approval = {
      id: "approval-schedule-a",
      service: "Fable cloud computer",
      action: "Schedule node on this teammate's cloud computer",
      mode: "full-access" as const,
      riskLevel: "critical" as const,
      dataUsed: ["schedule: schedule-example-123"],
      consequence: "Runs repeatedly.",
      requestedAt: "2026-08-25T16:00:00.000Z",
      decisions: ["once" as const, "deny" as const],
      confirmationPhrase: "schedule on cloud computer"
    };
    const resolution = {
      request: approval,
      decision: "once" as const,
      decidedAt: "2026-08-25T16:00:01.000Z",
      confirmationText: "schedule on cloud computer"
    };
    const target = {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      deviceId: "device-a",
      scheduleId: "schedule-example-123"
    };
    mocks.invoke.mockResolvedValue({ scheduleId: "schedule-example-123", lifecycle: "active" });

    await prepareRuntimeHostedProcessSchedule(draft);
    await createRuntimeHostedProcessSchedule(proposal, resolution, resolution);
    await inspectRuntimeHostedProcessSchedule(target);
    await listRuntimeHostedProcessSchedules({
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      deviceId: target.deviceId
    });
    await listRuntimeHostedProcessScheduleRuns({
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      deviceId: target.deviceId
    });
    await prepareRuntimeHostedProcessScheduleCancel(target);
    await cancelRuntimeHostedProcessSchedule(
      { ...target, requestKey: "schedule-cancel-a" },
      resolution,
      resolution
    );

    expect(mocks.invoke.mock.calls).toEqual([
      ["hosted_process_schedule_prepare", { draft }],
      ["hosted_process_schedule_create", { request: { proposal, resolution, sourceResolution: resolution } }],
      ["hosted_process_schedule_status", { target }],
      ["hosted_process_schedule_list", {
        target: {
          workspaceId: target.workspaceId,
          agentId: target.agentId,
          deviceId: target.deviceId
        }
      }],
      ["hosted_process_schedule_run_list", {
        target: {
          workspaceId: target.workspaceId,
          agentId: target.agentId,
          deviceId: target.deviceId
        }
      }],
      ["hosted_process_schedule_cancel_prepare", { target }],
      ["hosted_process_schedule_cancel", {
        request: {
          proposal: { ...target, requestKey: "schedule-cancel-a" },
          resolution,
          sourceResolution: resolution
        }
      }]
    ]);
  });
});
