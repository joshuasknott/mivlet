/**
 * OpenRouter-specific discovery and wire behavior.
 *
 * OpenRouter is an OpenAI-compatible router: the shared openai-compat shaper
 * and stream parser carry its chat-completions traffic, and discovery attaches
 * the model's own bounded capability metadata. These tests pin the OpenRouter
 * contract for those shared paths without any live spend:
 *   - discovery merge carries provider-reported capabilities/labels/reasoning
 *     and never fabricates capabilities for unknown metadata;
 *   - text streaming and interleaved tool-call fragments assemble in order;
 *   - the documented final usage chunk (a content-free delta that repeats the
 *     finish_reason) is an accounting frame, and usage carries unknown cost;
 *   - a mid-stream provider error chunk surfaces as an error event.
 */

import { describe, expect, it } from "vitest";
import type { BackendModel } from "@mivlet/protocol";
import { mergeDiscoveredModels, type DiscoveredModel } from "./discovery";
import { newOpenAiStreamState, parseOpenAiStreamLine, shapeOpenAiRequest } from "./openai-compat";

describe("OpenRouter discovery merge", () => {
  const catalogueModels: BackendModel[] = [];

  it("carries provider-reported capabilities, label and reasoning into the picker model", () => {
    const discovered: DiscoveredModel[] = [
      {
        id: "anthropic/claude-sonnet-4.6",
        available: true,
        label: "Claude Sonnet 4.6",
        capabilities: {
          contextWindow: 200_000,
          streaming: true,
          tools: true,
          structuredOutput: true,
          reasoning: true
        },
        reasoning: {
          supportedEfforts: ["max", "high", "medium", "low"],
          defaultEffort: "medium"
        }
      }
    ];
    const merged = mergeDiscoveredModels({
      providerId: "openrouter",
      catalogueModels,
      discovered,
      connected: true,
      discoveryRan: true
    });
    const model = merged.find((m) => m.id === "anthropic/claude-sonnet-4.6");
    expect(model?.available).toBe(true);
    expect(model?.label).toBe("Claude Sonnet 4.6");
    expect(model?.capabilities).toEqual(discovered[0]?.capabilities);
    expect(model?.reasoning).toEqual(discovered[0]?.reasoning);
  });

  it("keeps every discovered OpenRouter id selectable without inventing capability detail", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openrouter",
      catalogueModels,
      discovered: [
        { id: "openrouter/auto", available: true },
        { id: "deepseek/deepseek-chat:free", available: true }
      ],
      connected: true,
      discoveryRan: true
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.available).toBe(true);
    expect(merged[0]?.capabilities).toBeUndefined();
    expect(merged[1]?.available).toBe(true);
  });

  it("does not inherit tools/vision/reasoning from another discovered model", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openrouter",
      catalogueModels,
      discovered: [
        {
          id: "openai/gpt-4.1",
          available: true,
          capabilities: { streaming: true, tools: true }
        },
        { id: "mystery/unlisted", available: true }
      ],
      connected: true,
      discoveryRan: true
    });
    const unknown = merged.find((m) => m.id === "mystery/unlisted");
    // Unknown metadata stays unknown — never treated as tool/vision/reasoning capable.
    expect(unknown?.capabilities).toBeUndefined();
    expect(unknown?.reasoning).toBeUndefined();
  });

  it("shapes an OpenAI-compatible body with the exact routed model id", () => {
    const request = {
      providerId: "openrouter" as const,
      model: "openai/gpt-4.1:free",
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [],
      maxTokens: 512
    };
    const body = shapeOpenAiRequest(request) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-4.1:free");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(512);
    // OpenRouter is not treated as OpenAI: no max_completion_tokens alias.
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("OpenRouter streaming", () => {
  it("streams text deltas and treats the repeated finish_reason usage chunk as an accounting frame", () => {
    const state = newOpenAiStreamState();
    const first = parseOpenAiStreamLine("openrouter", "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}", state);
    expect(first).toEqual([{ type: "text-delta", text: "Hello " }]);
    const second = parseOpenAiStreamLine("openrouter", "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}", state);
    expect(second).toEqual([
      { type: "text-delta", text: "world" },
      { type: "done", finishReason: "stop" }
    ]);
    // OpenRouter's final usage chunk repeats finish_reason on a content-free
    // delta. The parser emits the usage event with unknown cost; the agent
    // loop holds the duplicate done so the shell never sees two terminals.
    const usage = parseOpenAiStreamLine("openrouter", "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}", state);
    expect(usage).toEqual([
      { type: "usage", inputTokens: 7, outputTokens: 2, costUsd: 0, costEstimated: true, costUnknown: true },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("assembles interleaved tool-call fragments into one ordered tool-call event", () => {
    const state = newOpenAiStreamState();
    const fragments = [
      "data: " + JSON.stringify({ choices: [{ delta: { content: "Let me check.", tool_calls: [{ index: 0, id: "call_abc", function: { name: "web-fetch", arguments: "{\"url\":\"https" } }] } }] }),
      "data: " + JSON.stringify({ choices: [{ delta: { content: "", tool_calls: [{ index: 0, function: { arguments: "://example.com\"}" } }] } }] }),
      "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
    ];
    const events = fragments.flatMap((line) => parseOpenAiStreamLine("openrouter", line, state));
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text-delta", text: "Let me check." });
    expect(events[1]).toEqual({
      type: "tool-call",
      callId: "call_abc",
      tool: "web-fetch",
      arguments: "{\"url\":\"https://example.com\"}",
      approval: expect.objectContaining({ service: "openrouter", action: expect.stringContaining("web-fetch") })
    });
    expect(events[2]).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("surfaces a mid-stream provider error chunk as an error event", () => {
    const state = newOpenAiStreamState();
    const events = parseOpenAiStreamLine(
      "openrouter",
      "data: {\"error\":{\"message\":\"Provider disconnected unexpectedly\"},\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\"},\"finish_reason\":\"error\"}]}",
      state
    );
    expect(events).toEqual([{ type: "error", message: "Provider error." }]);
  });
});
