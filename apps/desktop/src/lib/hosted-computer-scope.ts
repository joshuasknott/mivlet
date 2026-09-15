import type {
  AccountDeviceSummary,
  AccountWorkspaceStatus,
  AccountWorkspaceSummary,
  ActiveWorkspaceSelection
} from "@fable/protocol";

/** Exact hosted computer identity. Never inferred from list order. */
export interface HostedComputerScope {
  workspaceId: string;
  deviceId: string;
}

function isActiveMembership(workspace: AccountWorkspaceSummary): boolean {
  return workspace.workspaceStatus === "active" && workspace.membershipStatus === "active";
}

/**
 * Resolves the hosted Convex workspace for computer tools.
 *
 * Explicit native selection matching the local active context wins. Otherwise
 * the sole active membership is used. Multiple memberships never fall back to
 * the first mirrored row.
 */
export function resolveHostedWorkspaceId(
  workspaces: readonly AccountWorkspaceSummary[],
  activeWorkspace: ActiveWorkspaceSelection
): string | null {
  const active = workspaces.filter(isActiveMembership);
  const selected = activeWorkspace.fableWorkspaceId?.trim();
  if (selected) {
    const match = active.find((workspace) => workspace.fableWorkspaceId === selected);
    if (!match) return null;
    if (
      activeWorkspace.source === "hosted" &&
      match.localWorkspaceId !== activeWorkspace.localWorkspaceId
    ) {
      return null;
    }
    return match.fableWorkspaceId;
  }
  return active.length === 1 ? active[0]?.fableWorkspaceId ?? null : null;
}

/** This installation's hosted device. Multiple active devices fail closed. */
export function resolveHostedDeviceId(devices: readonly AccountDeviceSummary[]): string | null {
  const active = devices.filter((device) => device.status === "active");
  return active.length === 1 ? active[0]?.deviceId ?? null : null;
}

export function resolveHostedComputerScope(
  status: AccountWorkspaceStatus
): HostedComputerScope | null {
  const workspaceId = resolveHostedWorkspaceId(status.workspaces, status.activeWorkspace);
  const deviceId = resolveHostedDeviceId(status.devices);
  if (!workspaceId || !deviceId) return null;
  return { workspaceId, deviceId };
}
