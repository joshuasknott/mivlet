import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeLocalBackup,
  exportRuntimeWorkspaceArchive,
  importRuntimeWorkspaceArchive,
  loadRuntimeExecutionControl,
  loadRuntimeLocalDiagnostics,
  pauseRuntimeExecution,
  prepareRuntimeLocalRestore,
  resumeRuntimeExecution
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
      exportRuntimeWorkspaceArchive("C:\\workspace.json", "workspace-1")
    ).resolves.toBeNull();
    await expect(
      importRuntimeWorkspaceArchive(
        "C:\\workspace.json",
        "workspace-1",
        "import workspace copy"
      )
    ).resolves.toBeNull();
    await expect(
      prepareRuntimeLocalRestore("C:\\backup.db", "restore local data")
    ).resolves.toBeNull();
    await expect(loadRuntimeLocalDiagnostics("workspace-1")).resolves.toBeNull();
    await expect(loadRuntimeExecutionControl("workspace-1")).resolves.toBeNull();
    await expect(pauseRuntimeExecution("workspace-1", "pause all execution")).resolves.toBeNull();
    await expect(resumeRuntimeExecution("workspace-1", 1, "resume execution")).resolves.toBeNull();
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
    const portable = {
      path: "C:\\workspace.json",
      formatVersion: 1,
      schemaVersion: 35,
      bytes: 4096,
      sha256: "a".repeat(64),
      credentialsIncluded: false
    };
    const imported = {
      inserted: { projects: 2 },
      skipped: { artifacts: 1 },
      warnings: [],
      errors: []
    };
    mocks.invoke
      .mockResolvedValueOnce(backup)
      .mockResolvedValueOnce(portable)
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce(restore);

    await expect(createRuntimeLocalBackup(backup.path)).resolves.toEqual(backup);
    await expect(
      exportRuntimeWorkspaceArchive(portable.path, "workspace-1")
    ).resolves.toEqual(portable);
    await expect(
      importRuntimeWorkspaceArchive(
        portable.path,
        "workspace-1",
        "import workspace copy"
      )
    ).resolves.toEqual(imported);
    await expect(
      prepareRuntimeLocalRestore(backup.path, "restore local data")
    ).resolves.toEqual(restore);
    expect(mocks.invoke.mock.calls).toEqual([
      ["backup_local_data", { destination: backup.path }],
      ["export_workspace_archive_to_file", {
        destination: portable.path,
        workspaceId: "workspace-1"
      }],
      ["import_workspace_archive_from_file", {
        source: portable.path,
        workspaceId: "workspace-1",
        confirmation: "import workspace copy"
      }],
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

  it("uses exact confirmations and optimistic revision for execution control", async () => {
    setNative(true);
    const active = { paused: false, revision: 0, changedAt: "" };
    const paused = { paused: true, revision: 1, changedAt: "2026-07-24T09:00:00Z" };
    const resumed = { paused: false, revision: 2, changedAt: "2026-07-24T09:01:00Z" };
    mocks.invoke
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(resumed);
    await expect(loadRuntimeExecutionControl("workspace-1")).resolves.toEqual(active);
    await expect(pauseRuntimeExecution("workspace-1", "pause all execution")).resolves.toEqual(paused);
    await expect(resumeRuntimeExecution("workspace-1", 1, "resume execution")).resolves.toEqual(resumed);
    expect(mocks.invoke.mock.calls).toEqual([
      ["execution_control_get", { workspaceId: "workspace-1" }],
      ["execution_control_pause", {
        workspaceId: "workspace-1",
        confirmation: "pause all execution"
      }],
      ["execution_control_resume", {
        workspaceId: "workspace-1",
        baseRevision: 1,
        confirmation: "resume execution"
      }]
    ]);
  });
});
