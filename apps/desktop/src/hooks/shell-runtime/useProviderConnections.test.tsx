import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProvider, BackendVerifyResult } from "@mivlet/protocol";
import { listBackendProviders } from "@mivlet/connectors";
import * as providersRuntime from "../../runtime/domains/providers";
import * as persistence from "../../lib/persistence";
import { defaultShellState } from "./defaults";
import { useProviderConnections } from "./useProviderConnections";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connected(id: string): BackendProvider {
  const provider = listBackendProviders().find((entry) => entry.id === id)!;
  return {
    ...provider,
    authState: "connected",
    capabilities: ["streaming"],
    models: provider.models.map((model) => ({ ...model, available: true })),
  };
}

function mount(selectedModelId = "", strict = false) {
  const identity = { current: "account-a" as string | null };
  const setLastAction = vi.fn();
  const wrapper = strict
    ? ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>
    : undefined;
  const hook = renderHook(
    ({ generation }) =>
      useProviderConnections({
        initialState: defaultShellState,
        workspaceScopeGeneration: generation,
        workspaceIdentityRef: identity,
        selectedModelId,
        hiddenModelIds: [],
        setLastAction,
      }),
    { initialProps: { generation: 1 }, wrapper },
  );
  return { ...hook, identity, setLastAction };
}

