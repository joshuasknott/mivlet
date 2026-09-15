import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeNative } from "./bridge";
import {
  clearRuntimeAdapterForTest,
  selectRuntimeAdapterForTest,
} from "./adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("native command boundary", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    selectRuntimeAdapterForTest("native");
  });
  afterEach(clearRuntimeAdapterForTest);

  it("does not dispatch native commands in the browser preview", async () => {
    selectRuntimeAdapterForTest("preview");
    await expect(invokeNative("load_runtime_snapshot")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("preserves the command, captured workspace, and result", async () => {
    const args = { workspaceId: "workspace-a" };
    const snapshot = { version: 1 };
    mocks.invoke.mockResolvedValue(snapshot);
    await expect(invokeNative("load_runtime_snapshot", args)).resolves.toBe(
      snapshot,
    );
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "load_runtime_snapshot",
      args,
    );
  });

  it("preserves structured native failures for retry decisions", async () => {
    mocks.invoke.mockRejectedValue({
      message: "Workspace is busy",
      code: "workspace_busy",
      retryable: true,
    });
    await expect(invokeNative("load_runtime_snapshot")).rejects.toMatchObject({
      message: "Workspace is busy",
      code: "workspace_busy",
      retryable: true,
    });
  });
});
