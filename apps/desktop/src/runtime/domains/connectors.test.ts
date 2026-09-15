import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRuntimeConnectorStatuses } from "./connectors";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../bridge", () => ({
  hasTauriRuntime: () => true,
  activeDataScope: () => ({ workspaceId: "workspace-1" }),
  invoke: bridge.invoke,
  invokeNative: bridge.invoke,
}));

const native = {
  id: "notion",
  name: "Notion",
  status: "connected",
  account: { id: "work" },
  health: { state: "unknown" },
};
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_connector_statuses") return [native];
    if (command === "list_remote_mcp_connections")
      return [
        {
          launchReference: "marketplace-notion",
          authorizationState: "revoked",
          discoveryState: "unknown",
          discoveredTools: [],
          enabledTools: [],
        },
      ];
    if (command === "refresh_connector_health")
      return { ...native, health: { state: "healthy" } };
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("connector readiness before route selection", () => {
  it("verifies an older native account before deciding whether a broken remote setup hides it", async () => {
    expect(await listRuntimeConnectorStatuses()).toMatchObject([
      {
        id: "notion",
        status: "connected",
        connectionRoute: "native",
        health: { state: "healthy" },
      },
    ]);
    expect(bridge.invoke).toHaveBeenCalledWith("refresh_connector_health", {
      workspaceId: "workspace-1",
      connectorId: "notion",
    });
  });
  it("keeps reconnect available when native verification fails", async () => {
    const original = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "refresh_connector_health") throw new Error("Offline");
      return original(command);
    });
    expect(await listRuntimeConnectorStatuses()).toMatchObject([
      { id: "notion", status: "revoked", connectionRoute: "remote" },
    ]);
  });
});