describe("provider startup and recovery", () => {
  beforeEach(() => {
    vi.spyOn(persistence, "hasTauriRuntime").mockReturnValue(true);
    vi.spyOn(providersRuntime, "listRuntimeBackends").mockResolvedValue([
      connected("openai"),
    ]);
    vi.spyOn(providersRuntime, "verifyRuntimeBackend").mockImplementation(
      async (providerId) => ({ providerId, outcome: "ready" }),
    );
    vi.spyOn(providersRuntime, "listRuntimeBackendModels").mockResolvedValue({
      outcome: "unsupported",
      models: [],
    });
    vi.spyOn(providersRuntime, "clearRuntimeBackend").mockResolvedValue(
      "cleared",
    );
    vi.spyOn(providersRuntime, "connectRuntimeBackend").mockResolvedValue(
      "stored",
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes the selected provider at 80ms while a secondary check takes 5000ms", async () => {
    vi.useFakeTimers();
    const primary = connected("openai");
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([
      primary,
      connected("xai"),
    ]);
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockImplementation(
      (providerId) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ providerId, outcome: "ready" }),
            providerId === "openai" ? 80 : 5000,
          );
        }),
    );
    const { result } = mount(`openai::${primary.models[0].id}`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    expect(
      result.current.backendProviders.every(
        (provider) => !provider.capabilities.includes("streaming"),
      ),
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(79);
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      result.current.connectedAgentBackends.map((provider) => provider.id),
    ).toEqual(["openai"]);
    expect(result.current.resolvedSelectedModelId).toBe(primary.models[0].id);
    expect(
      result.current.backendProviders.find((provider) => provider.id === "xai")
        ?.authState,
    ).toBe("connecting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4920);
    });
    expect(
      result.current.connectedAgentBackends.map((provider) => provider.id),
    ).toEqual(["openai", "xai"]);
  });

  it("admits a verified alternative when the selected credential fails without silently rerouting its model", async () => {
    const primary = connected("openai");
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([
      primary,
      connected("xai"),
    ]);
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockImplementation(
      async (providerId) => ({
        providerId,
        outcome: providerId === "openai" ? "auth-failed" : "ready",
      }),
    );
    const { result } = mount(`openai::${primary.models[0].id}`);
    await waitFor(() =>
      expect(
        result.current.connectedAgentBackends.map((provider) => provider.id),
      ).toEqual(["xai"]),
    );
    expect(result.current.resolvedSelectedModelId).toBe("");
    expect(
      result.current.backendProviders.find(
        (provider) => provider.id === "openai",
      ),
    ).toMatchObject({
      authState: "needs-auth",
      capabilities: [],
      installHint: expect.stringContaining("Replace the API key"),
    });
  });

  it("coalesces duplicate startup/list refreshes, health checks and model discovery", async () => {
    const listing = deferred<BackendProvider[]>();
    const verification = deferred<BackendVerifyResult | null>();
    const discovery =
      deferred<
        Awaited<ReturnType<typeof providersRuntime.listRuntimeBackendModels>>
      >();
    vi.mocked(providersRuntime.listRuntimeBackends).mockReturnValue(
      listing.promise,
    );
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockReturnValue(
      verification.promise,
    );
    vi.mocked(providersRuntime.listRuntimeBackendModels).mockReturnValue(
      discovery.promise,
    );
    const { result } = mount("", true);
    let refreshes!: Promise<unknown>;
    act(() => {
      refreshes = Promise.all([
        result.current.refreshBackendProviders(),
        result.current.refreshBackendProviders(),
      ]);
    });
    await act(async () => {
      listing.resolve([connected("openai")]);
      await refreshes;
    });
    expect(providersRuntime.listRuntimeBackends).toHaveBeenCalledTimes(1);
    let checks!: Promise<unknown>;
    act(() => {
      checks = Promise.all([
        result.current.checkBackendConnection("openai"),
        result.current.checkBackendConnection("openai"),
      ]);
    });
    await act(async () => {
      verification.resolve({ providerId: "openai", outcome: "ready" });
      await checks;
    });
    expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(1);
    let models!: Promise<unknown>;
    act(() => {
      models = Promise.all([
        result.current.refreshModels("openai"),
        result.current.refreshModels("openai"),
      ]);
    });
    await act(async () => {
      discovery.resolve({
        outcome: "success",
        models: connected("openai").models,
      });
      await models;
    });
    expect(providersRuntime.listRuntimeBackendModels).toHaveBeenCalledTimes(1);
    expect(result.current.modelDiscoveryByProvider.openai).toBe("success");
  });

  it("ignores checks and discovery after the account identity changes before a render", async () => {
    const verification = deferred<BackendVerifyResult | null>();
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockReturnValueOnce(
      verification.promise,
    );
    const { result, identity, rerender } = mount();
    await waitFor(() =>
      expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(1),
    );
    identity.current = "account-b";
    await act(async () => {
      verification.resolve({ providerId: "openai", outcome: "ready" });
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([]);
    rerender({ generation: 2 });
    await waitFor(() => expect(result.current.backendProviders).toEqual([]));
    expect(result.current.connectedBackendIds).toEqual([]);
    expect(providersRuntime.listRuntimeBackendModels).not.toHaveBeenCalled();
  });

  it("does not apply an old account's discovery to the new account's models", async () => {
    const discovery =
      deferred<
        Awaited<ReturnType<typeof providersRuntime.listRuntimeBackendModels>>
      >();
    vi.mocked(providersRuntime.listRuntimeBackendModels).mockReturnValueOnce(
      discovery.promise,
    );
    const { result, identity, rerender } = mount();
    await waitFor(() =>
      expect(result.current.modelDiscoveryByProvider.openai).toBe("loading"),
    );
    identity.current = "account-b";
    rerender({ generation: 2 });
    await waitFor(() =>
      expect(result.current.modelDiscoveryByProvider.openai).toBe(
        "unsupported",
      ),
    );
    await act(async () => {
      discovery.resolve({
        outcome: "success",
        models: [{ id: "old-account-only", available: true }],
      });
    });
    expect(
      result.current.modelOptions.some(
        (model) => model.modelId === "old-account-only",
      ),
    ).toBe(false);
    expect(result.current.modelDiscoveryByProvider.openai).toBe("unsupported");
  });

  it("rejects a verification settling during disconnect and removes availability immediately", async () => {
    const verification = deferred<BackendVerifyResult | null>();
    const clearing = deferred<string | null>();
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.connectedAgentBackends).toHaveLength(1),
    );
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockReturnValueOnce(
      verification.promise,
    );
    vi.mocked(providersRuntime.clearRuntimeBackend).mockReturnValueOnce(
      clearing.promise,
    );
    let check!: Promise<BackendVerifyResult>;
    let disconnect!: Promise<unknown>;
    act(() => {
      check = result.current.checkBackendConnection("openai");
      disconnect = result.current.disconnectBackend("openai");
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    await act(async () => {
      verification.resolve({ providerId: "openai", outcome: "ready" });
      await check;
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([
      { ...connected("openai"), authState: "needs-auth", capabilities: [] },
    ]);
    await act(async () => {
      clearing.resolve("cleared");
      await disconnect;
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    expect(result.current.backendStatus).toBe("openai disconnected.");
  });

  it("ignores old discovery after a key is replaced and verifies the new credential once", async () => {
    const discovery =
      deferred<
        Awaited<ReturnType<typeof providersRuntime.listRuntimeBackendModels>>
      >();
    vi.mocked(providersRuntime.listRuntimeBackendModels).mockReturnValueOnce(
      discovery.promise,
    );
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.modelDiscoveryByProvider.openai).toBe("loading"),
    );
    await act(async () => {
      await result.current.connectBackendWithVerify(
        "openai",
        "synthetic-test-key",
      );
    });
    await waitFor(() =>
      expect(result.current.modelDiscoveryByProvider.openai).toBe(
        "unsupported",
      ),
    );
    await act(async () => {
      discovery.resolve({
        outcome: "success",
        models: [{ id: "old-key-only", available: true }],
      });
    });
    expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(2);
    expect(
      result.current.modelOptions.some(
        (model) => model.modelId === "old-key-only",
      ),
    ).toBe(false);
    expect(JSON.stringify(result.current.backendProviders)).not.toContain(
      "synthetic-test-key",
    );
  });

  it("bounds an unresponsive check, rejects its late success, and permits an explicit retry", async () => {
    vi.useFakeTimers();
    const verification = deferred<BackendVerifyResult | null>();
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockReturnValueOnce(
      verification.promise,
    );
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    expect(
      result.current.backendProviders.find(
        (provider) => provider.id === "openai",
      ),
    ).toMatchObject({
      authState: "unavailable",
      installHint: expect.stringContaining("Check connection"),
    });
    await act(async () => {
      verification.resolve({ providerId: "openai", outcome: "ready" });
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    await act(async () => {
      await result.current.checkBackendConnection("openai");
    });
    expect(result.current.connectedAgentBackends).toHaveLength(1);
    expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(2);
  });

  it("never reads saved providers before a native account is bound", async () => {
    const identity = { current: null as string | null };
    const { result } = renderHook(() =>
      useProviderConnections({
        initialState: { ...defaultShellState, connectedBackendIds: ["openai"] },
        workspaceScopeGeneration: 0,
        workspaceIdentityRef: identity,
        selectedModelId: "",
        hiddenModelIds: [],
        setLastAction: vi.fn(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(providersRuntime.listRuntimeBackends).not.toHaveBeenCalled();
    expect(result.current.connectedAgentBackends).toEqual([]);
    expect(result.current.connectedBackendIds).toEqual([]);
  });

  it("keeps an unrelated startup check useful when storing another credential fails", async () => {
    const secondary = deferred<BackendVerifyResult | null>();
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([
      connected("openai"),
      connected("xai"),
    ]);
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockImplementation(
      async (providerId) =>
        providerId === "xai"
          ? secondary.promise
          : { providerId, outcome: "ready" },
    );
    const { result } = mount();
    await waitFor(() =>
      expect(result.current.connectedAgentBackends).toHaveLength(1),
    );
    vi.mocked(providersRuntime.connectRuntimeBackend).mockRejectedValueOnce(
      new Error("Credential storage unavailable"),
    );
    await act(async () => {
      await result.current.connectBackendWithVerify(
        "anthropic",
        "synthetic-test-key",
      );
    });
    await act(async () => {
      secondary.resolve({ providerId: "xai", outcome: "ready" });
    });
    expect(
      result.current.connectedAgentBackends.map((provider) => provider.id),
    ).toEqual(["openai", "xai"]);
  });

  it("rejects a pending check when a refreshed catalogue removes that connection", async () => {
    const verification = deferred<BackendVerifyResult | null>();
    vi.mocked(providersRuntime.verifyRuntimeBackend).mockReturnValueOnce(
      verification.promise,
    );
    const { result } = mount();
    await waitFor(() =>
      expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(1),
    );
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([]);
    await act(async () => {
      await result.current.refreshBackendProviders();
    });
    await act(async () => {
      verification.resolve({ providerId: "openai", outcome: "ready" });
    });
    expect(result.current.connectedAgentBackends).toEqual([]);
    vi.mocked(providersRuntime.listRuntimeBackends).mockResolvedValue([
      connected("openai"),
    ]);
    let snapshot: BackendProvider[] | null = null;
    await act(async () => {
      snapshot = await result.current.refreshBackendProviders();
    });
    expect(snapshot!).toEqual([
      expect.objectContaining({
        id: "openai",
        authState: "connecting",
        capabilities: [],
      }),
    ]);
    expect(providersRuntime.verifyRuntimeBackend).toHaveBeenCalledTimes(2);
  });
});
