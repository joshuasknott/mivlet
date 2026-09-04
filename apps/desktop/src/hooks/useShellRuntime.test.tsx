import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { FableQueryProvider } from "../lib/query-client";
import { clearActiveRuntimeDataScope } from "../runtime-scope";
import { useShellRuntime } from "./useShellRuntime";

function wrapper({ children }: PropsWithChildren) {
  return <FableQueryProvider>{children}</FableQueryProvider>;
}

describe("conversation shell runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveRuntimeDataScope();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
  });

  it("keeps entry gated until a provider is connected and setup is completed", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });

    await waitFor(() =>
      expect(result.current.accountWorkspaceStatus.state).toBe("ready"),
    );
    expect(result.current.onboardingRequired).toBe(true);

    act(() => result.current.dismissOnboarding());
    expect(result.current.onboardingRequired).toBe(true);
    expect(result.current.backendStatus).toBe(
      "Connect and verify a model provider before entering Fable.",
    );
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

    act(() => result.current.dismissOnboarding());
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

  it("assigns a persistent portrait to every created teammate without an icon catalogue limit", async () => {
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
