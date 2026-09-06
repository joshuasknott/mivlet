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

const mocks = vi.hoisted(() => ({ status: null as AccountWorkspaceStatus | null,
  loadSnapshot: vi.fn<() => Promise<RuntimeSnapshot | null>>(async () => null),
  saveSnapshot: vi.fn(async (_snapshot: RuntimeSnapshot, _workspaceId?: string) => null),
}));
vi.mock("../runtime", async (original) => ({
  ...await original<typeof import("../runtime")>(),
  loadRuntimeAccountWorkspaceStatus: async () => mocks.status,
  reconcileRuntimeAccountWorkspace: async () => mocks.status,
  loadRuntimeSnapshot: mocks.loadSnapshot,
  saveRuntimeSnapshot: mocks.saveSnapshot,
}));
vi.mock("../lib/persistence", async (original) => ({
  ...await original<typeof import("../lib/persistence")>(),
  hasTauriRuntime: () => true,
}));

function wrapper({ children }: PropsWithChildren) { return <FableQueryProvider>{children}</FableQueryProvider>; }

describe("approval queue workspace hydration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearActiveRuntimeDataScope();
    mocks.loadSnapshot.mockReset().mockResolvedValue(null);
    mocks.saveSnapshot.mockClear();
    mocks.status = { ...PREVIEW_ACCOUNT_WORKSPACE_STATUS, activeWorkspace: { ...PREVIEW_ACCOUNT_WORKSPACE_STATUS.activeWorkspace, localWorkspaceId: "local-default" }, activeContextOwner: { internalUserId: "owner-a" } };
  });

  it("keeps a pending approval and its waiter through a same-owner workspace refresh", async () => {
    const gate = createApprovalGate();
    const reset = vi.fn();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate, onScopeReset: reset }), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    const initialLoads = mocks.loadSnapshot.mock.calls.length;
    reset.mockClear();
    const approval = buildToolApproval("Codex", "local-browser", '{"url":"https://example.test"}');
    gate.register(approval);
    const decision = gate.waitForDecision(approval).catch((error: Error) => error.message);
    act(() => result.current.recordBackendToolCall({ callId: "call-a", tool: "local-browser", arguments: "{}", approval }));
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
    const approval = buildToolApproval("Codex", "local-browser", '{"url":"https://example.test"}');
    gate.register(approval);
    const outcome = gate.waitForDecision(approval).catch((error: Error) => error.message);
    act(() => result.current.recordBackendToolCall({ callId: "call-a", tool: "local-browser", arguments: "{}", approval }));
    reset.mockClear();
    mocks.status = { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    expect(await outcome).toContain("cancelled");
    expect(reset).toHaveBeenCalled();
    expect(result.current.openApprovals).toEqual([]);
    expect(gate.pendingCount()).toBe(0);
    expect(mocks.loadSnapshot).toHaveBeenCalledTimes(initialLoads + 1);
  });

  it("does not overwrite a saved workspace after a failed read and retries the same identity", async () => {
    mocks.loadSnapshot.mockRejectedValueOnce(new Error("Saved workspace temporarily unavailable."));
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.runtimeSnapshotError).toContain("temporarily unavailable"));
    act(() => result.current.setComposerValue("must not overwrite saved data"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    mocks.loadSnapshot.mockResolvedValue({ ...shellStateToRuntimeSnapshot(defaultShellState), composerDraft: "recovered draft" });
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await waitFor(() => expect(result.current.composerValue).toBe("recovered draft"));
    expect(result.current.runtimeSnapshotError).toBeNull();
    await waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalled());
    expect(mocks.saveSnapshot.mock.calls[0]).toMatchObject([{ composerDraft: "recovered draft" }, "local-default"]);
  });

  it.each(["workspace", "owner"] as const)("drops an old pending snapshot before switching %s", async (change) => {
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-default"));
    await act(async () => {});
    mocks.saveSnapshot.mockClear();
    act(() => result.current.setComposerValue("old private draft"));
    mocks.status = change === "workspace"
      ? { ...mocks.status!, activeWorkspace: { ...mocks.status!.activeWorkspace, localWorkspaceId: "workspace-b" } }
      : { ...mocks.status!, activeContextOwner: { internalUserId: "owner-b" } };
    await act(async () => { await result.current.reconcileAccountWorkspace(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(mocks.saveSnapshot.mock.calls.some(([snapshot]) => snapshot.composerDraft === "old private draft")).toBe(false);
    expect(mocks.saveSnapshot).toHaveBeenCalled();
    expect(mocks.saveSnapshot.mock.calls.every(([, workspaceId]) => workspaceId === mocks.status!.activeWorkspace.localWorkspaceId)).toBe(true);
  });
});
