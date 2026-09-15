import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceStatus, RuntimeSnapshot } from "@fable/protocol";
import { createApprovalGate } from "@fable/connectors/native-api/tool-executor";
import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import { FableQueryProvider } from "../lib/query-client";
import { clearActiveRuntimeDataScope } from "../runtime-scope";
import { PREVIEW_ACCOUNT_WORKSPACE_STATUS } from "./shell-runtime/defaults";
import { useShellRuntime } from "./useShellRuntime";
import { defaultShellState } from "./shell-runtime/defaults";
import { shellStateToRuntimeSnapshot } from "../lib/persistence";
import { resolveApprovalFallback } from "../lib/approval-fallbacks";
import type { ApprovalResolutionRequest, ApprovalResolutionResponse } from "@fable/protocol";

const mocks = vi.hoisted(() => ({ status: null as AccountWorkspaceStatus | null,
  resolveApproval: vi.fn<(request: ApprovalResolutionRequest) => Promise<ApprovalResolutionResponse>>(),
  loadSnapshot: vi.fn<() => Promise<RuntimeSnapshot | null>>(async () => null),
  saveSnapshot: vi.fn(async (_snapshot: RuntimeSnapshot, _workspaceId?: string) => null),
}));
vi.mock("../runtime/domains/account", async (original) => ({
...await original<typeof import("../runtime/domains/account")>(),
loadRuntimeAccountWorkspaceStatus: async () => mocks.status,
reconcileRuntimeAccountWorkspace: async () => mocks.status
}));
vi.mock("../runtime/domains/workspace", async (original) => ({
...await original<typeof import("../runtime/domains/workspace")>(),
loadRuntimeSnapshot: mocks.loadSnapshot,
saveRuntimeSnapshot: mocks.saveSnapshot
}));
vi.mock("../runtime/domains/approvals", async (original) => ({
...await original<typeof import("../runtime/domains/approvals")>(),
resolveRuntimeApprovalRequest: mocks.resolveApproval
}));
vi.mock("../lib/persistence", async (original) => ({
  ...await original<typeof import("../lib/persistence")>(),
  hasTauriRuntime: () => true,
}));

function wrapper({ children }: PropsWithChildren) { return <FableQueryProvider>{children}</FableQueryProvider>; }

