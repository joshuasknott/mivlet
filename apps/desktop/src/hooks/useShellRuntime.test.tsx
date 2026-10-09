import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime0 from "../runtime/domains/account";
import * as memoryRuntime from "../runtime/domains/memory";
import { MivletQueryProvider } from "../lib/query-client";
import { clearActiveRuntimeDataScope } from "../runtime-scope";
import { useShellRuntime } from "./useShellRuntime";

function wrapper({ children }: PropsWithChildren) {
  return <MivletQueryProvider>{children}</MivletQueryProvider>;
}

describe("conversation shell runtime", () => {
  it("requires a fresh MCP App proposal instead of offering unsupported approval modification", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    const request = { id: "app-approval", service: "mcp", action: "get-time", mode: "read-only" as const, riskLevel: "low" as const, dataUsed: [], consequence: "Read the local clock", requestedAt: new Date().toISOString(), decisions: ["once", "modify", "deny"] as const };
    let resolution: Promise<unknown>;
    act(() => { resolution = result.current.requestMcpAppApproval({ request: { ...request, decisions: [...request.decisions] }, toolName: "get-time", arguments: {}, owner: { workspaceId: "preview-default", conversationId: "test-chat", resultId: "test-result", generation: 1 } }); });
    expect(result.current.openApprovals.find(item => item.id === request.id)?.decisions).toEqual(["once", "deny"]);
    act(() => result.current.startApprovalModify({ ...request, decisions: [...request.decisions] }));
    expect(result.current.editingApprovalId).toBeNull();
    act(() => result.current.clearBackendToolApprovals([request.id]));
    await expect(resolution!).resolves.toBeNull();
  });
  it("enforces frozen file exclusions in the actual request context assembly", async () => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    let sourceId: string | null = null;
    await act(async () => { sourceId = await result.current.importKnowledgeFile(new File(["Orchard plan: plant exactly twelve apple trees."], "orchard.md", { type: "text/markdown" }), "Orchard plan: plant exactly twelve apple trees."); });
    expect(sourceId).toBeTruthy();
    const included = await result.current.assembleConversationContext("orchard apple trees", { allowedKnowledgeSourceIds: [sourceId!], excludePrivateMemory: true, excludeDerivedSummaries: true });
    expect(included.systemPrefix).toContain("twelve apple trees");
    const excluded = await result.current.assembleConversationContext("orchard apple trees", { allowedKnowledgeSourceIds: [sourceId!], excludedKnowledgeSourceIds: [sourceId!], excludePrivateMemory: true, excludeDerivedSummaries: true });
    expect(excluded.systemPrefix).not.toContain("twelve apple trees");
    expect(excluded.receipt.citations).toEqual([]);
  });
  it("saves only an explicit new chat memory and uses the native merged result", async () => {
    const save = vi.spyOn(memoryRuntime, "saveRuntimeMemoryState").mockImplementation(async state => state);
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    await act(async () => result.current.addChatMemory("chat", " Decision ", " Keep it simple "));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ records: [expect.objectContaining({ title: "Decision", value: "Keep it simple", scope: { level: "thread", threadId: "chat" }, approved: true, provenance: { origin: "manual", note: "Saved explicitly in this chat" } })] }));
    expect(result.current.managedMemoryRecords).toHaveLength(1);
  });
  it("does not report a saved memory when native persistence is unavailable", async () => {
    vi.spyOn(memoryRuntime, "saveRuntimeMemoryState").mockResolvedValue(null);
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.state).toBe("ready"));
    const before = result.current.managedMemoryRecords;
    await expect(result.current.addChatMemory("chat", "Decision", "Keep it simple")).rejects.toThrow("requires the desktop app");
    expect(result.current.managedMemoryRecords).toEqual(before);
  });
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
