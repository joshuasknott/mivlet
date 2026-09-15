import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpFrame, McpTransport } from "@mivlet/connectors";

const native = vi.hoisted(() => ({
  start: vi.fn(async () => undefined), send: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  listen: vi.fn(), unlisten: vi.fn(), receive: undefined as ((frame: unknown) => void) | undefined,
}));
vi.mock("../runtime/domains/embedded-agent", () => ({
startRuntimeEmbeddedMcp: native.start,
sendRuntimeEmbeddedMcp: native.send,
closeRuntimeEmbeddedMcp: native.close,
listenRuntimeEmbeddedMcp: native.listen
}));
import { McpClient } from "./native-mcp-client";

function fixture() {
  native.listen.mockImplementation(async (_id: string, receive: (frame: unknown) => void) => { native.receive = receive; return native.unlisten; });
  let receive: ((frame: McpFrame) => void) | undefined;
  const transport: McpTransport = {
    send: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    subscribe: handler => { receive = handler; return () => { receive = undefined; }; }, subscribeClose: () => () => undefined,
  };
  return { transport, client: new McpClient(transport), server: (frame: McpFrame) => receive?.(frame) };
}
afterEach(() => { vi.clearAllMocks(); native.receive = undefined; });

describe("native MCP discovery bridge", () => {
  it("bridges only discovery frames and correlates concurrent result delivery", async () => {
    const { client, transport, server } = fixture();
    const initialized = client.initialize();
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith(expect.any(String), { type: "request", id: 1, method: "initialize" }));
    const wire = { jsonrpc: "2.0" as const, id: 0, method: "initialize" };
    native.receive!({ type: "send", id: 8, frame: wire });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(wire));
    expect(native.send).toHaveBeenCalledWith(expect.any(String), { type: "sent", id: 8, ok: true });
    server({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-11-25" } });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: "frame" })));
    native.receive!({ type: "result", id: 1, ok: true, value: { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } } });
    await initialized;
    const tools = client.listTools(), resources = client.listResources();
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledWith(expect.any(String), { type: "request", id: 3, method: "listResources" }));
    native.receive!({ type: "result", id: 3, ok: true, value: [{ uri: "fixture://one", name: "one" }] });
    native.receive!({ type: "result", id: 2, ok: true, value: [{ name: "read", inputSchema: { type: "object" } }] });
    expect(await tools).toEqual([{ name: "read", inputSchema: { type: "object" } }]);
    expect(await resources).toEqual([{ uri: "fixture://one", name: "one" }]);
    await client.close();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("refuses a tool execution frame and closes the pending discovery request", async () => {
    const { client, transport } = fixture();
    const result = client.initialize();
    const rejected = expect(result).rejects.toThrow("closed");
    await vi.waitFor(() => expect(native.send).toHaveBeenCalled());
    native.receive!({ type: "send", id: 7, frame: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write" } } });
    await rejected;
    expect(transport.send).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalled();
  });

  it("closes during listener startup without launching or accepting later replies", async () => {
    const { client, transport } = fixture();
    let finish!: (unlisten: () => void) => void;
    native.listen.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const result = client.initialize();
    const rejected = expect(result).rejects.toThrow("closed");
    await client.close();
    finish(native.unlisten);
    await rejected;
    expect(native.start).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
