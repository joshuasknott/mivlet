import { describe, expect, it } from "vitest";
import type { BackendAgentEvent } from "@mivlet/protocol";
import { parseOpenAiLine } from "./openai-compat";
import { newAnthropicState, parseAnthropicLine } from "./anthropic";
import { parseGeminiLine } from "./gemini";
import { runAgentLoop } from "./agent-loop";
import { SequencedFixtureTransport } from "./transport";

describe("provider usage measurements", () => {
  it("accepts OpenRouter reported zero, preserves categories and rejects untrusted costs on other routes", () => {
    const line =
      'data: {"usage":{"prompt_tokens":120,"completion_tokens":50,"cost":0,"prompt_tokens_details":{"cached_tokens":30,"cache_write_tokens":20},"completion_tokens_details":{"reasoning_tokens":10}}}';
    expect(parseOpenAiLine("openrouter", line)[0]).toMatchObject({
      type: "usage",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
      costUsd: 0,
      costUnknown: false,
      costEstimated: false,
    });
    expect(parseOpenAiLine("custom", line)[0]).toMatchObject({
      costUnknown: true,
      costEstimated: true,
    });
    expect(
      parseOpenAiLine("openrouter", 'data: {"usage":{"cost":-1}}')[0],
    ).toMatchObject({ costUnknown: true });
  });
  it("normalizes Anthropic cache reads and writes without inventing categories", () => {
    const state = newAnthropicState();
    parseAnthropicLine(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":60,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}}',
      state,
    );
    expect(
      parseAnthropicLine(
        'data: {"type":"message_delta","usage":{"output_tokens":20}}',
        state,
      )[0],
    ).toMatchObject({
      type: "usage",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
    });
    expect(
      parseOpenAiLine(
        "openai",
        'data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}',
      )[0],
    ).toMatchObject({
      cachedInputTokens: undefined,
      reasoningTokens: undefined,
    });
  });
  it("includes Gemini thoughts once in output", () => {
    expect(
      parseGeminiLine(
        "gemini",
        '{"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":5,"cachedContentTokenCount":40}}',
      )[0],
    ).toMatchObject({
      type: "usage",
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      reasoningTokens: 5,
    });
  });
  it("replaces streaming snapshots and accumulates distinct tool turns", async () => {
    const transport = SequencedFixtureTransport.fromTexts([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":10}}',
      'data: {"usage":{"prompt_tokens":200,"completion_tokens":5}}\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}',
    ]);
    const events: BackendAgentEvent[] = [];
    for await (const event of runAgentLoop(
      transport,
      {
        providerId: "openai",
        model: "gpt-5",
        messages: [{ role: "user", content: "fixture" }],
        tools: [],
        maxTokens: 1024,
      },
      {
        execute: async () => "fixture result",
        modelSupportsTools: true,
        maxTurns: 2,
      },
    ))
      events.push(event);
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.at(-1)).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 40,
      costUnknown: true,
    });
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(
      1,
    );
  });
});
