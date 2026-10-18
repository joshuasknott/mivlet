import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectorAccountOption,
  ConnectorManifest,
} from "@mivlet/protocol";
import * as connectorsRuntime from "../../runtime/domains/connectors";
import { useConnectorOperations } from "./useConnectorOperations";

vi.mock("../../runtime/domains/connectors", () => ({
  beginRuntimeConnectorOAuth: vi.fn(),
  clearRuntimeConnectorAuth: vi.fn(),
  listRuntimeConnectorAccounts: vi.fn(),
  refreshRuntimeConnectorHealth: vi.fn(),
  switchRuntimeConnectorAccount: vi.fn(),
  syncRuntimeConnector: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const connector = {
  id: "gmail",
  name: "Gmail",
  status: "connected",
} as ConnectorManifest;

function mount(scope: { current: number }) {
  const setConnectorManifests = vi.fn();
  const setConnectorAccounts = vi.fn();
  const setConnectorStatus = vi.fn();
  const setLastAction = vi.fn();
  const hook = renderHook(() =>
    useConnectorOperations({
      connectorScopeRef: scope,
      connectorManifests: [connector],
      setConnectorManifests,
      setConnectorAccounts,
      setConnectorStatus,
      activeWorkspaceScope: { workspaceId: "workspace-a" },
      setLastAction,
    }),
  );
  return {
    ...hook,
    setConnectorManifests,
    setConnectorAccounts,
    setConnectorStatus,
    setLastAction,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("connector account operation scope fences", () => {
  it("ignores a switch response that completes after the workspace changes", async () => {
    const scope = { current: 1 };
    const pending = deferred<ConnectorManifest | null>();
    vi.mocked(connectorsRuntime.switchRuntimeConnectorAccount).mockReturnValue(
      pending.promise,
    );
    const { result, setConnectorManifests, setConnectorAccounts, setConnectorStatus } =
      mount(scope);

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.switchConnectorAccount(
        "gmail",
        "gmail-work",
      );
      scope.current = 2;
      pending.resolve({
        ...connector,
        account: { displayName: "Work", email: "work@example.com" },
      } as ConnectorManifest);
    });
    await act(async () => {
      await operation;
    });

    expect(setConnectorManifests).not.toHaveBeenCalled();
    expect(setConnectorAccounts).not.toHaveBeenCalled();
    expect(setConnectorStatus).not.toHaveBeenCalled();
  });

  it("does not apply accounts returned for an old workspace", async () => {
    const scope = { current: 1 };
    const pending = deferred<ConnectorAccountOption[] | null>();
    vi.mocked(connectorsRuntime.listRuntimeConnectorAccounts).mockReturnValue(
      pending.promise,
    );
    const { result, setConnectorAccounts, setConnectorStatus } = mount(scope);

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.loadConnectorAccounts("gmail");
      scope.current = 2;
      pending.resolve([]);
    });
    await act(async () => {
      await operation;
    });

    expect(setConnectorAccounts).not.toHaveBeenCalled();
    expect(setConnectorStatus).not.toHaveBeenCalled();
  });

  it("does not apply a stale connector sync or its status", async () => {
    const scope = { current: 1 };
    const pending = deferred<Awaited<ReturnType<typeof connectorsRuntime.syncRuntimeConnector>>>();
    vi.mocked(connectorsRuntime.syncRuntimeConnector).mockReturnValue(
      pending.promise,
    );
    const { result, setConnectorManifests, setConnectorStatus } = mount(scope);

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.refreshConnector("gmail");
      scope.current = 2;
      pending.resolve(null);
    });
    await act(async () => {
      await operation;
    });

    expect(connectorsRuntime.syncRuntimeConnector).toHaveBeenCalledWith({
      connectorId: "gmail",
      workspaceId: "workspace-a",
      trigger: "manual",
    });
    expect(setConnectorManifests).not.toHaveBeenCalled();
    expect(setConnectorStatus).not.toHaveBeenCalled();
  });

  it("ignores a connect error that completes after the workspace changes", async () => {
    const scope = { current: 1 };
    const pending = deferred<never>();
    vi.mocked(connectorsRuntime.beginRuntimeConnectorOAuth).mockReturnValue(
      pending.promise,
    );
    const { result, setConnectorStatus, setLastAction } = mount(scope);

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.connectConnector(connector);
      scope.current = 2;
      pending.reject(new Error("old workspace authorization failed"));
    });
    await act(async () => {
      await operation;
    });

    expect(setConnectorStatus).toHaveBeenCalledTimes(1);
    expect(setConnectorStatus).toHaveBeenCalledWith(
      "Preparing Gmail authorization...",
    );
    expect(setLastAction).not.toHaveBeenCalled();
  });

  it("ignores a disconnect error that completes after the workspace changes", async () => {
    const scope = { current: 1 };
    const pending = deferred<never>();
    vi.mocked(connectorsRuntime.clearRuntimeConnectorAuth).mockReturnValue(
      pending.promise,
    );
    const { result, setConnectorStatus } = mount(scope);

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.disconnectConnector("gmail");
      scope.current = 2;
      pending.reject(new Error("old workspace disconnect failed"));
    });
    await act(async () => {
      await operation;
    });

    expect(setConnectorStatus).not.toHaveBeenCalled();
  });

  it("keeps current connect errors rejected and visible", async () => {
    const scope = { current: 1 };
    vi.mocked(connectorsRuntime.beginRuntimeConnectorOAuth).mockRejectedValue(
      new Error("authorization failed"),
    );
    const { result, setConnectorStatus, setLastAction } = mount(scope);

    await expect(result.current.connectConnector(connector)).rejects.toThrow(
      "authorization failed",
    );
    expect(setConnectorStatus).toHaveBeenLastCalledWith("authorization failed");
    expect(setLastAction).toHaveBeenLastCalledWith("authorization failed");
  });

  it("keeps current disconnect errors rejected and visible", async () => {
    const scope = { current: 1 };
    vi.mocked(connectorsRuntime.clearRuntimeConnectorAuth).mockRejectedValue(
      new Error("disconnect failed"),
    );
    const { result, setConnectorStatus } = mount(scope);

    await expect(result.current.disconnectConnector("gmail")).rejects.toThrow(
      "disconnect failed",
    );
    expect(setConnectorStatus).toHaveBeenLastCalledWith("disconnect failed");
  });
});
