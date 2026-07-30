import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

export interface RuntimeLocalBackupReceipt {
  path: string;
  createdAt: string;
  schemaVersion: number;
  requiresMatchingOsVaultKey: boolean;
  credentialsIncluded: false;
}

export interface RuntimeLocalRestorePreparation {
  restartRequired: true;
  backupCreatedAt: string;
  schemaVersion: number;
  credentialsIncluded: false;
}

export interface RuntimeLocalDataDeletionReceipt {
  restartRequired: true;
  hostedDataDeleted: false;
  providerCredentialsRevoked: false;
}

export interface RuntimePortableExportReceipt {
  path: string;
  formatVersion: number;
  schemaVersion: number;
  bytes: number;
  sha256: string;
  credentialsIncluded: false;
}

export interface RuntimePortableImportReport {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  errors: string[];
}

export interface RuntimeLocalDiagnosticCategory {
  id:
    | "storage"
    | "providers"
    | "connections"
    | "mcp"
    | "runs"
    | "routines"
    | "queues"
    | "migrations"
    | "sync";
  label: string;
  status: "healthy" | "attention" | "unavailable";
  summary: string;
  metrics: Record<string, number>;
}

export interface RuntimeLocalDiagnosticsSnapshot {
  generatedAt: string;
  schemaVersion: number;
  categories: RuntimeLocalDiagnosticCategory[];
}

export interface RuntimeExecutionControlState {
  paused: boolean;
  revision: number;
  changedAt: string;
}

export interface LocalDataRuntimePort {
  loadExecutionControl(
    workspaceId: string,
  ): Promise<RuntimeExecutionControlState | null>;
  pauseExecution(
    workspaceId: string,
    confirmation: "pause all execution",
  ): Promise<RuntimeExecutionControlState | null>;
  resumeExecution(
    workspaceId: string,
    baseRevision: number,
    confirmation: "resume execution",
  ): Promise<RuntimeExecutionControlState | null>;
  createBackup(destination: string): Promise<RuntimeLocalBackupReceipt | null>;
  exportWorkspaceArchive(
    destination: string,
    workspaceId: string,
  ): Promise<RuntimePortableExportReceipt | null>;
  exportProjectArchive(
    destination: string,
    workspaceId: string,
    projectId: string,
  ): Promise<RuntimePortableExportReceipt | null>;
  importWorkspaceArchive(
    source: string,
    workspaceId: string,
    confirmation: "import workspace copy",
  ): Promise<RuntimePortableImportReport | null>;
  prepareRestore(
    source: string,
    confirmation: "restore local data",
  ): Promise<RuntimeLocalRestorePreparation | null>;
  deleteLocalData(
    confirmation: "delete local data",
  ): Promise<RuntimeLocalDataDeletionReceipt | null>;
  loadDiagnostics(
    workspaceId: string,
  ): Promise<RuntimeLocalDiagnosticsSnapshot | null>;
}

function nativeOnly<T>(
  adapter: RuntimeAdapter,
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (adapter.kind === "preview") {
    return Promise.resolve(null);
  }
  return adapter.invoke<T>(command, args).catch((error: unknown) => {
    throw toRuntimeError(error);
  });
}

function createLocalDataPort(adapter: RuntimeAdapter): LocalDataRuntimePort {
  return {
    loadExecutionControl: (workspaceId) =>
      nativeOnly(adapter, "execution_control_get", { workspaceId }),
    pauseExecution: (workspaceId, confirmation) =>
      nativeOnly(adapter, "execution_control_pause", {
        workspaceId,
        confirmation,
      }),
    resumeExecution: (workspaceId, baseRevision, confirmation) =>
      nativeOnly(adapter, "execution_control_resume", {
        workspaceId,
        baseRevision,
        confirmation,
      }),
    createBackup: (destination) =>
      nativeOnly(adapter, "backup_local_data", { destination }),
    exportWorkspaceArchive: (destination, workspaceId) =>
      nativeOnly(adapter, "export_workspace_archive_to_file", {
        destination,
        workspaceId,
      }),
    exportProjectArchive: (destination, workspaceId, projectId) =>
      nativeOnly(adapter, "export_project_archive_to_file", {
        destination,
        workspaceId,
        projectId,
      }),
    importWorkspaceArchive: (source, workspaceId, confirmation) =>
      nativeOnly(adapter, "import_workspace_archive_from_file", {
        source,
        workspaceId,
        confirmation,
      }),
    prepareRestore: (source, confirmation) =>
      nativeOnly(adapter, "prepare_local_data_restore", {
        source,
        confirmation,
      }),
    deleteLocalData: (confirmation) =>
      nativeOnly(adapter, "delete_local_data", { confirmation }),
    loadDiagnostics: (workspaceId) =>
      nativeOnly(adapter, "local_diagnostics", { workspaceId }),
  };
}

const ports = new WeakMap<RuntimeAdapter, LocalDataRuntimePort>();

function localDataPort() {
  const adapter = getRuntimeAdapter();
  const existing = ports.get(adapter);
  if (existing) {
    return existing;
  }
  const port = createLocalDataPort(adapter);
  ports.set(adapter, port);
  return port;
}

export const loadRuntimeExecutionControl = (workspaceId: string) =>
  localDataPort().loadExecutionControl(workspaceId);

export const pauseRuntimeExecution = (
  workspaceId: string,
  confirmation: "pause all execution",
) => localDataPort().pauseExecution(workspaceId, confirmation);

export const resumeRuntimeExecution = (
  workspaceId: string,
  baseRevision: number,
  confirmation: "resume execution",
) => localDataPort().resumeExecution(workspaceId, baseRevision, confirmation);

export const createRuntimeLocalBackup = (destination: string) =>
  localDataPort().createBackup(destination);

export const exportRuntimeWorkspaceArchive = (
  destination: string,
  workspaceId: string,
) => localDataPort().exportWorkspaceArchive(destination, workspaceId);

export const exportRuntimeProjectArchive = (
  destination: string,
  workspaceId: string,
  projectId: string,
) => localDataPort().exportProjectArchive(destination, workspaceId, projectId);

export const importRuntimeWorkspaceArchive = (
  source: string,
  workspaceId: string,
  confirmation: "import workspace copy",
) => localDataPort().importWorkspaceArchive(source, workspaceId, confirmation);

export const prepareRuntimeLocalRestore = (
  source: string,
  confirmation: "restore local data",
) => localDataPort().prepareRestore(source, confirmation);

export const deleteRuntimeLocalData = (confirmation: "delete local data") =>
  localDataPort().deleteLocalData(confirmation);

export const loadRuntimeLocalDiagnostics = (workspaceId: string) =>
  localDataPort().loadDiagnostics(workspaceId);
