import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type {
  BackendAgentEvent,
  KnowledgeSource,
  NativeCompletionRequest
} from "@mivlet/protocol";
import { searchKnowledgeSources } from "./knowledge-search";
import { SequencedFixtureTransport } from "./native-api/transport";
import { runAgentLoop, type ToolExecutor } from "./native-api/agent-loop";

function timed<T>(label: string, fn: () => T): { value: T; durationMs: number } {
  const start = performance.now();
  const value = fn();
  const durationMs = performance.now() - start;
  expect(durationMs, `${label} took ${Math.round(durationMs)} ms`).toBeLessThan(2_500);
  return { value, durationMs };
}

function sources(count: number): KnowledgeSource[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `source-${index}`,
    title: index % 10 === 0 ? `Release connector note ${index}` : `Workspace note ${index}`,
    kind: "document",
    connectorId: "local-files",
    provenance: `fixture://source/${index}`,
    freshness: index < 20 ? "just now" : "2026-06-01",
    pinned: index === 10,
    trust: "untrusted",
    contentPreview:
      index % 10 === 0
        ? "Connector rollout approval boundaries, OAuth setup, and local-first storage notes."
        : "General local workspace note with no matching connector content."
  }));
}

async function collect(iterable: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("performance baseline guardrails", () => {
  it("searches synthetic knowledge sources without scanning secrets or live services", () => {
    const { value } = timed("knowledge fixture search", () =>
      searchKnowledgeSources("connector approval", sources(2_000), { limit: 8, budgetChars: 2_400 })
    );

    expect(value.citations).toHaveLength(8);
    expect(value.citations[0].title).toMatch(/connector/i);
  });

  it("runs a multi-turn native provider loop from fixture streams", async () => {
    const request: NativeCompletionRequest = {
      providerId: "openai",
      model: "gpt-5",
      messages: [{ role: "user", content: "Read README.md and summarize." }],
      tools: [],
      maxTokens: 1024
    };
    const toolTurn =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\ndata: {"choices":[{"finish_reason":"tool_calls"}]}';
    const doneTurn =
      'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}';
    const execute: ToolExecutor = async () => "Mivlet README fixture content";

    const start = performance.now();
    const events = await collect(
      runAgentLoop(SequencedFixtureTransport.fromTexts([toolTurn, doneTurn]), request, {
        execute,
        runId: "perf-fixture"
      })
    );
    const durationMs = performance.now() - start;

    expect(durationMs, `native fixture loop took ${Math.round(durationMs)} ms`).toBeLessThan(1_000);
    expect(events.some((event) => event.type === "tool-call")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });
});
