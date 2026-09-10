import { describe, expect, it, vi } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { runAgentLoop } from "./agent-loop";
import type { HttpTransport } from "./transport";
import { registeredToolSpecs } from "./tools";
import { shapeAnthropicRequest } from "./anthropic";

function response(provider: string, callId: string, tool: string, args: string): string[] {
  const value = (v: unknown) => `data: ${JSON.stringify(v)}`;
  return provider === "anthropic" ? [
    value({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: callId, name: tool, input: {} } }),
    value({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
    value({ type: "content_block_stop", index: 0 }),
    value({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    value({ type: "message_stop" }),
  ] : [
    value({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name: tool, arguments: args } }] } }] }),
    value({ choices: [{ finish_reason: "tool_calls" }] }),
  ];
}

async function collect(events: AsyncIterable<BackendAgentEvent>) {
  const values: BackendAgentEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

const tools = registeredToolSpecs().filter(tool => tool.name.startsWith("local-desktop-"));
const metadata = (id: string) => JSON.stringify({ observationId: id, width: 640, height: 480, trust: "external-untrusted", imageDelivery: "native-provider-only" });

describe("visual tool continuations (mocked native transport)", () => {
  it.each(["openai", "anthropic", "xai"])("%s preserves observe → act → observe calls, approvals and metadata without transporting pixels through JS", async providerId => {
    const requests: NativeCompletionRequest[] = [];
    const ids = ["observe-1", "act-1", "observe-2"];
    const turns = [response(providerId, ids[0], "local-desktop-observe", "{}"),
      response(providerId, ids[1], "local-desktop-action", '{"action":"click","observationId":"fresh-1","x":25,"y":40}'),
      response(providerId, ids[2], "local-desktop-observe", "{}")];
    const transport: HttpTransport = {
      toolApprovalId: id => ids.includes(id) ? `api-visual-${id}` : undefined,
      async *stream(request) {
        requests.push(structuredClone(request));
        for (const line of turns[requests.length - 1] ?? [providerId === "anthropic"
          ? 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}'
          : 'data: {"choices":[{"finish_reason":"stop"}]}']) yield line;
      },
    };
    let observation = 0;
    const execute = vi.fn(async (approval, _args) => approval.action.startsWith("local-desktop-observe") ? metadata(`fresh-${++observation}`) : '{"status":"input-dispatched","requiresObservation":true}');
    const events = await collect(runAgentLoop(transport, { providerId, model: "mock-vision", messages: [{ role: "user", content: "Check the disposable app" }], tools, maxTokens: 100 }, { execute, modelSupportsTools: true }));
    expect(execute.mock.calls.map(([approval]) => approval.id)).toEqual(ids.map(id => `api-visual-${id}`));
    expect(requests).toHaveLength(4);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: ids[0], content: metadata("fresh-1") });
    expect(JSON.parse(execute.mock.calls[1][1])).toEqual({ action: "click", observationId: "fresh-1", x: 25, y: 40 });
    expect(requests[3].messages.at(-1)?.content).toBe(metadata("fresh-2"));
    expect(JSON.stringify(requests)).not.toMatch(/data:image|"images"|base64/);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it.each([false, true])("blocks fabricated visual calls when advertised=%s but no native binding exists", async advertised => {
    const execute = vi.fn();
    const transport: HttpTransport = { async *stream() { yield* response("openai", "forged", "local-desktop-observe", "{}"); } };
    const events = await collect(runAgentLoop(transport, { providerId: "openai", model: "gpt-4.1", messages: [], tools: advertised ? tools : [], maxTokens: 100 }, { execute }));
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
    expect(events.some(e => e.type === "tool-result" && /not advertised|binding is missing/.test(e.output))).toBe(true);
  });

  it("does not execute the next queued action or send a continuation after Stop during observation", async () => {
    let cancelled = false;
    let streams = 0;
    const transport: HttpTransport = {
      toolApprovalId: id => `api-visual-${id}`,
      async *stream() {
        streams++;
        yield* response("openai", "observe", "local-desktop-observe", "{}");
      },
    };
    const events = await collect(runAgentLoop(transport, { providerId: "openai", model: "gpt-4.1", messages: [], tools, maxTokens: 100 }, {
      execute: async () => { cancelled = true; return metadata("late"); }, shouldCancel: () => cancelled,
    }));
    expect(streams).toBe(1);
    expect(events.at(-1)).toEqual({ type: "cancelled" });
    expect(events.some(e => e.type === "tool-result")).toBe(false);
  });

  it("groups Anthropic parallel results in the immediately following user message", () => {
    const body = shapeAnthropicRequest({ providerId: "anthropic", model: "claude-sonnet-4-6", tools, maxTokens: 100, messages: [
      { role: "assistant", content: "", toolCalls: [{ callId: "visual", tool: "local-desktop-observe", arguments: "{}" }, { callId: "read", tool: "read-file", arguments: '{"path":"test.txt"}' }] },
      { role: "tool", content: metadata("fresh"), toolCallId: "visual", toolName: "local-desktop-observe" },
      { role: "tool", content: "fixture text", toolCallId: "read", toolName: "read-file" },
    ] }) as { messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }> };
    expect(body.messages.map(m => m.role)).toEqual(["assistant", "user"]);
    expect(body.messages[1].content.map(block => block.tool_use_id)).toEqual(["visual", "read"]);
  });
});
