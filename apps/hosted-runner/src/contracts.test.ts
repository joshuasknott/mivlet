import { describe, expect, it } from "vitest";
import {
  HostedRunnerRequestError,
  validateAgentRoutineRequest,
  validateBrowserActionRequest,
  validateBrowserNavigateRequest,
  validateComputerId,
  validateLaunchRequest,
  validateProcessId,
  validateProcessScheduleRequest,
  validatePublicHttpsUrl,
  validateScheduleId
} from "./contracts";

describe("hosted runner contracts", () => {
  it("accepts a bounded argv launch rooted in the workspace", () => {
    expect(validateLaunchRequest({
      requestKey: "request:run-123:1",
      runId: "run-123",
      argv: ["node", "--version"],
      cwd: "/workspace/project",
      timeoutMs: 30_000
    })).toEqual({
      requestKey: "request:run-123:1",
      runId: "run-123",
      argv: ["node", "--version"],
      cwd: "/workspace/project",
      timeoutMs: 30_000
    });
  });

  it.each(["/tmp", "/workspace/../etc", "C:\\workspace", "/workspace/./project"])(
    "rejects a working directory outside the computer workspace: %s",
    (cwd) => {
      expect(() => validateLaunchRequest({
        requestKey: "request:run-123:1",
        runId: "run-123",
        argv: ["node"],
        cwd
      })).toThrowError(HostedRunnerRequestError);
    }
  );

  it("rejects shell strings in place of explicit argv", () => {
    expect(() => validateLaunchRequest({
      requestKey: "request:run-123:1",
      runId: "run-123",
      argv: "node --version"
    })).toThrowError(/argument list/i);
  });

  it("validates externally addressable ids", () => {
    expect(validateComputerId("workspace-agent-123")).toBe("workspace-agent-123");
    expect(validateProcessId("process_123")).toBe("process_123");
    expect(() => validateComputerId("Workspace Agent")).toThrowError(/computer id/i);
    expect(() => validateProcessId("../process")).toThrowError(/process id/i);
    expect(validateScheduleId("schedule-quarterly-123")).toBe("schedule-quarterly-123");
    expect(() => validateScheduleId("../schedule")).toThrowError(/schedule id/i);
  });

  it("accepts only bounded future recurring hosted processes", () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const request = {
      requestKey: "schedule-request-123",
      scheduleId: "schedule-quarterly-123",
      runId: "scheduled-quarterly",
      argv: ["node", "worker.mjs"],
      cwd: "/workspace/project",
      timeoutMs: 30_000,
      firstRunAt: new Date(now + 60_000).toISOString(),
      intervalSeconds: 3_600
    };
    expect(validateProcessScheduleRequest(request, now)).toEqual(request);
    expect(() => validateProcessScheduleRequest({ ...request, intervalSeconds: 60 }, now))
      .toThrowError(/timing/i);
    expect(() => validateProcessScheduleRequest({ ...request, firstRunAt: new Date(now).toISOString() }, now))
      .toThrowError(/timing/i);
  });

  it("accepts bounded natural-language routines with explicit standing capabilities", () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const request = {
      requestKey: "routine-request-123",
      routineId: "routine-weekly-review-123",
      runId: "routine-weekly-review",
      title: "Weekly workspace review",
      instruction: "Review the workspace notes and update the weekly summary.",
      firstRunAt: new Date(now + 60_000).toISOString(),
      intervalSeconds: 86_400,
      capabilities: ["workspace-read", "workspace-write"],
      maxSteps: 5
    };
    expect(validateAgentRoutineRequest(request, now)).toEqual(request);
  });

  it("rejects overbroad or ambiguous hosted-agent authority", () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const base = {
      requestKey: "routine-request-123",
      routineId: "routine-weekly-review-123",
      runId: "routine-weekly-review",
      title: "Weekly workspace review",
      instruction: "Review the workspace notes.",
      firstRunAt: new Date(now + 60_000).toISOString(),
      intervalSeconds: 86_400,
      capabilities: ["workspace-read"],
      maxSteps: 5
    };
    expect(() => validateAgentRoutineRequest({ ...base, capabilities: ["process-run"] }, now))
      .toThrowError(/workspace read/i);
    expect(() => validateAgentRoutineRequest({ ...base, capabilities: ["workspace-read", "network-anywhere"] }, now))
      .toThrowError(/capabilities/i);
    expect(() => validateAgentRoutineRequest({ ...base, maxSteps: 100 }, now))
      .toThrowError(/step limit/i);
  });

  it("accepts a replay-safe public HTTPS browser navigation", () => {
    expect(validateBrowserNavigateRequest({
      requestKey: "browser:request-123",
      url: "https://example.com/path?q=1"
    })).toEqual({ requestKey: "browser:request-123", url: "https://example.com/path?q=1" });
  });

  it.each([
    "http://example.com",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://192.168.1.2/",
    "https://[::1]/",
    "https://user:secret@example.com/"
  ])("rejects a non-public browser target: %s", (url) => {
    expect(() => validatePublicHttpsUrl(url)).toThrowError(HostedRunnerRequestError);
  });

  it("accepts only an observed control action with the matching visible description", () => {
    expect(validateBrowserActionRequest({
      requestKey: "browser-action:request-123",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "textbox",
      controlName: "Search",
      action: "fill",
      value: "Fable"
    })).toMatchObject({ action: "fill", controlName: "Search", value: "Fable" });
    expect(validateBrowserActionRequest({
      requestKey: "browser-action:request-124",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-2",
      controlRole: "combobox",
      controlName: "Region",
      action: "select",
      value: "Europe"
    })).toMatchObject({ action: "select", controlName: "Region", value: "Europe" });
    expect(validateBrowserActionRequest({
      requestKey: "browser-action:request-125",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-0",
      controlRole: "document",
      controlName: "Page",
      action: "scroll",
      value: "page-down"
    })).toMatchObject({ action: "scroll", controlName: "Page", value: "page-down" });
    expect(validateBrowserActionRequest({
      requestKey: "browser-action:request-126",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-0",
      controlRole: "document",
      controlName: "Page",
      action: "history",
      value: "back"
    })).toMatchObject({ action: "history", controlName: "Page", value: "back" });
    expect(validateBrowserActionRequest({
      requestKey: "browser-action:request-127",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-3",
      controlRole: "link",
      controlName: "Download report",
      action: "download"
    })).toMatchObject({ action: "download", controlName: "Download report" });
    expect(() => validateBrowserActionRequest({
      requestKey: "browser-action:request-123",
      observationId: "observation-1234567890abcdef",
      elementRef: "body > button",
      controlRole: "button",
      controlName: "Delete",
      action: "click"
    })).toThrowError(/control reference/i);
  });

  it("rejects sensitive or unsupported browser input shapes", () => {
    const base = {
      requestKey: "browser-action:request-123",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "textbox",
      controlName: "Search"
    };
    expect(() => validateBrowserActionRequest({ ...base, action: "press", key: "Control+A" }))
      .toThrowError(/key/i);
    expect(() => validateBrowserActionRequest({ ...base, action: "click", value: "unexpected" }))
      .toThrowError(/unexpected/i);
    expect(() => validateBrowserActionRequest({ ...base, action: "download", value: "unexpected" }))
      .toThrowError(/unexpected/i);
    expect(() => validateBrowserActionRequest({ ...base, action: "select" }))
      .toThrowError(/select value/i);
    expect(() => validateBrowserActionRequest({
      ...base,
      action: "scroll",
      value: "to-the-bottom"
    })).toThrowError(/scroll request/i);
    expect(() => validateBrowserActionRequest({
      ...base,
      elementRef: "control-1234567890abcdef-0",
      action: "scroll",
      value: "page-down"
    })).toThrowError(/scroll request/i);
    expect(() => validateBrowserActionRequest({
      ...base,
      elementRef: "control-1234567890abcdef-0",
      controlRole: "document",
      controlName: "Page",
      action: "history",
      value: "reload"
    })).toThrowError(/history request/i);
  });
});
