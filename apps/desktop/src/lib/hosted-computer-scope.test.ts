import { describe, expect, it } from "vitest";
import type {
  AccountDeviceSummary,
  AccountWorkspaceStatus,
  AccountWorkspaceSummary,
} from "@mivlet/protocol";
import {
  resolveHostedComputerScope,
  resolveHostedDeviceId,
  resolveHostedWorkspaceId,
} from "./hosted-computer-scope";

const membership = (
  over: Partial<AccountWorkspaceSummary> &
    Pick<AccountWorkspaceSummary, "fableWorkspaceId">,
): AccountWorkspaceSummary => ({
  localWorkspaceId: `local-${over.fableWorkspaceId}`,
  name: over.fableWorkspaceId,
  workspaceStatus: "active",
  workspaceRevision: 1,
  policyRevision: 1,
  memberId: `member-${over.fableWorkspaceId}`,
  role: "editor",
  membershipStatus: "active",
  membershipRevision: 1,
  updatedAt: "2026-09-15T12:00:00.000Z",
  ...over,
});

const device = (
  over: Partial<AccountDeviceSummary> & Pick<AccountDeviceSummary, "deviceId">,
): AccountDeviceSummary => ({
  kind: "desktop",
  label: over.deviceId,
  status: "active",
  registeredAt: "2026-09-15T12:00:00.000Z",
  ...over,
});

const status = (
  over: Partial<AccountWorkspaceStatus> = {},
): AccountWorkspaceStatus => ({
  configured: true,
  state: "ready",
  message: "Ready.",
  accountBound: true,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "default",
    name: "On this PC",
    source: "local",
  },
  activeContextOwner: { internalUserId: "user-a", memberId: "member-a" },
  devices: [],
  ...over,
});

describe("hosted computer scope", () => {
  it("uses the only active membership and device without list-order search", () => {
    const workspaces = [membership({ fableWorkspaceId: "workspace-zeta" })];
    const devices = [
      device({ deviceId: "device-revoked", status: "revoked" }),
      device({ deviceId: "device-desktop" }),
    ];
    expect(resolveHostedWorkspaceId(workspaces, status().activeWorkspace)).toBe(
      "workspace-zeta",
    );
    expect(resolveHostedDeviceId(devices)).toBe("device-desktop");
    expect(resolveHostedComputerScope(status({ workspaces, devices }))).toEqual(
      {
        workspaceId: "workspace-zeta",
        deviceId: "device-desktop",
      },
    );
  });

  it("does not use the first mirrored membership when several are active", () => {
    const workspaces = [
      membership({ fableWorkspaceId: "workspace-alpha", name: "Alpha" }),
      membership({ fableWorkspaceId: "workspace-beta", name: "Beta" }),
    ];
    expect(
      resolveHostedWorkspaceId(workspaces, status().activeWorkspace),
    ).toBeNull();
    expect(
      resolveHostedComputerScope(
        status({
          workspaces,
          devices: [device({ deviceId: "device-desktop" })],
        }),
      ),
    ).toBeNull();
  });

  it("uses an explicit selection that matches the local active context", () => {
    const workspaces = [
      membership({
        fableWorkspaceId: "workspace-alpha",
        localWorkspaceId: "local-alpha",
        name: "Alpha",
      }),
      membership({
        fableWorkspaceId: "workspace-beta",
        localWorkspaceId: "local-beta",
        name: "Beta",
      }),
    ];
    const devices = [device({ deviceId: "device-desktop" })];
    expect(
      resolveHostedComputerScope(
        status({
          workspaces,
          devices,
          activeWorkspace: {
            localWorkspaceId: "default",
            fableWorkspaceId: "workspace-beta",
            name: "On this PC",
            source: "local",
          },
        }),
      ),
    ).toEqual({
      workspaceId: "workspace-beta",
      deviceId: "device-desktop",
    });
    expect(
      resolveHostedWorkspaceId(workspaces, {
        localWorkspaceId: "local-beta",
        fableWorkspaceId: "workspace-beta",
        name: "Beta",
        source: "hosted",
      }),
    ).toBe("workspace-beta");
  });

  it("rejects a mismatched hosted selection or draft workspace", () => {
    const workspaces = [
      membership({
        fableWorkspaceId: "workspace-alpha",
        localWorkspaceId: "local-alpha",
      }),
      membership({
        fableWorkspaceId: "workspace-beta",
        localWorkspaceId: "local-beta",
      }),
    ];
    expect(
      resolveHostedWorkspaceId(workspaces, {
        localWorkspaceId: "default",
        fableWorkspaceId: "workspace-missing",
        name: "On this PC",
        source: "local",
      }),
    ).toBeNull();
    expect(
      resolveHostedWorkspaceId(workspaces, {
        localWorkspaceId: "local-alpha",
        fableWorkspaceId: "workspace-beta",
        name: "Beta",
        source: "hosted",
      }),
    ).toBeNull();
    expect(
      resolveHostedDeviceId([
        device({ deviceId: "device-a" }),
        device({ deviceId: "device-b" }),
      ]),
    ).toBeNull();
  });
});
