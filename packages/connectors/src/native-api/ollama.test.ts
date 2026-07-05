import { describe, expect, it } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport } from "./transport";
import { mergeDiscoveredModels } from "./discovery";
import { shapeOllamaChatRequest, streamOllamaEvents } from "./ollama";

const request: NativeCompletionRequest = {
  providerId: "ollama",
  model: "llama3.2",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  maxTokens: 128
};

async function collect(lines: readonly string[]) {
  const events: BackendAgentEvent[] = [];
  for await (const event of streamOllamaEvents(new FixtureTransport(lines), request)) {
    events.push(event);
  }
  return events;
}

describe("Ollama local model stream contract", () => {
  it("streams text and usage from native NDJSON chunks", async () => {
    const events = await collect([
      '{"message":{"role":"assistant","content":"Hi"},"done":false}',
      '{"message":{"role":"assistant","content":" there"},"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":3,"eval_count":2}'
    ]);

    expect(events).toContainEqual({ type: "text-delta", text: "Hi" });
    expect(events).toContainEqual({ type: "text-delta", text: " there" });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 3,
      outputTokens: 2,
      costUsd: 0,
      costEstimated: true
    });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("maps Ollama tool calls to Fable approval events", async () => {
    const events = await collect([
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read-file","arguments":{"path":"README.md"}}}]},"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true}'
    ]);

    const toolCall = events.find(
      (event): event is Extract<BackendAgentEvent, { type: "tool-call" }> =>
        event.type === "tool-call"
    );
    expect(toolCall?.tool).toBe("read-file");
    expect(toolCall?.arguments).toBe('{"path":"README.md"}');
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("surfaces mid-stream Ollama errors", async () => {
    const events = await collect(['{"error":"model not found"}']);
    expect(events).toEqual([
      {
        type: "error",
        message: "model not found",
        code: "invalid-request",
        retryable: false
      },
      { type: "done", finishReason: "error" }
    ]);
  });

  it("shapes chat requests without pull/download fields", () => {
    const body = shapeOllamaChatRequest({
      ...request,
      tools: [{ name: "read-file", description: "Read file", parameters: '{"type":"object"}' }]
    }) as Record<string, unknown>;

    expect(body.model).toBe("llama3.2");
    expect(body.stream).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/pull|download/i);
  });

  it("keeps local discovered models available only with discovered capabilities", () => {
    const models = mergeDiscoveredModels({
      providerId: "ollama",
      catalogueModels: [],
      connected: true,
      discoveryRan: true,
      discovered: [
        {
          id: "llama3.2",
          available: true,
          capabilities: {
            contextWindow: 4096,
            maxOutputTokens: 2048,
            streaming: true,
            tools: false,
            vision: false,
            reasoning: false,
            structuredOutput: true
          }
        },
        { id: "unknown-no-show", available: true }
      ]
    });

    expect(models.find((model) => model.id === "llama3.2")?.available).toBe(true);
    expect(models.find((model) => model.id === "unknown-no-show")?.available).toBe(false);
  });
});
