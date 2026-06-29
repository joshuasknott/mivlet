import { describe, expect, it } from "vitest";
import {
  parseAcpLine,
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  encodeAcpFrame,
  MAX_ACP_FRAME_CHARACTERS
} from "./protocol";

describe("parseAcpLine framing", () => {
  it("parses a JSON-RPC request frame", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "initialize",
      params: { client: "fable" }
    });
    const frame = parseAcpLine(line);
    expect(frame).not.toBeNull();
    expect(isAcpRequest(frame)).toBe(true);
    expect(isAcpResponse(frame)).toBe(false);
    if (frame && isAcpRequest(frame)) {
      expect(frame.id).toBe("req-1");
      expect(frame.method).toBe("initialize");
    }
  });

  it("parses a JSON-RPC response frame with a result", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      result: { protocolVersion: "1.0", capabilities: { streaming: true } }
    });
    const frame = parseAcpLine(line);
    expect(frame).not.toBeNull();
    expect(isAcpResponse(frame)).toBe(true);
    if (frame && isAcpResponse(frame)) {
      expect(frame.id).toBe("req-1");
      expect(
        (frame.result as { protocolVersion?: string })?.protocolVersion
      ).toBe("1.0");
      expect(frame.error).toBeUndefined();
    }
  });

  it("parses a JSON-RPC response frame with an error", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-2",
      error: { code: -32000, message: "not signed in" }
    });
    const frame = parseAcpLine(line);
    expect(frame).not.toBeNull();
    expect(isAcpResponse(frame)).toBe(true);
    if (frame && isAcpResponse(frame)) {
      expect(frame.error?.code).toBe(-32000);
      expect(frame.error?.message).toBe("not signed in");
    }
  });

  it("parses a JSON-RPC notification frame (no id)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/message",
      params: { role: "assistant", content: "hi" }
    });
    const frame = parseAcpLine(line);
    expect(frame).not.toBeNull();
    expect(isAcpNotification(frame)).toBe(true);
    expect(isAcpRequest(frame)).toBe(false);
    if (frame && isAcpNotification(frame)) {
      expect(frame.method).toBe("session/message");
    }
  });

  it("returns null for blank and comment lines", () => {
    expect(parseAcpLine("")).toBeNull();
    expect(parseAcpLine("   ")).toBeNull();
    expect(parseAcpLine(":keepalive")).toBeNull();
  });

  it("returns null for non-JSON and malformed JSON", () => {
    expect(parseAcpLine("not json")).toBeNull();
    expect(parseAcpLine("{broken")).toBeNull();
    expect(parseAcpLine("[1, 2, 3]")).toBeNull();
    expect(parseAcpLine('"just a string"')).toBeNull();
    expect(parseAcpLine("42")).toBeNull();
  });

  it("returns null for a frame missing jsonrpc 2.0", () => {
    expect(parseAcpLine(JSON.stringify({ id: "1", method: "x" }))).toBeNull();
    expect(parseAcpLine(JSON.stringify({ jsonrpc: "1.0", id: "1", method: "x" }))).toBeNull();
  });

  it("returns null for a frame that is neither request, response, nor notification", () => {
    // has jsonrpc but no id, method, result, or error
    expect(parseAcpLine(JSON.stringify({ jsonrpc: "2.0", params: {} }))).toBeNull();
  });

  it("returns null for an oversized frame", () => {
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/message",
      params: { content: "x".repeat(MAX_ACP_FRAME_CHARACTERS) }
    });
    expect(huge.length).toBeGreaterThan(MAX_ACP_FRAME_CHARACTERS);
    expect(parseAcpLine(huge)).toBeNull();
  });

  it("ignores surrounding whitespace/newlines when framing", () => {
    const frame = parseAcpLine(
      `  \n${JSON.stringify({ jsonrpc: "2.0", method: "session/progress", params: {} })}\n  `
    );
    expect(frame).not.toBeNull();
  });
});

describe("encodeAcpFrame", () => {
  it("encodes a frame as a single newline-terminated JSON line", () => {
    const encoded = encodeAcpFrame({
      jsonrpc: "2.0",
      id: "req-1",
      method: "initialize",
      params: { client: "fable" }
    });
    expect(encoded.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(encoded.trim());
    expect(parsed.method).toBe("initialize");
  });

  it("refuses to encode an oversized frame", () => {
    expect(() =>
      encodeAcpFrame({
        jsonrpc: "2.0",
        id: "req-1",
        method: "initialize",
        params: { content: "x".repeat(MAX_ACP_FRAME_CHARACTERS) }
      })
    ).toThrow();
  });
});
