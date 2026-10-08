import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { onMcpWorkChanged } from "../runtime/domains/mcp-server";
import { useMcpWorkEvents } from "./useMcpWorkEvents";

vi.mock("../runtime/adapters/select", () => ({
  hasNativeRuntimeAdapter: vi.fn(),
}));
vi.mock("../runtime/domains/mcp-server", () => ({ onMcpWorkChanged: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasNativeRuntimeAdapter).mockReturnValue(true);
});

describe("native MCP Work notifications", () => {
  it("refreshes after subscription and native changes, then releases the listener", async () => {
    const release = vi.fn();
    vi.mocked(onMcpWorkChanged).mockResolvedValue(release);
    const owner = {
      refresh: vi.fn().mockResolvedValue(undefined),
      report: vi.fn(),
    };
    const view = renderHook(() => useMcpWorkEvents(owner));
    await waitFor(() => expect(owner.refresh).toHaveBeenCalledTimes(1));
    act(() => vi.mocked(onMcpWorkChanged).mock.calls[0][0]());
    await waitFor(() => expect(owner.refresh).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
    act(() => vi.mocked(onMcpWorkChanged).mock.calls[0][0]());
    expect(owner.refresh).toHaveBeenCalledTimes(2);
  });

  it("releases a late subscription without refreshing a closed workspace", async () => {
    let resolve!: (release: () => void) => void;
    vi.mocked(onMcpWorkChanged).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const owner = {
      refresh: vi.fn().mockResolvedValue(undefined),
      report: vi.fn(),
    };
    const view = renderHook(() => useMcpWorkEvents(owner));
    view.unmount();
    const release = vi.fn();
    await act(async () => resolve(release));
    expect(release).toHaveBeenCalledOnce();
    expect(owner.refresh).not.toHaveBeenCalled();
  });

  it("does not subscribe in browser preview", () => {
    vi.mocked(hasNativeRuntimeAdapter).mockReturnValue(false);
    const owner = {
      refresh: vi.fn().mockResolvedValue(undefined),
      report: vi.fn(),
    };
    renderHook(() => useMcpWorkEvents(owner));
    expect(onMcpWorkChanged).not.toHaveBeenCalled();
    expect(owner.refresh).not.toHaveBeenCalled();
  });
});
