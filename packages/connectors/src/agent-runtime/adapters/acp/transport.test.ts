import { describe, expect, it } from "vitest";
import type { AcpFrame } from "./protocol";
import { FakeAcpTransport, type ScriptedResponder } from "./transport-fakes";

describe("FakeAcpTransport", () => {
  it("streams queued frames in order, then ends when closed", async () => {
    const transport = new FakeAcpTransport();
    transport.queueNotification("session/message", { content: "a" });
    transport.queueNotification("session/message", { content: "b" });
    transport.queueDone();
    transport.queueClose();
    const out: AcpFrame[] = [];
    for await (const frame of transport.frames()) out.push(frame);
    expect(out.length).toBe(3);
  });

  it("captures sent frames for assertion", async () => {
    const transport = new FakeAcpTransport();
    await transport.send({ jsonrpc: "2.0", id: "1", method: "initialize", params: {} });
    expect(transport.sentFrames.map((f) => ("method" in f ? f.method : null))).toContain(
      "initialize"
    );
  });

  it("delivers a response for a request via a scripted responder", async () => {
    const responder: ScriptedResponder = (req) => {
      if (req.method === "initialize") {
        return { result: { protocolVersion: "1.0", capabilities: { streaming: true } } };
      }
      return { result: {} };
    };
    const transport = new FakeAcpTransport(responder);
    const reply = await transport.request({
      jsonrpc: "2.0",
      id: "r1",
      method: "initialize",
      params: {}
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect((reply.result as { protocolVersion: string }).protocolVersion).toBe("1.0");
    }
  });

  it("returns an error response when the scripted responder errors", async () => {
    const responder: ScriptedResponder = () => ({
      error: { code: -32000, message: "not signed in" }
    });
    const transport = new FakeAcpTransport(responder);
    const reply = await transport.request({
      jsonrpc: "2.0",
      id: "r1",
      method: "initialize",
      params: {}
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.message).toBe("not signed in");
    }
  });

  it("close() ends the notification stream", async () => {
    const transport = new FakeAcpTransport();
    transport.queueNotification("session/message", { content: "x" });
    const iterator = transport.frames()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await transport.close();
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });
});
