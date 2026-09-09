import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createComputerTaskExecutor } from "./computer-task-executor";

const approval = (tool: string) => ({ action: `${tool} approved action` } as ApprovalRequest);
describe("computer task execution bounds", () => {
  it("requires a fresh observation after a stale action, then permits a deliberate retry", async () => {
    let actions = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-browser-observe")) return '{"observationId":"fresh"}';
      if (actions++ === 0) throw new Error("That local browser observation is stale.");
      return "clicked";
    });
    const guarded = createComputerTaskExecutor(execute);
    const action = JSON.stringify({ action: "click", controlName: "Submit", observationId: "old" });
    await expect(guarded(approval("local-browser-action"), action)).rejects.toThrow("stale");
    await expect(guarded(approval("local-browser-action"), action)).rejects.toThrow("Observe the current application");
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(guarded(approval("local-browser-observe"), "{}")).resolves.toContain("fresh");
    await expect(guarded(approval("local-browser-action"), action)).resolves.toBe("clicked");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("stops after three failures in one recognized recovery class", async () => {
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-browser-observe")) return '{"observationId":"fresh"}';
      throw new Error("The observed local browser control changed.");
    });
    const guarded = createComputerTaskExecutor(execute);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(guarded(approval("local-browser-action"), `{"observationId":"${attempt}"}`)).rejects.toThrow("changed");
      await guarded(approval("local-browser-observe"), "{}");
    }
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("3 stale observation failures");
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("reacquires a closed tab through a browser observation before continuing", async () => {
    let tabChanges = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-browser-observe")) return '{"tabs":[{"tabRef":"tab-new"}]}';
      if (tabChanges++ === 0) throw new Error("That browser tab was closed. Observe again.");
      return "switched";
    });
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("local-browser-tab"), '{"action":"switch","tabRef":"tab-old"}')).rejects.toThrow("closed");
    await expect(guarded(approval("local-browser-tab"), '{"action":"switch","tabRef":"tab-old"}')).rejects.toThrow("reacquire");
    await guarded(approval("local-browser-observe"), "{}");
    await expect(guarded(approval("local-browser-tab"), '{"action":"switch","tabRef":"tab-new"}')).resolves.toBe("switched");
  });

  it("treats an unknown mutation failure as uncertain and never replays it", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Application rejected this action after dispatch."));
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("after dispatch");
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated errors that explicitly prove execution never began", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Tool call denied: local-browser-action approved action."));
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("denied");
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("denied");
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("failed twice before execution");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("detects three actions that leave the application unchanged", async () => {
    let id = 0;
    const execute = vi.fn(async (request: ApprovalRequest) => request.action.startsWith("local-browser-observe")
      ? JSON.stringify({ observationId: String(++id), text: "Still loading", controls: [] }) : "clicked");
    const guarded = createComputerTaskExecutor(execute);
    await guarded(approval("local-browser-observe"), "{}");
    for (let i = 0; i < 3; i++) {
      await guarded(approval("local-browser-action"), JSON.stringify({ observationId: String(i), action: "click" }));
      await guarded(approval("local-browser-observe"), "{}");
    }
    await expect(guarded(approval("write-file"), '{"path":"result.txt"}')).rejects.toThrow("unchanged");
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it("bounds repeated loading recovery without replaying a mutation", async () => {
    const activity = vi.fn();
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("local-browser-observe")) {
        throw new Error("The browser could not read the visible page. Observe again after it finishes loading.");
      }
      return "clicked";
    });
    const guarded = createComputerTaskExecutor(execute, activity);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(guarded(approval("local-browser-observe"), "{}")).rejects.toThrow("finishes loading");
    }
    await expect(guarded(approval("local-browser-action"), '{}')).rejects.toThrow("3 loading failures");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenCalledWith("Waiting for the application to finish loading");
  });
  it("allows different observed results and does not replay failed commands", async () => {
    let state = 0;
    const execute = vi.fn(async () => JSON.stringify({ text: `Page ${++state}` }));
    const guarded = createComputerTaskExecutor(execute);
    for (let i = 0; i < 5; i++) {
      await guarded(approval("local-browser-action"), '{}');
      await guarded(approval("local-browser-observe"), '{}');
    }
    expect(execute).toHaveBeenCalledTimes(10);
  });
  it("limits total work per turn while leaving connector work independent", async () => {
    const execute = vi.fn(async () => "done");
    const guarded = createComputerTaskExecutor(execute);
    for (let i = 0; i < 80; i++) await guarded(approval("read-file"), '{}');
    await expect(guarded(approval("run-shell"), '{"command":"echo done"}')).rejects.toThrow("action limit");
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
      if (request.action.startsWith("local-browser-action")) throw new Error("Browser outcome is uncertain.");
      if (request.action.startsWith("local-browser-observe")) {
        throw new Error("That local browser observation is stale.");
      }
      return "done";
    });
    const guarded = createComputerTaskExecutor(execute);
    const action = '{"action":"click","controlName":"Submit","observationId":"old"}';
    await expect(guarded(approval("local-browser-action"), action)).rejects.toThrow("uncertain");
    await expect(guarded(approval("local-browser-observe"), "{}")).rejects.toThrow("stale");
    await expect(guarded(approval("local-browser-action"), action)).rejects.toThrow("uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("treats a tab-list error after close dispatch as uncertain", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("The browser tab list changed. Observe again."));
    const guarded = createComputerTaskExecutor(execute);
    const close = '{"action":"close","tabRef":"tab-old"}';
    await expect(guarded(approval("local-browser-tab"), close)).rejects.toThrow("tab list changed");
    await expect(guarded(approval("local-browser-tab"), close)).rejects.toThrow("uncertain outcome");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never unlocks an uncertain shell command through an unrelated read", async () => {
    const execute = vi.fn(async (request: ApprovalRequest) => {
      if (request.action.startsWith("run-shell")) throw new Error("Command timed out and may still be running.");
      return "read";
    });
    const guarded = createComputerTaskExecutor(execute);
    await expect(guarded(approval("run-shell"), '{"command":"job"}')).rejects.toThrow("may still be running");
    await guarded(approval("read-file"), '{"path":"status.txt"}');
    await expect(guarded(approval("run-shell"), '{"command":"job"}')).rejects.toThrow("Reconcile its result");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
