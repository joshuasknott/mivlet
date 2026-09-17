/**
 * DeepSeek provider tests: request shaping, the documented stream shape
 * (usage rides the terminal chunk), and the reachable setup -> selection ->
 * egress -> text -> approved tool -> final response path over deterministic
 * fixtures.
 *
 * Official DeepSeek platform facts reviewed 2026-09-11:
 * - Chat Completions is OpenAI-compatible: api-docs.deepseek.com
 *   /api/create-chat-completion (base URL https://api.deepseek.com).
 * - Model IDs deepseek-flash / deepseek-v4-pro; lists via GET /models
 *   (api-docs.deepseek.com /api/list-models).
 * - stream_options.include_usage is supported; the last content chunk carries
 *   finish_reason + usage together (no separate usage-only chunk).
 * - Thinking mode is default-enabled; with tools it requires resending
 *   reasoning_content on every later turn or the API returns 400. Mivlet
 *   disables thinking mode and does not advertise reasoning levels.
 */

import { describe, expect, it } from "vitest";
import type {
  BackendAgentEvent,
  BackendModel,
  NativeCompletionRequest,
  NativeMessage
} from "@mivlet/protocol";
import { runAgentLoop, type ToolExecutor } from "./agent-loop";
import { BackendRuntimeError } from "../agent-runtime/utils/errors";
import {
  defaultDiscoveredCapabilities,
  catalogueCapabilities,
  validateModelForRun
} from "./model-catalogue";
import { shapeOpenAiRequest, streamOpenAiEvents } from "./openai-compat";
import { validateReasoningEffort } from "./reasoning";
import { FixtureTransport, SequencedFixtureTransport, type HttpTransport } from "./transport";
import { readFixture } from "./fixtures-loader";

const deepseekRequest = (overrides: Partial<NativeCompletionRequest> = {}): NativeCompletionRequest => ({
  providerId: "deepseek",
  model: "deepseek-flash",
  messages: [{ role: "user", content: "What's in the workspace?" }],
  tools: [],
  maxTokens: 2048,
  ...overrides
});

const catalogueModels: BackendModel[] = [
  { id: "deepseek-flash", label: "DeepSeek Flash", available: true },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", available: true }
];

async function collect(iter: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

describe("deepseek request shaping", () => {
  it("shapes an OpenAI-compatible chat body with max_tokens and thinking disabled", () => {
    const body = shapeOpenAiRequest(deepseekRequest()) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-flash");
    expect(body.stream).toBe(true);
    expect((body.stream_options as { include_usage: boolean }).include_usage).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("never sends reasoning_effort for deepseek, even on a stale request", () => {
    const body = shapeOpenAiRequest(
      deepseekRequest({ reasoningEffort: "high" })
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("shapes assistant tool calls and tool results in OpenAI order", () => {
    const messages: NativeMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callId: "call_1", tool: "read-file", arguments: '{"path":"a.md"}' }]
      },
      { role: "tool", content: "contents", toolCallId: "call_1", toolName: "read-file" }
    ];
    const body = shapeOpenAiRequest(
      deepseekRequest({ messages })
    ) as { messages: Record<string, unknown>[] };
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read-file", arguments: '{"path":"a.md"}' }
        }
      ]
    });
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });
});

describe("deepseek stream parsing (documented shape)", () => {
  it("parses text deltas and a terminal chunk whose usage rides finish_reason", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      "data: [DONE]"
    ]);
    const events = await collect(streamOpenAiEvents(transport, deepseekRequest()));
    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      {
        type: "usage",
        inputTokens: 7,
        outputTokens: 2,
        costUsd: 0,
        costEstimated: true,
        costUnknown: true
      },
      { type: "done", finishReason: "stop" }
    ]);
  });

  it("assembles fragmented tool call name and arguments like the API reference streams", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_00_a","type":"function","function":{"name":"read-","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file"}}]}}]}',
      'data: {"choices":[{"delta":{"content":"","role":null},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]"
    ]);
    const events = await collect(streamOpenAiEvents(transport, deepseekRequest()));
    const call = events.find((e): e is Extract<BackendAgentEvent, { type: "tool-call" }> => e.type === "tool-call");
    expect(call).toMatchObject({
      callId: "call_00_a",
      tool: "read-file",
      arguments: '{"path":"README.md"}'
    });
    expect(call?.approval.service).toBe("deepseek");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool-calls" });
  });
});

