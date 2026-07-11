import { describe, expect, it } from "vitest";
import { encodeMcpFrame, parseMcpLine } from "./protocol";

describe("MCP stdio framing", () => {
  it("accepts one valid JSON-RPC message per line", () => {
    const frame = { jsonrpc: "2.0" as const, id: "1", method: "tools/list", params: {} };
    const encoded = encodeMcpFrame(frame);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(parseMcpLine(encoded)).toEqual(frame);
  });

  it("rejects stdout logs and invalid response envelopes", () => {
    expect(parseMcpLine("server started")).toBeNull();
    expect(parseMcpLine('{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"both"}}')).toBeNull();
    expect(parseMcpLine('{"jsonrpc":"2.0","id":null,"result":{}}')).toBeNull();
  });
});

