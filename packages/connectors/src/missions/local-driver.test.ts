import { describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, AgentRunRequest, BackendAgentEvent, BackendProvider } from "@fable/protocol";
import type { Spine } from "@fable/protocol";
import type { AgentBackend } from "../agent-runtime";
import { executeLocalWorker } from "./local-driver";

const provider: BackendProvider = {
  id: "test", backendType: "native-api", label: "Test", description: "Test",
  authState: "connected", capabilities: ["streaming", "cancellation"], models: [{ id: "model", label: "Model", available: true }]
};

function worker(): Spine.Missions.Worker {
  return {
    id: "worker-1" as never, runId: "run-1" as never, workspaceId: "workspace-1" as never,
    visibility: "member-private", ownerMemberId: "member-1" as never, authority: "local",
    schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1" as never,
    createdAt: "t", updatedAt: "t", status: "proposed",
    role: { kind: "specialist", title: "Research", objective: "Research", responsibilities: ["Research"] },
    context: [], capabilityIds: [], capabilityGrantIds: [],
    tools: [{ toolName: "search", access: "read", purpose: "Find evidence", required: true }],
    budget: { maxDurationMs: 60_000, maxInputTokens: 100, maxOutputTokens: 50, maxToolCalls: 2, maxAttempts: 1 },
    stopConditions: [], outputContract: { slots: [], includeEvidence: true, includeUncertainty: true, delivery: "run-result" }
  };
}

function backend(events: readonly BackendAgentEvent[] | null) {
  const cancel = vi.fn(async () => undefined);
  let request: AgentRunRequest | undefined;
  let options: AgentRunOptions | undefined;
  const value: AgentBackend = {
    backend: provider, providerId: provider.id, capabilities: provider.capabilities,
    run(nextRequest, nextOptions) {
      request = nextRequest;
      options = nextOptions;
      if (!events) return null;
      return (async function* () { for (const event of events) yield event; })();
    },
    cancel
  };
  return { value, cancel, get request() { return request; }, get options() { return options; } };
}

const toolSpecs = [{ name: "search", description: "Search", parameters: "{}" }];