describe("deepseek reachable path (fixtures only)", () => {
  const turn2Stop = [
    'data: {"choices":[{"delta":{"content":"Done"}}]}',
    'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":4}}',
    "data: [DONE]"
  ];

  it("runs text -> approved tool -> tool result -> final response through the loop", async () => {
    const executed: { callId: string; tool: string; args: string }[] = [];
    const executor: ToolExecutor = async (approval, args) => {
      expect(approval.id).toMatch(/^native-run-tool-/);
      expect(approval.service).toBe("deepseek");
      expect(approval.mode).toBe("read-only");
      executed.push({ callId: approval.id, tool: approval.action, args });
      return "README contents";
    };
    const transport = SequencedFixtureTransport.fromTexts([
      readFixture("deepseek.txt"),
      turn2Stop.join("\n")
    ]);
    const events = await collect(
      runAgentLoop(transport, deepseekRequest({ tools: [], maxTokens: 1024 }), {
        execute: executor,
        runId: "run-tool",
        maxTurns: 2
      })
    );
    expect(executed).toHaveLength(1);
    expect(executed[0].args).toBe('{"path":"README.md"}');
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({ type: "tool-call", tool: "read-file" });
    const result = events.find((e) => e.type === "tool-result" && e.ok);
    expect(result).toMatchObject({ type: "tool-result", output: "README contents" });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
    // Usage from both turns is accounted.
    const usage = events.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a denied tool approval as a failed tool result and still completes", async () => {
    const executor: ToolExecutor = async () => {
      throw new Error("Approval denied by Mivlet.");
    };
    const transport = SequencedFixtureTransport.fromTexts([
      readFixture("deepseek.txt"),
      turn2Stop.join("\n")
    ]);
    const events = await collect(
      runAgentLoop(transport, deepseekRequest(), { execute: executor, maxTurns: 2 })
    );
    const failed = events.find((e) => e.type === "tool-result" && !e.ok);
    expect(failed).toMatchObject({ type: "tool-result", output: "Approval denied by Mivlet." });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("cancels between events without executing the tool", async () => {
    let executed = false;
    const executor: ToolExecutor = async () => {
      executed = true;
      return "ran";
    };
    const events = await collect(
      runAgentLoop(SequencedFixtureTransport.fromTexts([readFixture("deepseek.txt")]), deepseekRequest(), {
        execute: executor,
        shouldCancel: () => true
      })
    );
    expect(executed).toBe(false);
    expect(events.filter((e) => e.type === "cancelled")).toHaveLength(1);
    expect(events.some((e) => e.type === "tool-result")).toBe(false);
  });

  it("forwards an invalid-credential transport failure with its authentication code", async () => {
    const failing: HttpTransport = {
      async *stream(): AsyncIterable<string> {
        throw new BackendRuntimeError(
          "DeepSeek rejected the API key.",
          "authentication",
          false
        );
      }
    };
    const events = await collect(
      runAgentLoop(failing, deepseekRequest(), { execute: async () => "" })
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", code: "authentication", retryable: false });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
  });
});

describe("deepseek model selection and option validation", () => {
  it("rejects a model the catalogue and discovery do not know", () => {
    const result = validateModelForRun("deepseek", "deepseek-unknown", catalogueModels);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not known/i);
  });

  it("rejects an unavailable deepseek model", () => {
    const result = validateModelForRun(
      "deepseek",
      "deepseek-flash",
      [{ id: "deepseek-flash", label: "DeepSeek Flash", available: false }]
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/i);
  });

  it("clamps requested output to the documented non-thinking ceiling", () => {
    const result = validateModelForRun("deepseek", "deepseek-flash", catalogueModels, 1_000_000);
    expect(result.ok).toBe(true);
    expect(result.maxTokens).toBe(8_192);
  });

  it("fails clearly when a reasoning level is requested for deepseek", () => {
    for (const effort of ["low", "high", "max"]) {
      expect(() =>
        validateReasoningEffort("deepseek", catalogueModels[0], effort)
      ).toThrow(/does not support the selected reasoning level/i);
    }
    expect(() =>
      validateReasoningEffort("deepseek", catalogueModels[0], undefined)
    ).not.toThrow();
  });

  it("advertises only documented deepseek capabilities", () => {
    const flash = catalogueCapabilities("deepseek", "deepseek-flash");
    expect(flash).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      structuredOutput: false
    });
    expect(catalogueCapabilities("deepseek", "deepseek-v4-pro")).toMatchObject({
      contextWindow: 1_000_000,
      tools: true,
      vision: false,
      reasoning: false
    });
    expect(defaultDiscoveredCapabilities("deepseek")).toMatchObject({
      tools: false,
      vision: false,
      reasoning: false
    });
  });
});