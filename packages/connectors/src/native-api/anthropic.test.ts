import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@mivlet/protocol";
import { FixtureTransport } from "./transport";
import type { HttpTransport } from "./transport";
import { readFixture } from "./fixtures-loader";
import {
  newAnthropicState,
  parseAnthropicLine,
  shapeAnthropicRequest,
  streamAnthropicEvents
} from "./anthropic";

const request: NativeCompletionRequest = {
  providerId: "anthropic",
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024
};

describe("anthropic shaping", () => {
  it("splits system vs conversation messages", () => {
    const body = shapeAnthropicRequest({
      ...request,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" }
      ]
    }) as Record<string, unknown>;
    expect(body.system).toBe("be brief");
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
    expect(body.max_tokens).toBe(1024);
  });

  it("parses a text delta", () => {
    const events = parseAnthropicLine(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}'
    );
    expect(events).toEqual([{ type: "text-delta", text: "Hi" }]);
  });

  it("parses a tool_use block into a tool-call event when it closes", () => {
    const state = newAnthropicState();
    const start =
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read-file","input":{}}}';
    const delta =
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.md\\"}"}}';
    const stop = 'data: {"type":"content_block_stop","index":1}';

    parseAnthropicLine(start, state);
    parseAnthropicLine(delta, state);
    const events = parseAnthropicLine(stop, state);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool-call");
    if (events[0].type === "tool-call") {
      expect(events[0].tool).toBe("read-file");
      expect(events[0].callId).toBe("toolu_1");
      expect(JSON.parse(events[0].arguments)).toEqual({ path: "a.md" });
    }
  });

  it("parses message_delta stop reason + usage", () => {
    const events = parseAnthropicLine(
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}'
    );
    expect(events.some((e) => e.type === "done" && e.finishReason === "tool-calls")).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.outputTokens === 8)).toBe(true);
  });

  it("streams the recorded fixture into ordered events", async () => {
    const transport = FixtureTransport.fromText(readFixture("anthropic.txt"));
    const events = [];
    for await (const event of streamAnthropicEvents(transport, request)) {
      events.push(event);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types.at(-1)).toBe("done");
  });

  it("assembles partial streamed tool json args across deltas (anthropic)", () => {
    const state = newAnthropicState();
    parseAnthropicLine('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"edit","input":{}}}', state);
    parseAnthropicLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1"}}', state);
    parseAnthropicLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":",\\"b\\":2}"}}', state);
    const evs = parseAnthropicLine('data: {"type":"content_block_stop","index":0}', state);
    expect(evs[0]).toMatchObject({ type: "tool-call", tool: "edit", arguments: '{"a":1,"b":2}' });
  });

  it("handles multi-line chunk, comments, provider error for anthropic", async () => {
    class ChunkTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n:heartbeat\ndata: {"error":{"type":"overloaded"}}';
      }
    }
    const events: any[] = [];
    for await (const e of streamAnthropicEvents(new ChunkTransport(), request)) events.push(e);
    expect(events.some((e) => e.type === "error" && e.message === "Provider error.")).toBe(true);
  });

  it("ignores late events after done and produces exactly one terminal at loop level (anthropic stream forwards)", async () => {
    const transport = new FixtureTransport([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Z"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"stop"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"late"}}'
    ]);
    const events: any[] = [];
    for await (const e of streamAnthropicEvents(transport, request)) events.push(e);
    // parser level yields what arrives; loop guarantees one terminal
    expect(events.filter((e) => e.type === "done").length).toBe(1);
  });
});
