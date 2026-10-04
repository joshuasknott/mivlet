import { afterEach, describe, expect, it, vi } from "vitest";
import { runConnectedApp } from "./connected-app-cancellation";

afterEach(() => vi.useRealTimers());

describe("connected app task cancellation", () => {
  it("rejects revoked access at an await boundary without waiting for cleanup or a timer", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const connection = { client: { close: vi.fn(() => new Promise<void>(() => {})) } };
    const running = runConnectedApp({}, () => allowed, async () => connection, async (_connection, requireCurrent) => {
      allowed = false;
      requireCurrent();
      return "never returned";
    });
    await expect(running).rejects.toThrow("cancelled");
    expect(connection.client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a waiting task promptly and does not wait for external cleanup", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const connection = { client: { close: vi.fn(() => new Promise<void>(() => {})) } };
    const operation = vi.fn(() => new Promise<string>(() => {}));
    const running = runConnectedApp({ shouldCancel: () => cancelled }, () => true, async () => connection, operation);
    const result = expect(running).rejects.toThrow("External effects already accepted");
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledOnce();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(connection.client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a connection returned after Stop without starting an operation", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let finish!: (value: { client: { close(): Promise<void> } }) => void;
    const operation = vi.fn();
    const running = runConnectedApp({ shouldCancel: () => cancelled }, () => true, () => new Promise(resolve => { finish = resolve; }), operation);
    const result = expect(running).rejects.toThrow("cancelled");
    cancelled = true;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    const connection = { client: { close: vi.fn().mockResolvedValue(undefined) } };
    finish(connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).not.toHaveBeenCalled();
    expect(connection.client.close).toHaveBeenCalledOnce();
  });

  it("rejects a changed agent generation and discards a late successful result", async () => {
    vi.useFakeTimers();
    let current = { workspaceId: "workspace", agentId: "agent", generation: 1, ready: false, controller: "agent" as const };
    let finish!: (value: string) => void;
    const connection = { client: { close: vi.fn().mockResolvedValue(undefined) } };
    const running = runConnectedApp({ localComputerCurrent: () => current }, () => true, async () => connection, () => new Promise(resolve => { finish = resolve; }));
    const result = expect(running).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1);
    current = { ...current, generation: 2 };
    await vi.advanceTimersByTimeAsync(50);
    await result;
    finish("late success");
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.client.close).toHaveBeenCalledOnce();
  });
});
