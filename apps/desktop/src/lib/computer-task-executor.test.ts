import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createComputerTaskExecutor } from "./computer-task-executor";

const approval = (tool: string) => ({ action: `${tool} approved action` } as ApprovalRequest);
describe("computer task execution bounds", () => {
  it("requires explicit foreground selection and a new observation after a no-input refusal", async () => {
    const execute = vi.fn(async (request: ApprovalRequest, args: string) => {
      if (request.action.startsWith("local-app-select")) return JSON.stringify({ status: "active", deliveryMode: JSON.parse(args).deliveryMode });
      if (request.action.startsWith("local-app-observe")) return '{"observationId":"fresh"}';
      return '{"status":"foreground-required","inputDispatched":false}';
    });
    const guarded = createComputerTaskExecutor(execute);
    const action = '{"action":"key","key":"Enter","observationId":"old"}';
    await expect(guarded(approval("local-app-action"), action)).resolves.toContain("foreground-required");
    await guarded(approval("local-app-observe"), "{}");
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("approved foreground");
    await guarded(approval("local-app-select"), '{"windowId":"next","deliveryMode":"background"}');
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("approved foreground");
    await guarded(approval("local-app-select"), '{"windowId":"next","deliveryMode":"foreground"}');
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("Observe the current application");
    await guarded(approval("local-app-observe"), "{}");
    execute.mockResolvedValueOnce('{"status":"input-dispatched"}');
    await expect(guarded(approval("local-app-action"), action.replace("old", "fresh"))).resolves.toContain("input-dispatched");
    expect(execute.mock.calls.filter(([request]) => request.action.startsWith("local-app-action"))).toHaveLength(2);
  });

  it("never treats an uncertain background failure as permission to replay in foreground", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("Background action outcome is uncertain. Do not replay it."));
    const guarded = createComputerTaskExecutor(execute);
    const action = '{"action":"type","text":"once","observationId":"old"}';
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("uncertain");
    execute.mockResolvedValueOnce('{"status":"active","deliveryMode":"foreground"}');
    await guarded(approval("local-app-select"), '{"windowId":"next","deliveryMode":"foreground"}');
    execute.mockResolvedValueOnce('{"observationId":"fresh","text":"once"}');
    await guarded(approval("local-app-observe"), "{}");
    await expect(guarded(approval("local-app-action"), action.replace("old", "fresh"))).rejects.toThrow("already has an uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("requires a fresh observation after a stale action, then permits a deliberate retry", async () => {
    let actions = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-app-observe")) return '{"observationId":"fresh"}';
      if (actions++ === 0) throw new Error("That local browser observation is stale.");
      return "clicked";
    });
    const guarded = createComputerTaskExecutor(execute);
    const action = JSON.stringify({ action: "click", controlName: "Submit", observationId: "old" });
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("stale");
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("Observe the current application");
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(guarded(approval("local-app-observe"), "{}")).resolves.toContain("fresh");
    await expect(guarded(approval("local-app-action"), action)).resolves.toBe("clicked");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("stops after three failures in one recognized recovery class", async () => {
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-app-observe")) return '{"observationId":"fresh"}';
      throw new Error("The observed application control changed.");
    });
    const guarded = createComputerTaskExecutor(execute);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(guarded(approval("local-app-action"), `{"observationId":"${attempt}"}`)).rejects.toThrow("changed");
      await guarded(approval("local-app-observe"), "{}");
    }
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("3 stale observation failures");
    expect(execute).toHaveBeenCalledTimes(6);
  });


  it("treats an unknown mutation failure as uncertain and never replays it", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Application rejected this action after dispatch."));
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("after dispatch");
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated errors that explicitly prove execution never began", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Tool call denied: local-app-action approved action."));
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("denied");
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("denied");
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("failed twice before execution");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("allows a corrected action after native field validation rejects input before dispatch", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("Invalid application input for 'click': click requires exactly elementRef. No input was dispatched; correct this call using the same fresh observationId."))
      .mockResolvedValueOnce('{"status":"input-dispatched"}');
    const guarded = createComputerTaskExecutor(execute);
    const malformed = '{"observationId":"fresh","input":{"action":"click","elementRef":"e0","text":"irrelevant"}}';
    const corrected = '{"observationId":"fresh","input":{"action":"click","elementRef":"e0"}}';

    await expect(guarded(approval("local-app-action"), malformed)).rejects.toThrow("No input was dispatched");
    await expect(guarded(approval("local-app-action"), corrected)).resolves.toContain("input-dispatched");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("detects three actions that leave the application unchanged", async () => {
    let id = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => request.action.startsWith("local-app-observe")
      ? JSON.stringify({ observationId: String(++id), text: "Still loading", controls: [] }) : "clicked");
    const guarded = createComputerTaskExecutor(execute);
    await guarded(approval("local-app-observe"), "{}");
    for (let i = 0; i < 3; i++) {
      await guarded(approval("local-app-action"), JSON.stringify({ observationId: String(i), action: "click" }));
      await guarded(approval("local-app-observe"), "{}");
    }
    await expect(guarded(approval("write-file"), '{"path":"result.txt"}')).rejects.toThrow("unchanged");
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it("bounds repeated loading recovery without replaying a mutation", async () => {
    const activity = vi.fn();
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-app-observe")) {
        throw new Error("The browser could not read the visible page. Observe again after it finishes loading.");
      }
      return "clicked";
    });
    const guarded = createComputerTaskExecutor(execute, activity);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(guarded(approval("local-app-observe"), "{}")).rejects.toThrow("finishes loading");
    }
    await expect(guarded(approval("local-app-action"), '{}')).rejects.toThrow("3 loading failures");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenCalledWith("Waiting for the application to finish loading");
  });
  it("allows different observed results and does not replay failed commands", async () => {
    let state = 0;
    const execute = vi.fn(async () => JSON.stringify({ text: `Page ${++state}` }));
    const guarded = createComputerTaskExecutor(execute);
    for (let i = 0; i < 5; i++) {
      await guarded(approval("local-app-action"), '{}');
      await guarded(approval("local-app-observe"), '{}');
    }
    expect(execute).toHaveBeenCalledTimes(10);
  });
  it("limits total work per turn while leaving connector work independent", async () => {
    const execute = vi.fn(async () => "done");
    const guarded = createComputerTaskExecutor(execute);
    for (let i = 0; i < 80; i++) await guarded(approval("read-file"), '{}');
    await expect(guarded(approval("local-app-action"), '{"action":"key","key":"Enter"}')).rejects.toThrow("action limit");
    await expect(guarded(approval("gmail-read"), '{}')).resolves.toBe("done");
  });
  it("reports waiting for control without retrying automatically", async () => {
    const activity = vi.fn();
    const execute = vi.fn().mockRejectedValue(new Error("Computer control changed or is paused."));
    await expect(createComputerTaskExecutor(execute, activity)(approval("read-file"), '{}')).rejects.toThrow("paused");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenLastCalledWith("Waiting for computer control");
  });

  it("requires an exact read reconciliation before retrying an uncertain file write", async () => {
    let writes = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("write-file") && writes++ === 0) {
        throw new Error("Mivlet could not confirm whether the file was written; outcome is uncertain.");
      }
      return request.action.startsWith("read-file") ? "saved contents" : "written";
    });
    const guarded = createComputerTaskExecutor(execute);
    const write = '{"path":"report.txt","content":"saved contents"}';
    await expect(guarded(approval("write-file"), write)).rejects.toThrow("uncertain");
    await expect(guarded(approval("write-file"), write)).rejects.toThrow("Reconcile its result");
    await guarded(approval("read-file"), '{"path":"another.txt"}');
    await expect(guarded(approval("write-file"), write)).rejects.toThrow("Reconcile its result");
    await guarded(approval("read-file"), '{"path":"report.txt"}');
    await expect(guarded(approval("write-file"), write)).rejects.toThrow("exact action already has an uncertain outcome");
    await expect(guarded(approval("write-file"), '{"path":"report.txt","content":"corrected contents"}')).resolves.toBe("written");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not downgrade an uncertain effect when its reconciliation read also fails", async () => {
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-app-action")) throw new Error("Browser outcome is uncertain.");
      if (request.action.startsWith("local-app-observe")) {
        throw new Error("That local browser observation is stale.");
      }
      return "done";
    });
    const guarded = createComputerTaskExecutor(execute);
    const action = '{"action":"click","controlName":"Submit","observationId":"old"}';
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("uncertain");
    await expect(guarded(approval("local-app-observe"), "{}")).rejects.toThrow("stale");
    await expect(guarded(approval("local-app-action"), action)).rejects.toThrow("uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(2);
  });


});
