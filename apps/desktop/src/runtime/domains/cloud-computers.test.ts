import { beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({
  activeDataScope: vi.fn(),
  hasTauriRuntime: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("../bridge", () => bridge);
import { changeCloudComputer, cloudComputerStatus } from "./cloud-computers";
const scope = { workspaceId: "workspace-one" };
beforeEach(() => {
  vi.resetAllMocks();
  bridge.activeDataScope.mockReturnValue(scope);
  bridge.hasTauriRuntime.mockReturnValue(true);
  bridge.invoke.mockResolvedValue({ connected: false });
});
it("does not emulate a successful connection outside the native app", async () => {
  bridge.hasTauriRuntime.mockReturnValue(false);
  await expect(cloudComputerStatus(scope.workspaceId)).rejects.toThrow(
    "Windows desktop",
  );
  expect(bridge.invoke).not.toHaveBeenCalled();
});
it("rejects a different workspace before dispatch", async () => {
  await expect(
    changeCloudComputer("other", 1, { kind: "create", name: "Example" }),
  ).rejects.toThrow("workspace changed");
  expect(bridge.invoke).not.toHaveBeenCalled();
});
it("preserves safe native prerequisite errors for setup recovery", async () => {
  bridge.invoke.mockRejectedValue(
    "This Instabox account has reached its computer limit.",
  );
  await expect(
    changeCloudComputer(scope.workspaceId, 4, {
      kind: "create",
      name: "Example",
    }),
  ).rejects.toThrow("This Instabox account has reached its computer limit.");
  expect(bridge.invoke).toHaveBeenCalledOnce();
});
it("rejects late responses after an account transition, even in the same workspace", async () => {
  bridge.invoke.mockImplementation(async () => {
    bridge.activeDataScope.mockReturnValue({ ...scope });
    return {};
  });
  await expect(cloudComputerStatus(scope.workspaceId)).rejects.toThrow(
    "account or workspace changed",
  );
});
it("sends exact revision and machine metadata without accepting a key argument", async () => {
  await changeCloudComputer(scope.workspaceId, 4, {
    kind: "pause",
    machineId: "machine-one",
  });
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(
    "cloud_computer_pause",
    {
      request: {
        workspaceId: scope.workspaceId,
        expectedRevision: 4,
        machineId: "machine-one",
      },
    },
  );
});

it("passes through native cancellation while still rejecting a changed account", async () => {
  bridge.invoke.mockResolvedValue(null);
  await expect(
    changeCloudComputer(scope.workspaceId, 4, {
      kind: "connect",
      agentId: "agent-one",
    }),
  ).resolves.toBeNull();
  bridge.invoke.mockImplementation(async () => {
    bridge.activeDataScope.mockReturnValue({ ...scope });
    return null;
  });
  await expect(
    changeCloudComputer(scope.workspaceId, 4, {
      kind: "connect",
      agentId: "agent-one",
    }),
  ).rejects.toThrow("account or workspace changed");
});
