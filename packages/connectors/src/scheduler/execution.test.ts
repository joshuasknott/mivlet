import { describe, expect, it } from "vitest";
import type {
  AgentRunOptions,
  AgentRunRequest,
  BackendAgentEvent,
  BackendProvider,
  PermissionMode,
  ScheduledExecutionRoute
} from "@fable/protocol";
import type { AgentBackend } from "../agent-runtime";
import { executeScheduledPrompt } from "./execution";

/** A fake backend whose stream yields a scripted sequence of events. */
function fakeBackend(
  providerId: string,
  events: BackendAgentEvent[],
  opts: { runReturnsNull?: boolean } = {}
): AgentBackend {
  return {
    backend: {} as BackendProvider,
    providerId,
    capabilities: ["streaming"],
    run(_request: AgentRunRequest, _options: AgentRunOptions): AsyncIterable<BackendAgentEvent> | null {
      if (opts.runReturnsNull) return null;
      async function* gen(): AsyncIterable<BackendAgentEvent> {
        for (const event of events) yield event;
      }
      return gen();
    },
    async cancel() {},
    async listModels() {
      return { outcome: "unsupported", models: [], message: "stub" };
    }
  };
}

function connectedProvider(id = "openai"): BackendProvider {
  return {
    id,
    backendType: "native-api",
    label: "OpenAI",
    description: "",
    authState: "connected",
    capabilities: ["streaming"],
    models: [{ id: "gpt-4", label: "GPT-4", available: true }]
  };
}

const pinnedRoute = (backendId = "openai"): ScheduledExecutionRoute => ({
  policy: "pinned",
  backendId,
  modelId: "gpt-4",
  permissionMode: "trusted-scope" as PermissionMode,
  permissionProfile: "trusted"
});

const baseInput = {
  prompt: "Summarize the week.",
  maxTokens: 512,
  execute: (async () => "ok") as never,
  route: pinnedRoute()
};

describe("executeScheduledPrompt", () => {
  it("returns completed when the stream ends with done", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-1",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world." },
        { type: "done", finishReason: "stop" }
      ])
    });
    expect(result).toEqual({ status: "completed", transcript: "Hello world." });
  });

  it("returns completed when the stream ends without an explicit done", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-2",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [{ type: "text-delta", text: "done" }])
    });
    expect(result).toEqual({ status: "completed", transcript: "done" });
  });

  it("returns cancelled on a cancelled event", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-3",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        { type: "text-delta", text: "partial" },
        { type: "cancelled" }
      ])
    });
    expect(result.status).toBe("cancelled");
  });

  it("returns blocked-auth on an authentication error event", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-4",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        { type: "error", message: "API key invalid", code: "authentication" }
      ])
    });
    expect(result).toEqual({
      status: "blocked-auth",
      error: "API key invalid",
      code: "authentication"
    });
  });

  it("returns failed (retryable) on a transient error event", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-5",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        { type: "error", message: "503 busy", code: "rate-limited", retryable: true }
      ])
    });
    expect(result).toEqual({
      status: "failed",
      error: "503 busy",
      code: "rate-limited",
      retryable: true
    });
  });

  it("returns failed (not retryable) on a permanent error event", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-6",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        { type: "error", message: "bad model", code: "model-unavailable", retryable: false }
      ])
    });
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ retryable: false });
  });

  it("returns blocked-auth when no provider is connected", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-7",
      provider: undefined,
      backend: null
    });
    expect(result.status).toBe("blocked-auth");
  });

  it("fails closed when the captured route is read-only", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      route: {
        policy: "pinned",
        backendId: "openai",
        modelId: "gpt-4",
        permissionMode: "read-only" as PermissionMode,
        permissionProfile: "read-only"
      },
      runId: "run-read-only",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [{ type: "done", finishReason: "stop" }])
    });
    expect(result).toMatchObject({ status: "failed", code: "permission-denied", retryable: false });
  });

  it("fails closed when the route is undefined, defaulting to read-only", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      route: undefined,
      runId: "run-undefined-route",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [{ type: "done", finishReason: "stop" }])
    });
    expect(result).toMatchObject({ status: "failed", code: "permission-denied", retryable: false });
    expect((result as any).error).toContain("does not allow scheduled execution");
  });

  it("returns failed (backend-unavailable) when run() yields null", async () => {
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-8",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [], { runReturnsNull: true })
    });
    expect(result).toMatchObject({ status: "failed", code: "backend-unavailable", retryable: true });
  });

  it("returns failed when the stream throws", async () => {
    const throwing: AgentBackend = {
      backend: {} as BackendProvider,
      providerId: "openai",
      capabilities: ["streaming"],
      run(): AsyncIterable<BackendAgentEvent> | null {
        async function* gen(): AsyncIterable<BackendAgentEvent> {
          yield { type: "text-delta", text: "x" };
          throw Object.assign(new Error("boom"), { code: "backend-failed", retryable: true });
        }
        return gen();
      },
      async cancel() {},
      async listModels() {
        return { outcome: "unsupported", models: [], message: "stub" };
      }
    };
    const result = await executeScheduledPrompt({
      ...baseInput,
      runId: "run-9",
      provider: connectedProvider(),
      backend: throwing
    });
    expect(result).toEqual({
      status: "failed",
      error: "boom",
      code: "backend-failed",
      retryable: true
    });
  });

  it("surfaces tool-call events to onToolCall", async () => {
    const seen: string[] = [];
    await executeScheduledPrompt({
      ...baseInput,
      runId: "run-10",
      provider: connectedProvider(),
      backend: fakeBackend("openai", [
        {
          type: "tool-call",
          callId: "c1",
          tool: "search",
          arguments: "{}",
          approval: {
            id: "a1",
            service: "fable",
            action: "search",
            mode: "read-only",
            riskLevel: "low",
            consequence: "Reads search results.",
            dataUsed: [],
            decisions: ["once"],
            requestedAt: "0"
          }
        },
        { type: "done", finishReason: "stop" }
      ]),
      onToolCall: (event) => seen.push(event.tool)
    });
    expect(seen).toEqual(["search"]);
  });
});
