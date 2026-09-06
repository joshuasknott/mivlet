import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createComputerTaskExecutor } from "./computer-task-executor";

const approval = (tool: string) => ({ action: `${tool} approved action` } as ApprovalRequest);
describe("computer task execution bounds", () => {
  it("stops a failed step after two attempts even when observation refs change", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Control disappeared"));
    const guarded = createComputerTaskExecutor(execute);
    for (const observationId of ["one", "two", "three"]) {
      await expect(guarded(approval("local-browser-action"), JSON.stringify({ action: "click", controlName: "Submit", observationId }))).rejects.toThrow();
    }
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
});
