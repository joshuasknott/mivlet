import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConnectorOperation } from "./useConnectorOperation";

describe("connector setup operations", () => {
  it("starts only one action before React renders its busy state", async () => {
    const { result } = renderHook(() => useConnectorOperation());
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.run(task);
      void result.current.run(task);
    });
    expect(task).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    await act(async () => { finish(); await pending; });
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.run(() => { throw new Error("Access expired"); }); });
    expect(result.current.failed).toBe(true);
    expect(result.current.notice).toContain("Access expired");
  });

  it("invalidates a closing detail while still refreshing partially changed connections", async () => {
    const settled = vi.fn();
    const publish = vi.fn();
    const { result, unmount } = renderHook(() => useConnectorOperation(false, settled));
    let finish!: () => void;
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.run(async isCurrent => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (isCurrent()) publish();
        throw new Error("Connection changed before discovery failed");
      });
    });
    unmount();
    await act(async () => { finish(); await pending; });
    expect(publish).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
