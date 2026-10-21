import { activeDataScope, hasTauriRuntime, invoke } from "../bridge";

interface CloudMachine {
  id: string;
  name: string;
  status: string;
  templateId?: string | null;
}

/** Public metadata only. No key, desktop URL or provider response body. */
export interface CloudComputerStatus {
  connected: boolean;
  provider: string;
  connectionRevision: number;
  selectedMachineId: string | null;
  machine: CloudMachine | null;
  machines: CloudMachine[];
  usage: {
    machineCount: number | null;
    machineLimit: number | null;
    snapshotCount: number | null;
    snapshotLimit: number | null;
  } | null;
  pendingAction: string | null;
  capabilities: string[];
  error: string | null;
}

export type CloudComputerAction =
  | { kind: "connect"; agentId: string }
  | { kind: "select"; machineId: string }
  | { kind: "create"; name: string }
  | { kind: "pause" | "resume"; machineId: string }
  | { kind: "disconnect" | "reconcile" };

async function call<T>(
  command: string,
  request: Record<string, unknown>,
): Promise<T> {
  if (!hasTauriRuntime()) {
    throw new Error(
      "Instabox requires the Windows desktop app. API keys never enter this browser.",
    );
  }
  const scope = activeDataScope();
  if (!scope || scope.workspaceId !== request.workspaceId) {
    throw new Error("The active workspace changed. Reopen Computers settings.");
  }
  const result = await invoke<T>(command, { request });
  if (scope !== activeDataScope()) {
    throw new Error(
      "The account or workspace changed. Refresh Computers settings.",
    );
  }
  return result;
}

export function cloudComputerStatus(workspaceId: string) {
  return call<CloudComputerStatus>("cloud_computer_status", { workspaceId });
}

export function changeCloudComputer(
  workspaceId: string,
  expectedRevision: number,
  action: CloudComputerAction,
) {
  const { kind, ...fields } = action;
  return call<CloudComputerStatus>(`cloud_computer_${kind}`, {
    workspaceId,
    expectedRevision,
    ...fields,
  });
}

/** Only native viewer metadata crosses this boundary; never a stream URL. */
export interface CloudViewerState {
  open: boolean;
  machineId: string | null;
  generation: number | null;
  revoke: "notRequested" | "pending" | "acknowledged" | "unconfirmed" | null;
  expiresAt: string | null;
}
export interface CloudViewerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function cloudViewerStatus(workspaceId: string) {
  return call<CloudViewerState>("cloud_computer_viewer_status", {
    workspaceId,
  });
}
export function openCloudViewer(
  workspaceId: string,
  machineId: string,
  expectedRevision: number,
  bounds: CloudViewerBounds,
) {
  return call<CloudViewerState>("cloud_computer_viewer_open", {
    workspaceId,
    machineId,
    expectedRevision,
    ...bounds,
  });
}
export function closeCloudViewer(
  workspaceId: string,
  machineId: string,
  generation: number,
) {
  return call<CloudViewerState>("cloud_computer_viewer_close", {
    workspaceId,
    machineId,
    generation,
  });
}
export function resizeCloudViewer(
  workspaceId: string,
  machineId: string,
  generation: number,
  bounds: CloudViewerBounds,
) {
  return call<CloudViewerState>("cloud_computer_viewer_resize", {
    workspaceId,
    machineId,
    generation,
    ...bounds,
  });
}