describe("portable local worker driver", () => {
  it("runs through the provider-neutral backend with worker budgets", async () => {
    const runtime = backend([
      { type: "text-delta", text: "Evidence" },
      { type: "usage", inputTokens: 20, outputTokens: 4, costUsd: 0.01 },
      { type: "done", finishReason: "stop" }
    ]);
    const outcome = await executeLocalWorker({ worker: worker(), backend: runtime.value, model: "model", prompt: "Research", toolSpecs, execute: vi.fn() });
    expect(outcome).toMatchObject({ status: "completed", text: "Evidence", usage: { inputTokens: 20, outputTokens: 4, toolCalls: 0 } });
    expect(runtime.request).toMatchObject({ model: "model", maxTokens: 50, tools: toolSpecs });
    expect(runtime.options).toMatchObject({ runId: "run-1", maxTurns: 1, maxToolCalls: 2 });
  });

  it("fails closed when transport or exact bounded tools are unavailable", async () => {
    const unavailable = backend(null);
    await expect(executeLocalWorker({ worker: worker(), backend: unavailable.value, model: "model", prompt: "Research", toolSpecs, execute: vi.fn() }))
      .resolves.toMatchObject({ status: "failed", retryable: true, reason: expect.stringContaining("no local execution transport") });
    await expect(executeLocalWorker({ worker: worker(), backend: unavailable.value, model: "model", prompt: "Research", toolSpecs: [], execute: vi.fn() }))
      .rejects.toThrow("exactly match");
  });

  it("cancels at the backend boundary and preserves a partial result on budget overrun", async () => {
    const runtime = backend([
      { type: "text-delta", text: "Partial" },
      { type: "usage", inputTokens: 20, outputTokens: 60, costUsd: 0.02 },
      { type: "done", finishReason: "stop" }
    ]);
    const outcome = await executeLocalWorker({ worker: worker(), backend: runtime.value, model: "model", prompt: "Research", toolSpecs, execute: vi.fn() });
    expect(outcome).toMatchObject({ status: "partially-completed", text: "Partial", reason: expect.stringContaining("output-token budget") });
    expect(runtime.cancel).toHaveBeenCalledWith("run-1");
  });

  it("surfaces retryable backend errors without discarding streamed work", async () => {
    const runtime = backend([{ type: "text-delta", text: "Partial" }, { type: "error", message: "Offline", code: "offline", retryable: true }]);
    await expect(executeLocalWorker({ worker: worker(), backend: runtime.value, model: "model", prompt: "Research", toolSpecs, execute: vi.fn() }))
      .resolves.toMatchObject({ status: "partially-completed", text: "Partial", reason: "Offline", retryable: true });
  });

  it("cancels a backend that exceeds the worker duration budget", async () => {
    const cancel = vi.fn(async () => undefined);
    const hanging: AgentBackend = {
      backend: provider, providerId: provider.id, capabilities: provider.capabilities, cancel,
      run: () => (async function* () {
        await new Promise(() => undefined);
        yield { type: "done", finishReason: "stop" } as const;
      })()
    };
    await expect(executeLocalWorker({
      worker: { ...worker(), budget: { ...worker().budget, maxDurationMs: 5 } },
      backend: hanging, model: "model", prompt: "Research", toolSpecs, execute: vi.fn()
    })).resolves.toMatchObject({ status: "failed", reason: expect.stringContaining("duration budget") });
    expect(cancel).toHaveBeenCalledWith("run-1");
  });

  it("carries only an exact objective-only native mission binding", async () => {
    const runtime = backend([{ type: "done", finishReason: "stop" }]);
    const missionWorkerExecution = {
      runId: "run-1", workerId: "worker-1", workerStartedEventId: "event-3", usageEventId: "event-usage",
      completionEventId: "event-4", failureEventId: "event-5", idempotencyKey: "terminal-1",
      expectedRunRevision: 4, expectedLastSequence: 3
    };
    await executeLocalWorker({ worker: { ...worker(), tools: [] }, backend: runtime.value,
      model: "model", prompt: "Research", toolSpecs: [], execute: vi.fn(), missionWorkerExecution });
    expect(runtime.request).toMatchObject({ missionWorkerExecution });
    await expect(executeLocalWorker({ worker: { ...worker(), tools: [] }, backend: runtime.value,
      model: "model", prompt: "Different", toolSpecs: [], execute: vi.fn(), missionWorkerExecution }))
      .rejects.toThrow("exact worker objective");
  });

  it("binds the persisted Markdown output contract into the native prompt", async () => {
    const runtime = backend([{ type: "text-delta", text: "# Brief" }, { type: "done", finishReason: "stop" }]);
    const missionWorkerExecution = {
      runId: "run-1", workerId: "worker-1", workerStartedEventId: "event-3", usageEventId: "event-usage",
      completionEventId: "event-4", failureEventId: "event-5", idempotencyKey: "terminal-1",
      expectedRunRevision: 4, expectedLastSequence: 3
    };
    const outputWorker = { ...worker(), tools: [], outputContract: {
      slots: [{ key: "brief", description: "A trustworthy brief", required: true, format: "text/markdown" }],
      includeEvidence: false, includeUncertainty: true, delivery: "run-result" as const
    } };
    await executeLocalWorker({ worker: outputWorker, backend: runtime.value, model: "model",
      prompt: "Research", toolSpecs: [], execute: vi.fn(), missionWorkerExecution });
    expect(runtime.request?.messages).toEqual([{ role: "user", content:
      "Objective:\nResearch\n\nRequired output (brief; text/markdown):\nA trustworthy brief\n\nReturn one Markdown result only.\nState material uncertainty explicitly in the Markdown result." }]);
  });
});
