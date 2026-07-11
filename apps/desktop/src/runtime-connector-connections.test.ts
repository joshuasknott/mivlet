import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRuntimeConnectorAccounts, switchRuntimeConnectorAccount } from "./runtime";
import { setActiveRuntimeDataScope } from "./runtime-scope";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("connector Connection runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
    setActiveRuntimeDataScope("default");
  });

  it("does not project or select Connections outside Tauri", async () => {
    await expect(listRuntimeConnectorAccounts("gmail")).resolves.toBeNull();
    await expect(switchRuntimeConnectorAccount("gmail", "connection-safe")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("selects only the opaque Connection id inside the active workspace", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce([{ connectionId: "connection-safe", active: true }])
      .mockResolvedValueOnce({ id: "gmail", status: "connected" });

    await listRuntimeConnectorAccounts("gmail");
    await switchRuntimeConnectorAccount("gmail", "connection-safe");

    expect(mocks.invoke.mock.calls).toEqual([
      ["list_connector_accounts", { connectorId: "gmail", workspaceId: "default" }],
      ["switch_connector_account", {
        connectorId: "gmail",
        connectionId: "connection-safe",
        workspaceId: "default"
      }]
    ]);
  });
});
