import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeSnapshot, saveRuntimeSnapshot } from "./runtime";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import { clearRuntimeAdapterForTest, selectRuntimeAdapterForTest } from "./runtime/adapters/select";
import { shellStateToRuntimeSnapshot } from "./lib/persistence";
import { defaultShellState } from "./hooks/shell-runtime/defaults";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("native snapshot persistence", () => {
  beforeEach(() => { mocks.invoke.mockReset(); clearActiveRuntimeDataScope(); selectRuntimeAdapterForTest("native"); });
  afterEach(() => { clearRuntimeAdapterForTest(); clearActiveRuntimeDataScope(); });

  it("distinguishes a failed read from a missing snapshot", async () => {
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockRejectedValueOnce("Temporary disk read failure").mockResolvedValueOnce(null);
    await expect(loadRuntimeSnapshot()).rejects.toThrow("Temporary disk read failure");
    await expect(loadRuntimeSnapshot()).resolves.toBeNull();
  });

  it("sends a captured workspace explicitly even after the active scope changes", async () => {
    const snapshot = shellStateToRuntimeSnapshot(defaultShellState);
    setActiveRuntimeDataScope("workspace-b");
    mocks.invoke.mockResolvedValue(null);
    await loadRuntimeSnapshot("workspace-a");
    await saveRuntimeSnapshot(snapshot, "workspace-a");
    expect(mocks.invoke.mock.calls).toEqual([
      ["load_runtime_snapshot", { workspaceId: "workspace-a" }],
      ["save_runtime_snapshot", { snapshot, workspaceId: "workspace-a" }],
    ]);
  });

  it("keeps unavailable preview persistence as null", async () => {
    selectRuntimeAdapterForTest("preview");
    await expect(loadRuntimeSnapshot("workspace-a")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
