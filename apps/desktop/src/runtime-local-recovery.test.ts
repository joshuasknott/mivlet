import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeLocalBackup,
  loadRuntimeLocalDiagnostics,
  prepareRuntimeLocalRestore
} from "./runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("local recovery runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
  });

  it("does not simulate backup or restore in browser preview", async () => {
    await expect(createRuntimeLocalBackup("C:\\backup.db")).resolves.toBeNull();
    await expect(
      prepareRuntimeLocalRestore("C:\\backup.db", "restore local data")
    ).resolves.toBeNull();
    await expect(loadRuntimeLocalDiagnostics("workspace-1")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes only explicit paths and the exact destructive confirmation", async () => {
    setNative(true);
    const backup = {
      path: "C:\\backup.db",
      createdAt: "2026-07-23T09:00:00Z",
      schemaVersion: 35,
      requiresMatchingOsVaultKey: true,
      credentialsIncluded: false
    };
    const restore = {
      restartRequired: true,
      backupCreatedAt: backup.createdAt,
      schemaVersion: 35,
      credentialsIncluded: false
    };
    mocks.invoke.mockResolvedValueOnce(backup).mockResolvedValueOnce(restore);

    await expect(createRuntimeLocalBackup(backup.path)).resolves.toEqual(backup);
    await expect(
      prepareRuntimeLocalRestore(backup.path, "restore local data")
    ).resolves.toEqual(restore);
    expect(mocks.invoke.mock.calls).toEqual([
      ["backup_local_data", { destination: backup.path }],
      ["prepare_local_data_restore", {
        source: backup.path,
        confirmation: "restore local data"
      }]
    ]);
  });

  it("loads the count-only native support snapshot", async () => {
    setNative(true);
    const snapshot = {
      generatedAt: "2026-07-23T09:00:00Z",
      schemaVersion: 35,
      categories: [{
        id: "storage",
        label: "Local storage",
        status: "healthy",
        summary: "The encrypted database passed its integrity check.",
        metrics: { databaseBytes: 4096, restorePending: 0 }
      }]
    };
    mocks.invoke.mockResolvedValueOnce(snapshot);
    await expect(loadRuntimeLocalDiagnostics("workspace-1")).resolves.toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith("local_diagnostics", {
      workspaceId: "workspace-1"
    });
  });
});
