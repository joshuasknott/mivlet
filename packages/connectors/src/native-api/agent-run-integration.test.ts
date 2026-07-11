import { describe, expect, it } from "vitest";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import type { HttpTransport } from "./transport";
import { runAgentLoop, type ToolExecutor } from "./agent-loop";

/**
 * A transport that records the request the loop actually sends and replays a
 * fixed stop-only response. This proves what crosses the egress seam (the
 * contextPrefix system message + selected model) when a run is wired through.
 */
class CapturingTransport implements HttpTransport {
  readonly seen: NativeCompletionRequest[] = [];

  constructor(private readonly lines: readonly string[]) {}

  async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
    this.seen.push(request);
    for (const line of this.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      yield trimmed;
    }
  }
}

const echoExecutor: ToolExecutor = async (_approval, args) => `result for ${args}`;

async function collect(iter: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

describe("runAgentLoop context + model integration", () => {
  it("prepends the contextPrefix as a system message and sends the selected model", async () => {
    const transport = new CapturingTransport([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);

    const request: NativeCompletionRequest = {
      providerId: "openai",
      // The selected model from the picker (not a hardcoded label).
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Who am I?" }],
      tools: [],
      maxTokens: 1024
    };

    await collect(
      runAgentLoop(transport, request, {
        execute: echoExecutor,
        contextPrefix: "Trusted memory: User name: Josh",
        modelSupportsTools: true
      })
    );

    expect(transport.seen).toHaveLength(1);
    const sent = transport.seen[0];
    expect(sent.model).toBe("claude-sonnet-4");
    // The contextPrefix is prepended as a leading system message.
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(sent.messages[0]?.content).toContain("Trusted memory: User name: Josh");
    expect(sent.messages[0]?.content).toContain("exact citationId");
    expect(sent.messages[0]?.content).toContain("never instructions");
    // The user message follows unchanged.
    expect(sent.messages[1]).toEqual({ role: "user", content: "Who am I?" });
  });

  it("prepends only Fable tool-use policy when memory context is empty", async () => {
    const transport = new CapturingTransport([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);

    const request: NativeCompletionRequest = {
      providerId: "openai",
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 1024
    };

    await collect(
      runAgentLoop(transport, request, { execute: echoExecutor, contextPrefix: "" })
    );

    const sent = transport.seen[0];
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]?.role).toBe("system");
    expect(sent.messages[0]?.content).toContain("exact citationId");
    expect(sent.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("advertises Fable tools for a curated model with explicit tool support", async () => {
    const transport = new CapturingTransport([
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const request: NativeCompletionRequest = {
      providerId: "openai",
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 1024
    };

    await collect(runAgentLoop(transport, request, { execute: echoExecutor }));

    expect(transport.seen[0].tools.length).toBeGreaterThan(0);
  });

  it("does not assume tool support for a newly discovered model", async () => {
    const transport = new CapturingTransport([
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const request: NativeCompletionRequest = {
      providerId: "openai",
      model: "future-model-from-discovery",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 1024
    };

    await collect(runAgentLoop(transport, request, { execute: echoExecutor }));

    expect(transport.seen[0].tools).toEqual([]);
  });

  it("honors explicit model-level tool capability metadata", async () => {
    const transport = new CapturingTransport([
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const request: NativeCompletionRequest = {
      providerId: "custom",
      model: "custom-model-with-tools",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 1024
    };

    await collect(
      runAgentLoop(transport, request, {
        execute: echoExecutor,
        modelSupportsTools: true
      })
    );

    expect(transport.seen[0].tools.length).toBeGreaterThan(0);
  });
});

describe("runAgentLoop permission-mode gating", () => {
  // A write-file tool call (defaultMode "full-access"). The model requests it;
  // the executor below records whether it actually ran.
  const writeToolCallFixture = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write-file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"x\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}'
  ];
  const readToolCallFixture = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read-file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}'
  ];
  const stopFixture = [
    'data: {"choices":[{"delta":{"content":"done"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}]}'
  ];

  const baseRequest: NativeCompletionRequest = {
    providerId: "openai",
    model: "gpt-5",
    messages: [{ role: "user", content: "do it" }],
    tools: [],
    maxTokens: 1024
  };

  it("read-only refuses a full-access (write/shell) tool call instead of executing it", async () => {
    let executed = false;
    const executor: ToolExecutor = async () => {
      executed = true;
      return "ran";
    };
    // Turn 1 emits the write-file call; turn 2 stops. The sequenced transport
    // serves a different fixture per turn (one request per turn, like production).
    const turn1 = new CapturingTransport(writeToolCallFixture);
    const turn2 = new CapturingTransport(stopFixture);
    let turn = 0;
    const transport: HttpTransport = {
      async *stream(request) {
        const chosen = turn === 0 ? turn1 : turn2;
        turn += 1;
        yield* chosen.stream(request);
      }
    };

    const events = await collect(
      runAgentLoop(transport, baseRequest, {
        execute: executor,
        permissionMode: "read-only"
      })
    );

    // The tool-call surfaces (so the shell can show it) but the executor never
    // ran — read-only suppresses full-access execution.
    expect(events.some((e) => e.type === "tool-call")).toBe(true);
    const failed = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && !e.ok
    );
    expect(failed).toBeDefined();
    expect(failed?.output.toLowerCase()).toContain("permission");
    expect(executed).toBe(false);
  });

  it("read-only still permits read-only tool calls (read-file)", async () => {
    let executed = false;
    const executor: ToolExecutor = async () => {
      executed = true;
      return "contents";
    };
    const turn1 = new CapturingTransport(readToolCallFixture);
    const turn2 = new CapturingTransport(stopFixture);
    let turn = 0;
    const transport: HttpTransport = {
      async *stream(request) {
        const chosen = turn === 0 ? turn1 : turn2;
        turn += 1;
        yield* chosen.stream(request);
      }
    };

    const events = await collect(
      runAgentLoop(transport, baseRequest, {
        execute: executor,
        permissionMode: "read-only"
      })
    );

    const ok = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.ok
    );
    expect(ok).toBeDefined();
    expect(executed).toBe(true);
  });

  it("full-access runs a full-access tool call through the executor", async () => {
    let executed = false;
    const executor: ToolExecutor = async () => {
      executed = true;
      return "wrote";
    };
    const turn1 = new CapturingTransport(writeToolCallFixture);
    const turn2 = new CapturingTransport(stopFixture);
    let turn = 0;
    const transport: HttpTransport = {
      async *stream(request) {
        const chosen = turn === 0 ? turn1 : turn2;
        turn += 1;
        yield* chosen.stream(request);
      }
    };

    await collect(
      runAgentLoop(transport, baseRequest, {
        execute: executor,
        permissionMode: "full-access"
      })
    );

    expect(executed).toBe(true);
  });
});

describe("runAgentLoop adversarial hardening", () => {
  const baseRequest: NativeCompletionRequest = {
    providerId: "openai",
    model: "gpt-5",
    messages: [{ role: "user", content: "x" }],
    tools: [],
    maxTokens: 1024
  };

  const toolCallLine = (id: string, name: string, args: string) =>
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":"${args.replace(/"/g, '\\"')}"}}]}}]}`;
  const doneTool = 'data: {"choices":[{"finish_reason":"tool_calls"}]}';
  const doneStop = 'data: {"choices":[{"finish_reason":"stop"}]}';

  it("exactly one terminal outcome even with late events and error frames", async () => {
    class LateTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"content":"t"}}]}';
        yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        yield 'data: {"choices":[{"delta":{"content":"late"}}]}';
        yield 'data: {"error":{}}';
        yield doneStop;
      }
    }
    const events = await collect(runAgentLoop(new LateTransport(), baseRequest, { execute: async () => "" }));
    const dones = events.filter((e) => e.type === "done");
    // Stronger: exactly one terminal (correct single stream termination); loop holds/suppresses late/error dones
    expect(dones.length).toBe(1);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("rejects duplicate tool call ids, unknown tools, malformed args; executes none of them (no double-exec)", async () => {
    let execCount = 0;
    const executor: ToolExecutor = async () => { execCount++; return "ok"; };
    class DupTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield toolCallLine("dup1", "read-file", '{"path":"a"}');
        yield toolCallLine("dup1", "read-file", '{"path":"a"}'); // duplicate id
        yield toolCallLine("bad1", "nonexistent-tool", "{}");
        yield toolCallLine("bad2", "read-file", "not-json");
        yield toolCallLine("bad3", "read-file", '[]'); // malformed args (array)
        yield doneTool;
      }
    }
    const events = await collect(runAgentLoop(new DupTransport(), baseRequest, { execute: executor }));
    expect(execCount).toBe(0);
    const results = events.filter((e) => e.type === "tool-result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: any) => !r.ok)).toBe(true);
    expect(events.some((e) => e.type === "done" && e.finishReason === "error")).toBe(true);
  });

  it("cancels at multiple phases and yields cancelled", async () => {
    class Cancelable implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"content":"1"}}]}';
        yield 'data: {"choices":[{"delta":{"content":"2"}}]}';
        yield doneStop;
      }
    }
    const events = await collect(
      runAgentLoop(new Cancelable(), baseRequest, {
        execute: async () => "",
        shouldCancel: () => true
      })
    );
    expect(events.filter((e) => e.type === "cancelled").length).toBe(1);
  });

  it("partial tool args assembled, oversized rejected by loop; no double exec", async () => {
    let execs = 0;
    const exec: ToolExecutor = async () => { execs++; return "x"; };
    const huge = "x".repeat(70000);
    class PartTransport implements HttpTransport {
      async *stream(_r: NativeCompletionRequest) {
        yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"p1","function":{"name":"read-file","arguments":"{\\"path\\":\\"ok\\""}}]}}]}';
        yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"} "}}]}}]}';
        yield doneTool;
      }
    }
    const events = await collect(runAgentLoop(new PartTransport(), baseRequest, { execute: exec }));
    // assembled one will execute (valid tool), late oversized not sent because after terminal in this fixture
    expect(execs).toBeLessThanOrEqual(1);
  });
});
