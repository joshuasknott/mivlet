import { describe, expect, it } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport, SequencedFixtureTransport } from "./transport";
import { runAgentLoop } from "./agent-loop";
import type { HttpTransport } from "./transport";
import { readFixture } from "./fixtures-loader";
import { parseGeminiLine, shapeGeminiRequest, streamGeminiEvents } from "./gemini";

const request: NativeCompletionRequest = {
  providerId: "gemini",
  model: "gemini-2-pro",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024
};

describe("gemini shaping", () => {
  it("shapes contents with roles mapped to model/user", () => {
    const body = shapeGeminiRequest(request) as Record<string, unknown>;
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents[0].role).toBe("user");
  });

  it("lifts system messages into systemInstruction", () => {
    const body = shapeGeminiRequest({
      ...request,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" }
      ]
    }) as Record<string, unknown>;
    expect(body.systemInstruction).toBeDefined();
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(1);
  });

  it("parses a text part", () => {
    const events = parseGeminiLine(
      "gemini",
      '{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}]}'
    );
    expect(events).toEqual([{ type: "text-delta", text: "Hi" }]);
  });

  it("parses a functionCall into a tool-call event", () => {
    const events = parseGeminiLine(
      "gemini",
      '{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read-file","args":{"path":"a.md"}}}]}}]}'
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool-call");
    if (events[0].type === "tool-call") {
      expect(events[0].tool).toBe("read-file");
      expect(JSON.parse(events[0].arguments)).toEqual({ path: "a.md" });
    }
  });

  it("parses finishReason + usageMetadata", () => {
    const events = parseGeminiLine(
      "gemini",
      '{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8}}'
    );
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("preserves provider call IDs in events and matching history responses", () => {
    const [event] = parseGeminiLine("gemini", JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: "provider-call-7", name: "read-file", args: { path: "a.md" } } }] } }] }));
    expect(event).toMatchObject({ type: "tool-call", callId: "provider-call-7" });
    expect(shapeGeminiRequest({ ...request, messages: [
      { role: "assistant", content: "", toolCalls: [{ callId: "provider-call-7", tool: "read-file", arguments: '{"path":"a.md"}' }] },
      { role: "tool", content: "file contents", toolCallId: "provider-call-7", toolName: "read-file" },
    ] })).toMatchObject({ contents: [
      { parts: [{ functionCall: { id: "provider-call-7", name: "read-file" } }] },
      { parts: [{ text: "file contents" }, { functionResponse: { id: "provider-call-7", name: "read-file" } }] },
    ] });
  });

  it("executes repeated same-name tools within a stream and across agent turns", async () => {
    const calls = (paths: string[]) => JSON.stringify({ candidates: [{ content: { parts: paths.map((path) => ({ functionCall: { name: "read-file", args: { path } } })) }, finishReason: "STOP" }] });
    const transport = SequencedFixtureTransport.fromTexts([
      calls(["a.md", "b.md"]), calls(["c.md"]), '{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}',
    ]);
    const executed: string[] = [];
    const events: BackendAgentEvent[] = [];
    for await (const event of runAgentLoop(transport, request, {
      runId: "gemini-repeated-call-test", modelSupportsTools: true,
      execute: async (approval, args) => { executed.push(approval.id); return `read ${args}`; },
    })) events.push(event);
    expect(executed).toHaveLength(3);
    expect(new Set(executed).size).toBe(3);
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool-result" && !event.ok)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("streams the recorded fixture into ordered events", async () => {
    const transport = FixtureTransport.fromText(readFixture("gemini.txt"));
    const events = [];
    for await (const event of streamGeminiEvents(transport, request)) {
      events.push(event);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types.at(-1)).toBe("done");
  });

  it("handles provider error frame and multi-chunk for gemini without leaking", async () => {
    class BadTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield '{"error":{"message":"rate"}}';
      }
    }
    const events: any[] = [];
    for await (const e of streamGeminiEvents(new BadTransport(), request)) events.push(e);
    expect(events).toEqual([{ type: "error", message: "Provider error." }]);
  });

  it("drops late events after terminal and malformed for gemini", async () => {
    const transport = new FixtureTransport([
      '{"candidates":[{"content":{"parts":[{"text":"g"}]}}]}',
      '{"candidates":[{"finishReason":"STOP"}]}',
      'not-json-at-all',
      '{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}'
    ]);
    const events: any[] = [];
    for await (const e of streamGeminiEvents(transport, request)) events.push(e);
    const terminals = events.filter((e) => e.type === "done");
    expect(terminals.length).toBe(1);
    expect(events.filter((e) => e.type === "error").length).toBe(1); // from bad line
  });
});
