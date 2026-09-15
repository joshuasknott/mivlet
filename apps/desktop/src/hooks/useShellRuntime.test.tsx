import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime0 from "../runtime/domains/account";
import { MivletQueryProvider } from "../lib/query-client";
import { clearActiveRuntimeDataScope } from "../runtime-scope";
import { useShellRuntime } from "./useShellRuntime";

function wrapper({ children }: PropsWithChildren) {
  return <MivletQueryProvider>{children}</MivletQueryProvider>;
}

describe("conversation shell runtime", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveRuntimeDataScope();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("shares approval preferences when creating, editing and deleting agents", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    const first = result.current.agents[0];
    act(() => result.current.selectPermissionLabel("Work Freely"));
    let created = "";
    act(() => { created = result.current.createAgent({ ...first, name: "New", permissionLabel: "Read Only" }).id; });
    expect(result.current.permissionLabel).toBe("Work Freely");
    act(() => result.current.updateAgent(created, { permissionLabel: "Ask Me" }));
    expect(result.current.permissionLabel).toBe("Work Freely");
    act(() => result.current.removeAgent(created));
    expect(result.current.permissionLabel).toBe("Work Freely");
  });

  it("hides models across conversations without silently rerouting a selected model", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await act(async () => { await result.current.connectBackend("xai", "test-key"); });
    const model = result.current.modelOptions.find((option) => option.available)!;
    act(() => result.current.selectModel(model.id));
    act(() => result.current.setModelVisible(model.id, false));
    expect(result.current.modelOptions.some((option) => option.id === model.id)).toBe(false);
    expect(result.current.allModelOptions.some((option) => option.id === model.id)).toBe(true);
    expect(result.current.resolvedSelectedModelId).toBe("");
    act(() => result.current.selectModel(model.id));
    expect(result.current.selectedModelId).toBe(model.id);
    expect(result.current.resolvedSelectedModelId).toBe("");
    act(() => result.current.setModelVisible(model.id, true));
    expect(result.current.resolvedSelectedModelId).toBe(model.modelId);
  });

  it("opens an authenticated workspace without a provider or completed onboarding", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });

    await waitFor(() =>
      expect(result.current.accountWorkspaceStatus.state).toBe("ready"),
    );
    expect(result.current.identityStatus.state).toBe("signed-in");
    expect(result.current.connectedBackendIds).toEqual([]);
    expect(result.current.onboardingRequired).toBe(false);
  });

  it("requires authentication when the account is signed out", async () => {
    vi.spyOn(runtime0, "loadRuntimeIdentityStatus").mockResolvedValue({
      enabled: true, state: "signed-out", message: "Sign in to continue.", scopes: [],
    });
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.identityStatus.state).toBe("signed-out"));
    expect(result.current.onboardingRequired).toBe(true);
  });

  it("connects the supported xAI API path without retaining the submitted key", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });

    await act(async () => {
      await result.current.connectBackend("xai", "xai-test-key");
    });
    expect(result.current.connectedBackendIds).toContain("xai");
    expect(JSON.stringify(result.current.backendProviders)).not.toContain(
      "xai-test-key",
    );
    expect(result.current.connectedAgentBackend?.id).toBe("xai");
    expect(result.current.modelOptions.map((model) => model.modelId)).toContain(
      "grok-4",
    );

    expect(result.current.onboardingRequired).toBe(false);
  });

  it("maps custom approval choices onto the existing permission levels", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() =>
      expect(result.current.accountWorkspaceStatus.state).toBe("ready"),
    );

    act(() =>
      result.current.updateCustomApprovalSetting("allowSmallLocalEdits", true),
    );
    expect(result.current.permissionLabel).toBe("Custom");
    expect(result.current.permissionMode).toBe("trusted-scope");

    act(() =>
      result.current.updateCustomApprovalSetting("allowPowerfulCommands", true),
    );
    expect(result.current.permissionMode).toBe("full-access");
  });

  it("assigns a persistent portrait to every created agent without an icon catalogue limit", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    const template = result.current.agents[0];
    const created = Array.from({ length: 12 }, (_, index) => {
      let createdId = "";
      act(() => { createdId = result.current.createAgent({ ...template, name: `Agent ${index}`, avatarSeed: undefined }).id; });
      return result.current.agents.find((agent) => agent.id === createdId)!;
    });
    expect(new Set(created.map((agent) => agent.avatarSeed)).size).toBe(12);
    act(() => result.current.updateAgent(created[0].id, { name: "New name" }));
    expect(result.current.agents.find((agent) => agent.id === created[0].id)?.avatarSeed).toBe(created[0].avatarSeed);
  });
});
