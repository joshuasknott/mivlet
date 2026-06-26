import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@arden/protocol";
import { FixtureTransport } from "./transport";
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
});
