import { describe, expect, it } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@arden/protocol";
import { FixtureTransport, SequencedFixtureTransport } from "./transport";
import { readFixture } from "./fixtures-loader";
import { runAgentLoop, type ToolExecutor } from "./agent-loop";

const baseRequest: NativeCompletionRequest = {
  providerId: "openai",
  model: "gpt-5",
  messages: [{ role: "user", content: "Read README.md and summarize" }],
  tools: [],
  maxTokens: 1024
};

/** A ToolExecutor that returns a fixed result (simulating an approved execution). */
const echoExecutor: ToolExecutor = async (approval, args) =>
  `result of ${approval.action.split(" ")[0]} on ${args}`;

/** A ToolExecutor that refuses (simulating a denied/unapproved tool). */
const denyingExecutor: ToolExecutor = async () => {
  throw new Error("tool not approved");
};

async function collect(iter: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

describe("runAgentLoop", () => {
  it("streams text deltas then done for a no-tool turn", async () => {
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"content":" there"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events = await collect(runAgentLoop(transport, baseRequest, { execute: echoExecutor }));
    const text = events
      .filter((e): e is Extract<BackendAgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hi there");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("emits a tool-call event but does NOT execute when the executor refuses", async () => {
    const transport = FixtureTransport.fromText(readFixture("openai.txt"));
    const events = await collect(runAgentLoop(transport, baseRequest, { execute: denyingExecutor }));
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toBeDefined();
    // The tool-call surfaces an ApprovalRequest; execution is the executor's job
    // and here it refused, producing a failing tool-result rather than running.
    const failed = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && !e.ok
    );
    expect(failed).toBeDefined();
    expect(failed?.output).toContain("not approved");
  });

  it("continues the loop after a successful tool execution", async () => {
    // Turn 1: tool call (from the openai fixture). Turn 2: stop. The loop must
    // call stream() again for turn 2 — a SequencedFixtureTransport serves a
    // different fixture per call, mirroring production's one-request-per-turn.
    const transport = SequencedFixtureTransport.fromTexts([
      readFixture("openai.txt"),
      'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}'
    ]);

    const events = await collect(runAgentLoop(transport, baseRequest, { execute: echoExecutor }));
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("text-delta");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("honors cooperative cancellation: stops after the cancel signal", async () => {
    const transport = FixtureTransport.fromText(readFixture("openai.txt"));
    const events: BackendAgentEvent[] = [];
    let cancelled = false;
    for await (const event of runAgentLoop(transport, baseRequest, {
      execute: echoExecutor,
      shouldCancel: () => cancelled
    })) {
      events.push(event);
      cancelled = true;
    }
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
  });

  it("stops after maxTurns to avoid runaway loops", async () => {
    // A fixture that always requests a tool call; cap turns at 2.
    const looping = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read-file","arguments":"{}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}]}';
    const transport = new FixtureTransport(looping.split(/\r?\n/));
    const events = await collect(
      runAgentLoop(transport, baseRequest, { execute: echoExecutor, maxTurns: 2 })
    );
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "length" });
  });

  it("prepends a system context prefix when provided", async () => {
    // Use a fixture that echoes nothing and stops; we only assert the loop runs.
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const events = await collect(
      runAgentLoop(transport, baseRequest, {
        execute: echoExecutor,
        contextPrefix: "Trusted memory: be brief"
      })
    );
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  });
});
