import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport } from "./transport";
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
});