describe("approval queue workspace hydration", () => {
  it("confirms an exact pending connector action with one Approve click", async () => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    act(() => result.current.selectPermissionLabel("Ask Me"));
    const approval = { ...buildToolApproval("Codex", "connector-action", "{}"), riskLevel: "critical" as const, confirmationPhrase: "Confirm exact action" };
    gate.register(approval);
    const outcome = gate.waitForDecision(approval);
    act(() => result.current.recordBackendToolCall({ callId: approval.id, tool: "connector-action", arguments: "{}", approval }));
    await act(async () => result.current.requestApprovalDecision(approval, "once"));
    await expect(outcome).resolves.toBe("granted");
    expect(mocks.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({ request: approval, decision: "once", confirmationText: "Confirm exact action" }));
    expect(result.current.pendingApprovalConfirmation).toBeNull();
  });
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveRuntimeDataScope();
    mocks.loadSnapshot.mockReset().mockResolvedValue(null);
    mocks.saveSnapshot.mockClear();
    mocks.resolveApproval.mockReset().mockImplementation(async (request) => resolveApprovalFallback(request));
    mocks.status = { ...PREVIEW_ACCOUNT_WORKSPACE_STATUS, activeWorkspace: { ...PREVIEW_ACCOUNT_WORKSPACE_STATUS.activeWorkspace, localWorkspaceId: "local-default" }, activeContextOwner: { internalUserId: "owner-a" } };
  });

  it.each(["success", "failure", "downgrade", "workspace"] as const)("full access authorization: %s", async (scenario) => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    act(() => result.current.selectPermissionLabel("Work Freely"));
    let finish!: (value: ApprovalResolutionResponse) => void;
    if (scenario === "failure") mocks.resolveApproval.mockRejectedValueOnce(new Error("Audit unavailable"));
    if (scenario === "downgrade" || scenario === "workspace") mocks.resolveApproval.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const approval = buildToolApproval("Codex", "local-app-select", '{"windowId":"opaque-choice"}');
    gate.register(approval);
    const outcome = gate.waitForDecision(approval).catch(() => "cancelled");
    await act(async () => result.current.recordBackendToolCall({ callId: approval.id, tool: "local-app-select", arguments: "{}", approval }));
    expect(result.current.openApprovals).toEqual([]);
    expect(mocks.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({ request: approval, decision: "once" }));
    if (scenario === "downgrade") {
      act(() => result.current.selectPermissionLabel("Ask Me"));
      await act(async () => finish(resolveApprovalFallback(mocks.resolveApproval.mock.calls[0][0])));
    }
    if (scenario === "workspace") {
      mocks.status = { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
      await act(async () => { await result.current.reconcileAccountWorkspace(); });
      await act(async () => finish(resolveApprovalFallback(mocks.resolveApproval.mock.calls[0][0])));
    }
    await expect(outcome).resolves.toBe(scenario === "success" ? "granted" : scenario === "workspace" ? "cancelled" : "denied");
  });

  it("keeps a pending approval and its waiter through a same-owner workspace refresh", async () => {
    const gate = createApprovalGate();
    const reset = vi.fn();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate, onScopeReset: reset }), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    const initialLoads = mocks.loadSnapshot.mock.calls.length;
    reset.mockClear();
    const approval = buildToolApproval("Codex", "local-app-select", '{"windowId":"opaque-choice"}');
    gate.register(approval);
    const decision = gate.waitForDecision(approval).catch((error: Error) => error.message);
    act(() => result.current.recordBackendToolCall({ callId: "call-a", tool: "local-app-select", arguments: "{}", approval }));
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    expect(result.current.openApprovals.map((item) => item.id)).toEqual([approval.id]);
    expect(gate.hasPending(approval.id)).toBe(true);
    expect(mocks.loadSnapshot).toHaveBeenCalledTimes(initialLoads);
    expect(reset).not.toHaveBeenCalled();
    gate.resolveGrant(approval.id);
    await expect(decision).resolves.toBe("granted");
  });

  it("rejects a pending waiter and interrupts the provider before resetting to a new owner", async () => {
    const gate = createApprovalGate();
    const reset = vi.fn();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate, onScopeReset: reset }), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    const initialLoads = mocks.loadSnapshot.mock.calls.length;
    const approval = buildToolApproval("Codex", "local-app-select", '{"windowId":"opaque-choice"}');
    gate.register(approval);
    const outcome = gate.waitForDecision(approval).catch((error: Error) => error.message);
    act(() => result.current.recordBackendToolCall({ callId: "call-a", tool: "local-app-select", arguments: "{}", approval }));
    reset.mockClear();
    mocks.status = { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    expect(await outcome).toContain("cancelled");
    expect(reset).toHaveBeenCalled();
    expect(result.current.openApprovals).toEqual([]);
    expect(gate.pendingCount()).toBe(0);
    expect(mocks.loadSnapshot).toHaveBeenCalledTimes(initialLoads + 1);
  });

  it("does not restore a legacy global draft after a failed read and retries the same identity", async () => {
    mocks.loadSnapshot.mockRejectedValueOnce(new Error("Saved workspace temporarily unavailable."));
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.runtimeSnapshotError).toContain("temporarily unavailable"));
    act(() => result.current.setVoiceEnabled(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    mocks.loadSnapshot.mockResolvedValue({ ...shellStateToRuntimeSnapshot(defaultShellState), composerDraft: "recovered draft" });
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await waitFor(() => expect(result.current.voiceEnabled).toBe(true));
    expect(result.current.runtimeSnapshotError).toBeNull();
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalled());
    expect(mocks.saveSnapshot.mock.calls[0]).toMatchObject([{ composerDraft: "" }, "local-default"]);
  });

  it("ignores a manual approval response after its account owner changes", async () => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }), { wrapper });
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    act(() => result.current.selectPermissionLabel("Ask Me"));
    let finish!: (value: ApprovalResolutionResponse) => void;
    mocks.resolveApproval.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const approval = buildToolApproval("Codex", "connector-action", "{}");
    gate.register(approval);
    const outcome = gate.waitForDecision(approval).catch(() => "cancelled");
    act(() => result.current.recordBackendToolCall({ callId: approval.id, tool: "connector-action", arguments: "{}", approval }));
    act(() => result.current.requestApprovalDecision(approval, "once"));
    mocks.status = { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await act(async () => finish(resolveApprovalFallback(mocks.resolveApproval.mock.calls[0][0])));
    await expect(outcome).resolves.toBe("cancelled");
    expect(result.current.approvalAudit).toEqual([]);
    expect(result.current.openApprovals).toEqual([]);
    expect(result.current.sessionApprovalGrants).toEqual([]);
  });

  it("ignores late snapshot hydration from a previous owner", async () => {
    let finish!: (value: RuntimeSnapshot) => void;
    mocks.loadSnapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(mocks.loadSnapshot).toHaveBeenCalledTimes(1));
    mocks.status = { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    await act(async () => finish({ ...shellStateToRuntimeSnapshot(defaultShellState), activeItem: "old-owner-private-item" }));
    expect(result.current.activeItem).toBe(defaultShellState.activeItem);
    expect(result.current.runtimeSnapshotError).toBeNull();
  });

  it("flushes the final pending settings to their workspace on unmount", async () => {
    const { result, unmount } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    mocks.saveSnapshot.mockClear();
    act(() => result.current.setVoiceEnabled(false));
    unmount();
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({ voiceEnabled: false }), "local-default"));
  });

  it.each(["workspace", "owner"] as const)("drops an old pending snapshot before switching %s", async (change) => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    mocks.saveSnapshot.mockClear();
    act(() => result.current.updateAgent(result.current.agents[0].id, { instructions: "old private instructions" }));
    mocks.status = change === "workspace"
      ? { ...mocks.status!, activeWorkspace: { ...mocks.status!.activeWorkspace, localWorkspaceId: "workspace-b" } }
      : { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mocks.saveSnapshot.mock.calls.some(([snapshot]) => (snapshot.agents ?? []).some((agent) => agent.instructions === "old private instructions"))).toBe(false);
    expect(mocks.saveSnapshot).toHaveBeenCalled();
    expect(mocks.saveSnapshot.mock.calls.every(([, workspaceId]) => workspaceId === mocks.status!.activeWorkspace.localWorkspaceId)).toBe(true);
  });
});
