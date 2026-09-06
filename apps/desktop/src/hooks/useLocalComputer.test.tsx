import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalComputer } from "./useLocalComputer";
import type { LocalBrowserSnapshot, LocalComputerSnapshot } from "@fable/protocol";

const mocks = vi.hoisted(() => ({
  previewFile: vi.fn(), load: vi.fn(), snapshot: vi.fn(), control: vi.fn(), navigate: vi.fn(), provision: vi.fn(), point: vi.fn(), files: vi.fn(), lifecycle: vi.fn(),
}));
vi.mock("../lib/computer-lifecycle", () => ({ changeComputerLifecycle: mocks.lifecycle }));

vi.mock("../runtime", () => ({
  historyRuntimeLocalBrowser: vi.fn().mockResolvedValue(null),
  keyRuntimeLocalBrowser: vi.fn(),
  launchRuntimeLocalComputerApplication: vi.fn().mockResolvedValue(null),
  listRuntimeLocalComputerFiles: mocks.files,
  loadRuntimeLocalComputer: mocks.load,
  navigateRuntimeLocalBrowser: mocks.navigate,
  pointRuntimeLocalBrowser: mocks.point,
  previewRuntimeLocalComputerFile: mocks.previewFile,
  provisionRuntimeLocalComputer: mocks.provision,
  setRuntimeLocalComputerController: mocks.control,
  snapshotRuntimeLocalBrowser: mocks.snapshot,
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const node = (overrides: Partial<LocalComputerSnapshot> = {}): LocalComputerSnapshot => ({
  computerId: "computer-a", workspaceId: "workspace-a", agentId: "agent-a", locality: "local", backend: "docker", isolation: "linux-container",
  lifecycle: "ready", browserAvailable: true, browserActive: true, controller: "agent", generation: 1, capabilities: ["persistent-files"],
  updatedAt: "2026-09-06T00:00:00Z", ...overrides,
});
const frame = (overrides: Partial<LocalBrowserSnapshot> = {}): LocalBrowserSnapshot => ({
  computerId: "computer-a", currentUrl: "https://example.test", title: "Example", previewDataUrl: "data:image/png;base64,agent-frame",
  viewport: { width: 800, height: 600 }, canGoBack: false, canGoForward: false, controller: "agent", generation: 1,
  updatedAt: "2026-09-06T00:00:00Z", ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const hook = () => renderHook(() => useLocalComputer({ workspaceId: "workspace-a", agentId: "agent-a" }), { wrapper: wrapper() });

describe("useLocalComputer", () => {
  it("stops with current authority, clears the old frame and remains paused", async () => {
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockResolvedValue(frame());
    mocks.lifecycle.mockImplementation(async () => {
      const stopped = node({ lifecycle: "stopped", browserActive: false, controller: "paused", generation: 2 });
      mocks.load.mockResolvedValue(stopped);
      return stopped;
    });
    const result = hook();
    await waitFor(() => expect(result.result.current.snapshot).not.toBeNull());
    await act(async () => { await result.result.current.stop(); });
    expect(mocks.lifecycle).toHaveBeenCalledWith({ workspaceId: "workspace-a", agentId: "agent-a", expectedGeneration: 1, action: "stop" });
    await waitFor(() => expect(result.result.current.node?.lifecycle).toBe("stopped"));
    expect(result.result.current.controller).toBe("paused");
    expect(result.result.current.snapshot).toBeNull();
    expect(mocks.control).not.toHaveBeenCalled();
  });
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(null);
    mocks.snapshot.mockResolvedValue(null);
    mocks.files.mockResolvedValue(null);
  });

  it("rejects a frame requested before takeover after newer human authority has arrived", async () => {
    const old = deferred<LocalBrowserSnapshot>();
    const expiry = new Date(Date.now() + 300_000).toISOString();
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockReturnValueOnce(old.promise);
    mocks.control.mockImplementation(async () => {
      mocks.load.mockResolvedValue(node({ generation: 2, controller: "human", leaseExpiresAt: expiry }));
      return frame({ generation: 2, controller: "human", leaseExpiresAt: expiry, previewDataUrl: "human-only" });
    });
    const { result } = hook();
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    await act(async () => { await result.current.takeControl(); });
    await waitFor(() => expect(result.current.controller).toBe("human"));
    await act(async () => old.resolve(frame()));
    expect(result.current.controller).toBe("human");
    expect(result.current.node?.generation).toBe(2);
    expect(result.current.snapshot?.previewDataUrl ?? "").toBe("");
    expect(mocks.control).toHaveBeenCalledWith({ workspaceId: "workspace-a", agentId: "agent-a", controller: "human", expectedGeneration: 1 });
  });

  it("does not project a completed action into another agent or restore it on return", async () => {
    const old = deferred<LocalBrowserSnapshot>();
    mocks.load.mockImplementation(async ({ agentId }) => node({ agentId, computerId: `computer-${agentId}` }));
    mocks.snapshot.mockImplementation(async ({ agentId }) => frame({ computerId: `computer-${agentId}` }));
    mocks.navigate.mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ agentId }) => useLocalComputer({ workspaceId: "workspace-a", agentId }), {
      initialProps: { agentId: "agent-a" }, wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.navigate("https://example.test/new"); });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    rerender({ agentId: "agent-b" });
    await waitFor(() => expect(result.current.snapshot?.computerId).toBe("computer-agent-b"));
    await act(async () => { old.resolve(frame({ computerId: "computer-agent-a", title: "Old secret", generation: 2 })); await pending; });
    expect(result.current.snapshot?.computerId).toBe("computer-agent-b");
    expect(result.current.browserBusy).toBe(false);
    rerender({ agentId: "agent-a" });
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.snapshot?.title).toBe("Example"));
  });

  it("fences an outstanding frame while reconnecting to a newer computer generation", async () => {
    const old = deferred<LocalBrowserSnapshot>();
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockReturnValueOnce(old.promise).mockResolvedValue(frame({ generation: 3, title: "Restarted" }));
    const { result } = hook();
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledOnce());
    mocks.load.mockResolvedValue(node({ generation: 3 }));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.snapshot?.title).toBe("Restarted"));
    await act(async () => old.resolve(frame({ title: "Old desktop" })));
    expect(result.current.snapshot?.generation).toBe(3);
    expect(result.current.snapshot?.title).toBe("Restarted");
  });

  it("clears uncertain frames after a failed action and requires a fresh observation", async () => {
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockResolvedValue(frame());
    mocks.navigate.mockRejectedValue(new Error("Computer disconnected"));
    const { result } = hook();
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => { await expect(result.current.navigate("https://example.test/new")).rejects.toThrow("Computer disconnected"); });
    await waitFor(() => expect(result.current.recoveryNeeded).toBe(true));
    expect(result.current.snapshot).toBeNull();
    mocks.load.mockResolvedValue(node({ generation: 2 }));
    mocks.snapshot.mockResolvedValue(frame({ generation: 2, title: "Reconnected" }));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.recoveryNeeded).toBe(false));
    expect(result.current.snapshot?.title).toBe("Reconnected");
  });

  it("keeps expired human control paused until an explicit resume", async () => {
    mocks.load.mockResolvedValue(node({ controller: "human", leaseExpiresAt: new Date(Date.now() - 1).toISOString() }));
    const { result } = hook();
    await waitFor(() => expect(result.current.node).not.toBeNull());
    expect(result.current.controller).toBe("paused");
    expect(result.current.paused).toBe(true);
    expect(result.current.snapshot).toBeNull();
    expect(mocks.control).not.toHaveBeenCalled();
    mocks.load.mockResolvedValue(node({ generation: 2, controller: "paused" }));
    mocks.snapshot.mockResolvedValue(frame({ generation: 2, controller: "paused" }));
    mocks.control.mockImplementation(async () => {
      mocks.load.mockResolvedValue(node({ generation: 3 }));
      return frame({ generation: 3 });
    });
    await act(async () => { await result.current.resume(); });
    await waitFor(() => expect(result.current.controller).toBe("agent"));
    expect(mocks.control).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", agentId: "agent-a", controller: "agent", expectedGeneration: 2 });
  });

  it("only captures demanded thumbnails and never returns control when the viewer closes", async () => {
    const expiry = new Date(Date.now() + 300_000).toISOString();
    mocks.load.mockResolvedValue(node({ controller: "human", leaseExpiresAt: expiry }));
    mocks.snapshot.mockResolvedValue(frame({ controller: "human", leaseExpiresAt: expiry, previewDataUrl: "human-only" }));
    const { result, rerender } = renderHook(({ viewing }) => useLocalComputer({ workspaceId: "workspace-a", agentId: "agent-a", viewing, thumbnailEnabled: false }), {
      initialProps: { viewing: false }, wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.node).not.toBeNull());
    expect(mocks.snapshot).not.toHaveBeenCalled();
    rerender({ viewing: true });
    await waitFor(() => expect(result.current.snapshot?.previewDataUrl).toBe("human-only"));
    rerender({ viewing: false });
    expect(result.current.snapshot?.previewDataUrl ?? "").toBe("");
    expect(result.current.controller).toBe("human");
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it("never restores a file preview closed while its native read was pending", async () => {
    const old = deferred<unknown>();
    mocks.previewFile.mockReturnValueOnce(old.promise);
    const { result } = hook();
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.previewFile("private.txt"); });
    await waitFor(() => expect(result.current.filePreviewLoading).toBe(true));
    act(() => result.current.closeFilePreview());
    await act(async () => { old.resolve({ content: "private", computerId: "computer-a" }); await pending; });
    expect(result.current.filePreview).toBeNull();
    expect(result.current.filePreviewLoading).toBe(false);
  });

  it("uses a slower thumbnail interval and stops capture when no surface needs it", async () => {
    vi.useFakeTimers();
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockResolvedValue(frame());
    const { rerender } = renderHook(({ thumbnailEnabled }) => useLocalComputer({ workspaceId: "workspace-a", agentId: "agent-a", thumbnailEnabled }), {
      initialProps: { thumbnailEnabled: true }, wrapper: wrapper(),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    rerender({ thumbnailEnabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it("marks a human lease paused at its deadline without sending an automatic return", async () => {
    vi.useFakeTimers();
    mocks.load.mockResolvedValue(node({ controller: "human", leaseExpiresAt: new Date(Date.now() + 5_000).toISOString() }));
    const { result } = hook();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current.controller).toBe("human");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.controller).toBe("paused");
    expect(result.current.node?.controller).toBe("paused");
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("fails reconnect clearly and drops the previously displayed frame", async () => {
    mocks.load.mockResolvedValue(node());
    mocks.snapshot.mockResolvedValue(frame());
    const { result } = hook();
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    mocks.load.mockRejectedValue(new Error("Docker is unavailable"));
    await act(async () => { await expect(result.current.refresh()).rejects.toThrow("Docker is unavailable"); });
    await waitFor(() => expect(result.current.error).toBe("Docker is unavailable"));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.node).toBeNull();
    expect(result.current.recoveryNeeded).toBe(true);
  });

  it("never projects a private file preview across agent scopes", async () => {
    let resolveFirst!: (value: {
      computerId: string;
      path: string;
      content: string;
      sizeBytes: number;
      truncated: boolean;
      updatedAt: string;
    }) => void;
    mocks.previewFile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useLocalComputer({ workspaceId: "workspace-a", agentId }),
      { initialProps: { agentId: "agent-a" }, wrapper: wrapper() }
    );

    let firstPreview!: Promise<unknown>;
    act(() => {
      firstPreview = result.current.previewFile("notes/a.md");
    });
    await waitFor(() => expect(result.current.filePreviewLoading).toBe(true));

    rerender({ agentId: "agent-b" });
    expect(result.current.filePreviewLoading).toBe(false);
    expect(result.current.filePreview).toBeNull();
    expect(result.current.filePreviewError).toBeNull();

    resolveFirst({
      computerId: "computer-a",
      path: "notes/a.md",
      content: "agent A only",
      sizeBytes: 12,
      truncated: false,
      updatedAt: "2026-08-28T00:00:00.000Z"
    });
    await act(async () => firstPreview);
    expect(result.current.filePreview).toBeNull();

    mocks.previewFile.mockResolvedValueOnce({
      computerId: "computer-b",
      path: "notes/b.md",
      content: "agent B only",
      sizeBytes: 12,
      truncated: false,
      updatedAt: "2026-08-28T00:00:01.000Z"
    });
    await act(async () => {
      await result.current.previewFile("notes/b.md");
    });
    await waitFor(() => expect(result.current.filePreview?.path).toBe("notes/b.md"));
    expect(mocks.previewFile).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      path: "notes/b.md"
    });
  });
});
