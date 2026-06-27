import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport } from "./transport";
import { readFixture } from "./fixtures-loader";
import { parseOpenAiLine, shapeOpenAiRequest, streamOpenAiEvents } from "./openai-compat";

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
});
