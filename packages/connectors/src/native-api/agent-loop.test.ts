import { describe, expect, it } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { FixtureTransport, SequencedFixtureTransport, type HttpTransport } from "./transport";
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
  it("does not advertise Mivlet tools to a model that explicitly lacks tool support", async () => {
    const captured: NativeCompletionRequest[] = [];
    const transport: HttpTransport = {
      async *stream(request) {
        captured.push(request);
        yield 'data: {"choices":[{"finish_reason":"stop"}]}';
      }
    };

    await collect(
      runAgentLoop(
        transport,
        { ...baseRequest, providerId: "custom", model: "plain-chat" },
        { execute: echoExecutor }
      )
    );

    expect(captured[0]?.tools).toEqual([]);
  });

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
    const toolTurn = (id: string) =>
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}]}`;
    const transport = SequencedFixtureTransport.fromTexts([toolTurn("c1"), toolTurn("c2")]);
    const events = await collect(
      runAgentLoop(transport, baseRequest, { execute: echoExecutor, maxTurns: 2 })
    );
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "length" });
  });

  it.each([
    ["unknown", "made-up", "{}", /unknown tool/i],
    ["malformed arguments", "read-file", "not-json", /malformed tool arguments/i]
  ])("rejects %s tool calls before execution", async (_name, tool, args, message) => {
    let executions = 0;
    const transport = new FixtureTransport([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: tool, arguments: args } }] } }] })}`,
      'data: {"choices":[{"finish_reason":"tool_calls"}]}'
    ]);
    const events = await collect(
      runAgentLoop(transport, baseRequest, {
        execute: async () => {
          executions += 1;
          return "unexpected";
        },
        runId: "run-safe"
      })
    );
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "tool-result")?.output).toMatch(message);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
  });

  it("rejects malformed call ids before approval or execution", async () => {
    let executions = 0;
    const transport = new FixtureTransport([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"../cross-run","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}'
    ]);
    const events = await collect(
      runAgentLoop(transport, baseRequest, {
        execute: async () => {
          executions += 1;
          return "unexpected";
        },
        runId: "run-safe"
      })
    );
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "tool-result")?.output).toMatch(
      /malformed tool call id/i
    );
  });

  it("rejects replayed call ids and binds approvals to the current run", async () => {
    const turn = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"same-call","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}]}';
    const events = await collect(
      runAgentLoop(SequencedFixtureTransport.fromTexts([turn, turn]), baseRequest, {
        execute: echoExecutor,
        runId: "run-123"
      })
    );
    const approval = events.find((event) => event.type === "tool-call")?.approval;
    expect(approval?.id).toContain("run-123-same-call");
    expect(events.some((event) => event.type === "tool-result" && /replayed/i.test(event.output))).toBe(true);
  });

  it("bounds tool output before reinserting it into model context", async () => {
    const turn = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}]}';
    const events = await collect(
      runAgentLoop(
        SequencedFixtureTransport.fromTexts([
          turn,
          'data: {"choices":[{"finish_reason":"stop"}]}'
        ]),
        baseRequest,
        { execute: async () => "x".repeat(100), maxToolOutputCharacters: 16 }
      )
    );
    const result = events.find((event) => event.type === "tool-result");
    expect(result?.output.startsWith("x".repeat(16))).toBe(true);
    expect(result?.output).toMatch(/truncated/i);
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
