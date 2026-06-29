import { describe, expect, it } from "vitest";
import type { AgentRunRequest, BackendAgentEvent } from "@fable/protocol";
import { FakeAcpTransport, type ScriptedResponder } from "./transport-fakes";
import { runAcpSession } from "./session";

const providerId = "cursor";

const baseRequest: AgentRunRequest = {
  model: "cursor-default",
  messages: [{ role: "user", content: "say hi" }],
  tools: [],
  maxTokens: 1024
};

/** A responder that accepts initialize/session/new/session/prompt and errors otherwise. */
const okResponder: ScriptedResponder = (req) => {
  if (["initialize", "session/new", "session/prompt", "session/close"].includes(req.method)) {
    return { result: {} };
  }
  return { error: { code: -32601, message: `method not found: ${req.method}` } };
};

async function collect(
  iter: AsyncIterable<BackendAgentEvent>
): Promise<BackendAgentEvent[]> {
  const out: BackendAgentEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("runAcpSession lifecycle", () => {
  it("streams text deltas then done for a no-tool turn", async () => {
    const transport = new FakeAcpTransport(okResponder);
    // After session/prompt is accepted, the CLI streams two messages then done.
    // We queue them up front; the session drains them after the prompt reply.
    transport.queueNotification("session/message", { content: "Hello" });
    transport.queueNotification("session/message", { content: " world" });
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, {
        execute: async () => "ok"
      })
    );

    const text = events
      .filter((e): e is Extract<BackendAgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello world");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("sends initialize → session/new → session/prompt → session/close over the transport", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueDone();
    transport.queueClose();

    await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );

    const sentMethods = transport.sentFrames
      .filter((f): f is Extract<typeof f, { method: string }> => "method" in f)
      .map((f) => f.method);
    expect(sentMethods).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "session/close"
    ]);
  });

  it("passes the model + user prompt into the session/prompt request", async () => {
    const seen: { model?: string; messages?: unknown } = {};
    const responder: ScriptedResponder = (req) => {
      if (req.method === "session/prompt" && req.params && typeof req.params === "object") {
        const p = req.params as Record<string, unknown>;
        seen.model = p.model as string | undefined;
        seen.messages = p.messages;
      }
      return { result: {} };
    };
    const transport = new FakeAcpTransport(responder);
    transport.queueDone();
    transport.queueClose();

    await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );

    expect(seen.model).toBe("cursor-default");
    expect(Array.isArray(seen.messages)).toBe(true);
  });

  it("surfaces an error event when initialize fails", async () => {
    const responder: ScriptedResponder = (req) =>
      req.method === "initialize"
        ? { error: { code: -32001, message: "CLI requires sign-in" } }
        : { result: {} };
    const transport = new FakeAcpTransport(responder);

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") {
      expect(error.message).toContain("sign-in");
    }
    // No done event when initialization failed.
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("routes a tool call through execute and sends the result back to the CLI", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("tool/call", {
      callId: "call-1",
      tool: "read-file",
      arguments: JSON.stringify({ path: "a.txt" })
    });
    // After the tool result, the CLI finishes the turn.
    transport.queueDone();
    transport.queueClose();

    const executed: { callId: string; args: string }[] = [];
    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, {
        execute: async (_approval, args) => {
          executed.push({ callId: "call-1", args });
          return "file contents";
        }
      })
    );

    // The tool-call event was yielded with a pre-shaped approval.
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toBeDefined();
    // The executor was invoked.
    expect(executed).toHaveLength(1);
    expect(executed[0].args).toBe(JSON.stringify({ path: "a.txt" }));
    // The tool result was yielded back.
    const result = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.callId === "call-1"
    );
    expect(result?.ok).toBe(true);
    expect(result?.output).toBe("file contents");
    // The session sent a tool/result frame back to the CLI.
    const sentToolResults = transport.sentFrames.filter(
      (f): f is Extract<typeof f, { method: string; params: unknown }> =>
        "method" in f && f.method === "tool/result"
    );
    expect(sentToolResults).toHaveLength(1);
  });

  it("yields a failed tool-result when execute throws", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("tool/call", {
      callId: "call-1",
      tool: "read-file",
      arguments: "{}"
    });
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, {
        execute: async () => {
          throw new Error("permission denied");
        }
      })
    );

    const result = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> => e.type === "tool-result"
    );
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain("permission denied");
  });

  it("surfaces an error event for a session/error notification", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueError("model overloaded");
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("emits a usage event when the CLI reports usage", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("session/usage", { inputTokens: 12, outputTokens: 34, costUsd: 0.02 });
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );
    const usage = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "usage" }> => e.type === "usage"
    );
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.outputTokens).toBe(34);
    expect(usage?.costUsd).toBe(0.02);
  });

  it("enforces the max-tool-calls cap", async () => {
    const transport = new FakeAcpTransport(okResponder);
    for (let i = 0; i < 5; i++) {
      transport.queueNotification("tool/call", {
        callId: `call-${i}`,
        tool: "read-file",
        arguments: "{}"
      });
    }
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, {
        execute: async () => "ok",
        maxToolCalls: 2
      })
    );
    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls.length).toBe(2);
    // The cap surfaces as an error.
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("rejects a replayed tool call id", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("tool/call", { callId: "dup", tool: "read-file", arguments: "{}" });
    transport.queueNotification("tool/call", { callId: "dup", tool: "read-file", arguments: "{}" });
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );
    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls.length).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("rejects a malformed tool call id", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("tool/call", { callId: "bad id!", tool: "read-file", arguments: "{}" });
    transport.queueDone();
    transport.queueClose();

    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("closes the transport when the turn ends", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueDone();
    transport.queueClose();

    await collect(
      runAcpSession(transport, providerId, baseRequest, { execute: async () => "ok" })
    );
    // session/close is always sent; the assertion is its presence in sent frames.
    expect(
      transport.sentFrames.some((f) => "method" in f && f.method === "session/close")
    ).toBe(true);
  });
});

describe("runAcpSession cooperative cancellation", () => {
  it("stops streaming and yields cancelled when shouldCancel returns true", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueNotification("session/message", { content: "a" });
    transport.queueNotification("session/message", { content: "b" });
    transport.queueNotification("session/message", { content: "c" });
    transport.queueDone();
    transport.queueClose();

    let calls = 0;
    const events = await collect(
      runAcpSession(transport, providerId, baseRequest, {
        execute: async () => "ok",
        shouldCancel: () => {
          calls += 1;
          return calls > 1; // cancel after the first event is checked
        }
      })
    );
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    // Not all three messages were emitted.
    const texts = events.filter((e) => e.type === "text-delta");
    expect(texts.length).toBeLessThan(3);
  });
});
