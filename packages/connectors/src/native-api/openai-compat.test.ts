import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport } from "./transport";
import { readFixture } from "./fixtures-loader";
import { parseOpenAiLine, shapeOpenAiRequest, streamOpenAiEvents } from "./openai-compat";
import type { HttpTransport } from "./transport";

const request: NativeCompletionRequest = {
  providerId: "openai",
  model: "gpt-5",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024
};

describe("openai-compatible shaping", () => {
  it("shapes a normalized request into the OpenAI chat body", () => {
    const body = shapeOpenAiRequest(request) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5");
    expect(body.stream).toBe(true);
    expect((body.stream_options as { include_usage: boolean }).include_usage).toBe(true);
    expect((body.messages as unknown[])[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("parses a text delta line", () => {
    const events = parseOpenAiLine("openai", 'data: {"choices":[{"delta":{"content":"Hi"}}]}');
    expect(events).toEqual([{ type: "text-delta", text: "Hi" }]);
  });

  it("parses a tool-call line into a tool-call event with an approval", () => {
    const line =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"read-file","arguments":"{\\"path\\":\\"a.md\\"}"}}]}}]}';
    const events = parseOpenAiLine("openai", line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool-call");
    if (events[0].type === "tool-call") {
      expect(events[0].tool).toBe("read-file");
      expect(events[0].callId).toBe("call_9");
      expect(events[0].approval.service).toBe("openai");
      expect(events[0].approval.mode).toBe("read-only");
    }
  });

  it("parses usage + finish into usage and done events", () => {
    const line =
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}';
    const events = parseOpenAiLine("openai", line);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "usage", inputTokens: 12, outputTokens: 8 });
    expect(events[1]).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("ignores the [DONE] sentinel", () => {
    expect(parseOpenAiLine("openai", "data: [DONE]")).toEqual([]);
  });

  it("emits an error event for unparseable JSON", () => {
    const events = parseOpenAiLine("openai", "data: {broken");
    expect(events).toEqual([{ type: "error", message: "Unparseable OpenAI chunk." }]);
  });

  it("streams the full recorded fixture into ordered events", async () => {
    const transport = FixtureTransport.fromText(readFixture("openai.txt"));
    const events = [];
    for await (const event of streamOpenAiEvents(transport, request)) {
      events.push(event);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types).toContain("usage");
    expect(types.at(-1)).toBe("done");
  });

  it("assembles fragmented streamed tool names and arguments before execution", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-","arguments":"{\\"pa"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}'
    ]);
    const events = [];
    for await (const event of streamOpenAiEvents(transport, request)) events.push(event);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      callId: "call_1",
      tool: "read-file",
      arguments: '{"path":"README.md"}'
    });
    expect(events[1]).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("handles multiple events in one chunk via splitLines", async () => {
    class MultiChunkTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}';
      }
    }
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(new MultiChunkTransport(), request)) events.push(e);
    expect(events).toEqual([
      { type: "text-delta", text: "A" },
      { type: "text-delta", text: "B" }
    ]);
  });

  it("emits only unseen suffixes for MiniMax cumulative content frames", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":"Hello world"}}]}',
      'data: {"choices":[{"delta":{"content":"Hello world"}}]}',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":"Hello world!"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const minimaxRequest = { ...request, providerId: "minimax", model: "MiniMax-M2.7" };
    const events = [];
    for await (const event of streamOpenAiEvents(transport, minimaxRequest)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "text-delta", text: "!" },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("preserves incremental content behavior for other OpenAI-compatible providers", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":"Hello world"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events = [];
    for await (const event of streamOpenAiEvents(transport, request)) events.push(event);

    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: "Hello world" },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("drops comments, heartbeats, blanks and [DONE] via shared extract", async () => {
    const transport = new FixtureTransport([
      ": this is :heartbeat comment",
      "",
      'data: {"choices":[{"delta":{"content":"X"}}]}',
      "data: [DONE]",
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(transport, request)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("emits error for malformed JSON without leaking payload content", () => {
    const bad = 'data: {"choices":[{"delta":{"content":"leak sk-FAKESECRET1234567890"}}]}xxx';
    const events = parseOpenAiLine("openai", bad);
    expect(events).toEqual([{ type: "error", message: "Unparseable OpenAI chunk." }]);
  });

  it("treats provider error frame as error without leaking raw payload", () => {
    const errLine = 'data: {"error":{"message":"bad","type":"invalid"},"id":"x"}';
    const events = parseOpenAiLine("openai", errLine);
    expect(events).toEqual([{ type: "error", message: "Provider error." }]);
  });

  it("handles UTF-8 replacement fragments and still yields one terminal", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"ok' + "\uFFFD" + '"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(transport, request)) events.push(e);
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("late events after terminal are forwarded by raw stream parser (single terminal asserted in agent-loop)", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"first"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
      'data: {"choices":[{"delta":{"content":"late"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(transport, request)) events.push(e);
    // Raw stream/parser forwards late; the runAgentLoop guarantees exactly one terminal outcome.
    expect(events.filter((e) => e.type === "done").length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "text-delta" && e.text === "first")).toBe(true);
  });

  it("supports delayed chunks without dropping events or crashing", async () => {
    class DelayedTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"content":"d"}}]}';
        await new Promise((res) => setTimeout(res, 2));
        yield 'data: {"choices":[{"delta":{"content":"e"}}]}';
        await new Promise((res) => setTimeout(res, 2));
        yield 'data: {"choices":[{"finish_reason":"stop"}]}';
      }
    }
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(new DelayedTransport(), request)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "done"]);
  });

  it("handles lone CR (\\r) splits via splitLines for CRLF coverage", async () => {
    class CrTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"content":"cr1"}}]}\rdata: {"choices":[{"delta":{"content":"cr2"}}]}\r\n data: {"choices":[{"finish_reason":"stop"}]}';
      }
    }
    const events: any[] = [];
    for await (const e of streamOpenAiEvents(new CrTransport(), request)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "done"]);
  });
});
