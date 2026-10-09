import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";
import { useMcpAppApprovals } from "./useMcpAppApprovals";

const preview: McpAppApprovalPreview = {
  owner: { workspaceId: "workspace", conversationId: "room", resultId: "result", generation: 1 },
  toolName: "get-time", arguments: {},
  source: "mcp-app",
  request: { id: "app-approval", service: "MCP", action: "get-time", mode: "read-only", riskLevel: "low", dataUsed: [], consequence: "Read a timestamp", requestedAt: "2026-10-08T10:00:00Z", decisions: ["once", "deny"] },
};
describe("conversation MCP App approval ownership", () => {
  it("exposes a completed response's approval and revokes it when work starts", async () => {
    let finish!: (result: ApprovalResolutionRequest | null) => void;
    const requestMcpAppApproval = vi.fn(() => new Promise<ApprovalResolutionRequest | null>((resolve) => { finish = resolve; }));
    const clearBackendToolApprovals = vi.fn(() => finish(null));
    const runtime = { requestMcpAppApproval, clearBackendToolApprovals } as unknown as ShellRuntime;
    const hook = renderHook(({ enabled }) => useMcpAppApprovals(runtime, "workspace:room:1", enabled), { initialProps: { enabled: true } });
    let pending!: ReturnType<typeof hook.result.current.request>;
    act(() => { pending = hook.result.current.request(preview); });
    expect(hook.result.current.ids.has("app-approval")).toBe(true);
    expect(hook.result.current.owners.get("app-approval")).toEqual(preview.owner);
    expect(requestMcpAppApproval).toHaveBeenCalledOnce();
    await act(async () => { hook.rerender({ enabled: false }); });
    expect(clearBackendToolApprovals).toHaveBeenCalledWith(["app-approval"]);
    expect(await pending).toBeNull();
    expect(hook.result.current.ids.size).toBe(0);
    expect(hook.result.current.owners.size).toBe(0);
    expect(await hook.result.current.request(preview)).toBeNull();
    expect(requestMcpAppApproval).toHaveBeenCalledOnce();
  });
  it("revokes its own pending approval on pane teardown", async () => {
    let finish!: (result: ApprovalResolutionRequest | null) => void;
    const clearBackendToolApprovals = vi.fn(() => finish(null));
    const runtime = { requestMcpAppApproval: () => new Promise<ApprovalResolutionRequest | null>((resolve) => { finish = resolve; }), clearBackendToolApprovals } as unknown as ShellRuntime;
    const hook = renderHook(() => useMcpAppApprovals(runtime, "workspace:room:1", true));
    let pending!: ReturnType<typeof hook.result.current.request>;
    act(() => { pending = hook.result.current.request(preview); });
    await act(async () => hook.unmount());
    expect(clearBackendToolApprovals).toHaveBeenCalledWith(["app-approval"]);
    expect(await pending).toBeNull();
  });

  it("rejects an approval whose conversation or generation is no longer active", async () => {
    const requestMcpAppApproval = vi.fn();
    const runtime = {
      requestMcpAppApproval,
      clearBackendToolApprovals: vi.fn(),
    } as unknown as ShellRuntime;
    const hook = renderHook(() =>
      useMcpAppApprovals(runtime, "workspace:other-room:2", true),
    );
    expect(await hook.result.current.request(preview)).toBeNull();
    expect(requestMcpAppApproval).not.toHaveBeenCalled();
  });

  it("rejects an otherwise matching room from a different workspace", async () => {
    const requestMcpAppApproval = vi.fn();
    const runtime = {
      requestMcpAppApproval,
      clearBackendToolApprovals: vi.fn(),
    } as unknown as ShellRuntime;
    const hook = renderHook(() =>
      useMcpAppApprovals(runtime, "workspace-new:room:1", true),
    );
    expect(await hook.result.current.request(preview)).toBeNull();
    expect(requestMcpAppApproval).not.toHaveBeenCalled();
  });

  it("cancels only the app session whose result was closed", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = { ...preview, request: { ...preview.request, id: "app-approval-1" }, abortSignal: firstController.signal };
    const second = { ...preview, request: { ...preview.request, id: "app-approval-2" }, abortSignal: secondController.signal };
    const resolvers = new Map<string, (value: ApprovalResolutionRequest | null) => void>();
    const requestMcpAppApproval = vi.fn((value: { request: { id: string } }) =>
      new Promise<ApprovalResolutionRequest | null>((resolve) => {
        resolvers.set(value.request.id, resolve);
      }),
    );
    const clearBackendToolApprovals = vi.fn((ids: readonly string[]) => {
      for (const id of ids) resolvers.get(id)?.(null);
    });
    const runtime = { requestMcpAppApproval, clearBackendToolApprovals } as unknown as ShellRuntime;
    const hook = renderHook(() => useMcpAppApprovals(runtime, "workspace:room:1", true));
    let firstPending!: ReturnType<typeof hook.result.current.request>;
    let secondPending!: ReturnType<typeof hook.result.current.request>;
    act(() => {
      firstPending = hook.result.current.request(first);
      secondPending = hook.result.current.request(second);
    });
    await vi.waitFor(() => expect(hook.result.current.ids).toEqual(new Set(["app-approval-1", "app-approval-2"])));
    expect(requestMcpAppApproval.mock.calls[0]?.[0]).not.toHaveProperty("abortSignal");
    expect(requestMcpAppApproval.mock.calls[1]?.[0]).not.toHaveProperty("abortSignal");

    await act(async () => {
      firstController.abort();
      await expect(firstPending).resolves.toBeNull();
    });
    expect(clearBackendToolApprovals).toHaveBeenCalledWith(["app-approval-1"]);
    expect(clearBackendToolApprovals).not.toHaveBeenCalledWith(["app-approval-2"]);
    expect(hook.result.current.ids).toEqual(new Set(["app-approval-2"]));

    const resolution = { request: {}, decision: "once", decidedAt: "now" } as ApprovalResolutionRequest;
    await act(async () => {
      resolvers.get("app-approval-2")?.(resolution);
      await expect(secondPending).resolves.toEqual(resolution);
    });
    expect(hook.result.current.ids.size).toBe(0);
  });

  it("uses the latest runtime boundary when an approval outlives a rerender", async () => {
    const firstClear = vi.fn();
    const latestClear = vi.fn();
    let resolveRequest!: (value: ApprovalResolutionRequest | null) => void;
    const firstRuntime = {
      requestMcpAppApproval: vi.fn(
        () => new Promise<ApprovalResolutionRequest | null>((resolve) => {
          resolveRequest = resolve;
        }),
      ),
      clearBackendToolApprovals: firstClear,
    } as unknown as ShellRuntime;
    const latestRuntime = {
      requestMcpAppApproval: vi.fn(),
      clearBackendToolApprovals: latestClear,
    } as unknown as ShellRuntime;
    const hook = renderHook(
      ({ runtime }) => useMcpAppApprovals(runtime, "workspace:room:1", true),
      { initialProps: { runtime: firstRuntime } },
    );

    let pending!: ReturnType<typeof hook.result.current.request>;
    act(() => {
      pending = hook.result.current.request(preview);
    });
    hook.rerender({ runtime: latestRuntime });
    hook.unmount();

    expect(latestClear).toHaveBeenCalledWith(["app-approval"]);
    expect(firstClear).not.toHaveBeenCalled();
    resolveRequest(null);
    await expect(pending).resolves.toBeNull();
  });
});
