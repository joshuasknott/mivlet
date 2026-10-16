import { describe, expect, it, vi } from "vitest";
import { McpAppTransport } from "./mcp-app-transport";

describe("MCP App isolated transport", () => {
  it("accepts only the bound source, bounds messages and removes its listener on close", async () => {
    const guest = { postMessage: vi.fn() } as unknown as Window;
    const other = {} as Window;
    const host = new EventTarget() as unknown as Window;
    const transport = new McpAppTransport(guest, host);
    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;
    const debug = vi.spyOn(console, "debug");
    await transport.start();
    const data = { jsonrpc: "2.0", id: 1, method: "ping" };
    const dispatch = (value: unknown, source: Window, origin = "null") => host.dispatchEvent(new MessageEvent("message", { data: value, source, origin }));
    dispatch(data, other);
    expect(onmessage).not.toHaveBeenCalled();
    dispatch(data, guest, "https://attacker.example");
    expect(onmessage).not.toHaveBeenCalled();
    dispatch(data, guest);
    expect(onmessage).toHaveBeenCalledOnce();
    dispatch({ ...data, id: 2, method: "fresh" }, guest);
    expect(onmessage).toHaveBeenCalledTimes(2);
    dispatch(data, guest);
    expect(onmessage).toHaveBeenCalledTimes(2);
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The MCP App reused a JSON-RPC request ID." }),
    );
    dispatch({ ...data, params: { text: "x".repeat(300_000) } }, guest);
    expect(onmessage).toHaveBeenCalledTimes(2);
    expect(debug).not.toHaveBeenCalled();
    await transport.close();
    dispatch(data, guest);
    expect(onmessage).toHaveBeenCalledTimes(2);
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow("closed");
    debug.mockRestore();
  });
  it("closes when a live session exceeds the bounded request-id window", async () => {
    const guest = { postMessage: vi.fn() } as unknown as Window;
    const host = new EventTarget() as unknown as Window;
    const transport = new McpAppTransport(guest, host);
    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;
    await transport.start();
    const dispatch = (id: number) => host.dispatchEvent(new MessageEvent("message", {
      data: { jsonrpc: "2.0", id, method: "ping" },
      source: guest,
      origin: "null",
    }));
    for (let id = 0; id < 1_024; id += 1) dispatch(id);
    expect(onmessage).toHaveBeenCalledTimes(1_024);
    dispatch(1_024);
    expect(onmessage).toHaveBeenCalledTimes(1_024);
    expect(onerror).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The MCP App exceeded the live request limit; reopen the result." }),
    );
    await expect(transport.send({ jsonrpc: "2.0", id: 1_025, method: "ping" })).rejects.toThrow("closed");
    await transport.start();
    dispatch(0);
    expect(onmessage).toHaveBeenCalledTimes(1_025);
    await transport.close();
  });
  it("rejects deep or cyclic untrusted structures without logging their contents", async () => {
    const guest = { postMessage: vi.fn() } as unknown as Window;
    const transport = new McpAppTransport(guest, new EventTarget() as unknown as Window);
    await transport.start();
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) nested = { nested };
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: nested })).rejects.toThrow("limit");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping", params: cycle })).rejects.toThrow("limit");
    expect(guest.postMessage).not.toHaveBeenCalled();
    await transport.close();
  });

  it("reports malformed SDK messages without exposing their payload", async () => {
    const guest = { postMessage: vi.fn() } as unknown as Window;
    const host = new EventTarget() as unknown as Window;
    const transport = new McpAppTransport(guest, host);
    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;
    await transport.start();
    host.dispatchEvent(new MessageEvent("message", {
      data: { jsonrpc: "1.0", id: 3, method: "ping", secret: "private" },
      source: guest,
      origin: "null",
    }));
    expect(onmessage).not.toHaveBeenCalled();
    expect(onerror).toHaveBeenCalledOnce();
    expect(onerror.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ message: "The MCP App sent an invalid protocol message." }));
    expect(String(onerror.mock.calls[0]?.[0])).not.toContain("private");
    await transport.close();
  });
});
