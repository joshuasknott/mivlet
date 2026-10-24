import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../../runtime-scope";
import { selectRuntimeAdapterForTest } from "../adapters/select";
import { importProjectSourceFolder } from "./project-source-folders";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

describe("project source folder runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("fails closed without native folder access in preview", async () => {
    setActiveRuntimeDataScope("workspace-a");
    await expect(importProjectSourceFolder("workspace-a")).rejects.toThrow(
      "installed desktop app",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("requires the active workspace before invoking native selection", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    await expect(importProjectSourceFolder("workspace-b")).rejects.toThrow(
      "active workspace changed",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes the active workspace to the native picker", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockResolvedValueOnce({
      id: "folder-abc",
      name: "docs",
      sources: [],
      skippedCount: 2,
    });

    await expect(importProjectSourceFolder("workspace-a")).resolves.toEqual({
      id: "folder-abc",
      name: "docs",
      sources: [],
      skippedCount: 2,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("import_project_source_folder", {
      workspaceId: "workspace-a",
    });
  });
});
