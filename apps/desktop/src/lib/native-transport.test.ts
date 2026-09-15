import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProvider, NativeCompletionRequest } from "@fable/protocol";
import { createDesktopTransport } from "./native-transport";

const native = vi.hoisted(() => ({ begin: vi.fn(), end: vi.fn(), listen: vi.fn(), stream: vi.fn(), cancel: vi.fn() }));
vi.mock("../runtime/domains/providers", () => ({
beginRuntimeComputerSession: native.begin,
endRuntimeComputerSession: native.end,
listenRuntimeBackendEvents: native.listen,
streamRuntimeCompletion: native.stream,
cancelRuntimeCompletion: native.cancel
}));
const provider = { id: "openai" } as BackendProvider;
const request = {
  providerId: "openai", model: "gpt-4.1", messages: [{ role: "user", content: "Inspect the fixture" }],
  tools: [{ name: "local-desktop-observe", description: "Observe", parameters: "{}" }], maxTokens: 100,
  computer: { workspaceId: "workspace", agentId: "agent" },
  providerRoute: { workspaceId: "workspace" },
} as NativeCompletionRequest;

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.begin.mockResolvedValue("api-vision-session");
  native.end.mockResolvedValue(undefined);
  native.cancel.mockResolvedValue(true);
});

describe("native screenshot transport lifecycle", () => {
  it("keeps native attestation outside provider payloads, reuses the session and clears old calls", async () => {
    let callback: (line: string) => void = () => {};
    const unlisten = vi.fn();
    native.listen.mockImplementation(async (_id, receive) => { callback = receive; return unlisten; });
    let turn = 0;
    native.stream.mockImplementation(async () => {
      if (++turn === 1) callback(JSON.stringify({ __fableComputerTool: { callId: "observe", approvalId: `api-visual-${"a".repeat(48)}` } }));
      callback('{"choices":[{"finish_reason":"stop"}]}');
      callback("[DONE]");
    });
    const handle = createDesktopTransport(provider, { onRequestStarted: vi.fn(), onRetry: vi.fn() })!;
    const first = [];
    for await (const line of handle.transport.stream(request)) first.push(line);
    expect(first).toEqual(['{"choices":[{"finish_reason":"stop"}]}']);
    expect(handle.transport.toolApprovalId?.("observe")).toBe(`api-visual-${"a".repeat(48)}`);
    for await (const _line of handle.transport.stream(request)) { /* drain continuation */ }
    expect(handle.transport.toolApprovalId?.("observe")).toBeUndefined();
    expect(native.begin).toHaveBeenCalledTimes(1);
    expect(native.stream.mock.calls.every(([value]) => value.computerSessionId === "api-vision-session")).toBe(true);
    expect(JSON.stringify(native.stream.mock.calls)).not.toMatch(/base64|data:image/);
    await handle.shutdown?.();
    await handle.shutdown?.();
    expect(native.end).toHaveBeenCalledExactlyOnceWith("api-vision-session");
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("retires a session that opens after Stop without starting HTTP", async () => {
    let opened: (id: string) => void = () => {};
    native.begin.mockReturnValue(new Promise<string>(resolve => { opened = resolve; }));
    const handle = createDesktopTransport(provider, { onRequestStarted: vi.fn(), onRetry: vi.fn() })!;
    const iterator = handle.transport.stream(request)[Symbol.asyncIterator]();
    const next = iterator.next();
    const stopped = handle.shutdown?.();
    opened("late-session");
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
    await stopped;
    expect(native.end).toHaveBeenCalledExactlyOnceWith("late-session");
    expect(native.stream).not.toHaveBeenCalled();
  });

  it("disposes a failed provider session and its event listener", async () => {
    const unlisten = vi.fn();
    native.listen.mockResolvedValue(unlisten);
    native.stream.mockRejectedValue(new Error("Provider unavailable"));
    const handle = createDesktopTransport(provider, { onRequestStarted: vi.fn(), onRetry: vi.fn() })!;
    const iterator = handle.transport.stream(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("Provider unavailable");
    await handle.shutdown?.();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(native.end).toHaveBeenCalledExactlyOnceWith("api-vision-session");
  });
});
