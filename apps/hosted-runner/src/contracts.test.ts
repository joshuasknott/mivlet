import { afterEach, describe, expect, it } from "vitest";
import {
  HostedRunnerRequestError,
  assertPublicHttpsUrl,
  setPublicAddressLookupForTests,
  validateBrowserActionRequest,
  validateBrowserNavigateRequest,
  validateComputerId,
  validateLaunchRequest,
  validateProcessId,
  validatePublicHttpsUrl
} from "./contracts";

describe("hosted runner contracts", () => {
  afterEach(() => {
    setPublicAddressLookupForTests();
  });
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
    "https://[::ffff:127.0.0.1]/",
    "https://user:secret@example.com/",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://127.1/",
    "https://0177.0.0.1/",
    "https://0x7f.0.0.1/"
  ])("rejects a non-public browser target: %s", (url) => {
    expect(() => validatePublicHttpsUrl(url)).toThrowError(HostedRunnerRequestError);
  });

  it("resolves hostnames and rejects DNS answers that are private or loopback", async () => {
    setPublicAddressLookupForTests(async (hostname) => {
      if (hostname === "example.com") return ["93.184.216.34"];
      if (hostname === "127.0.0.1.nip.io") return ["127.0.0.1"];
      if (hostname === "metadata.example") return ["169.254.169.254"];
      if (hostname === "mapped.example") return ["::ffff:127.0.0.1"];
      return [];
    });
    await expect(assertPublicHttpsUrl("https://example.com/path")).resolves.toBe("https://example.com/path");
    await expect(assertPublicHttpsUrl("https://127.0.0.1.nip.io/")).rejects.toBeInstanceOf(HostedRunnerRequestError);
    await expect(assertPublicHttpsUrl("https://metadata.example/")).rejects.toBeInstanceOf(HostedRunnerRequestError);
    await expect(assertPublicHttpsUrl("https://mapped.example/")).rejects.toBeInstanceOf(HostedRunnerRequestError);
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
