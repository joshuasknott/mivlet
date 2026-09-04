import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, BackendProvider } from "@fable/protocol";
import type {
  BackendDeps,
  ManagedRuntimeEvent,
  ManagedRuntimeHandle,
} from "../contract";
import { createManagedRuntimeBackend } from "./managed";

const provider: BackendProvider = {
  id: "cursor",
  backendType: "cursor-acp",
  driverKind: "cursor-acp",
  label: "Cursor",
  description: "Cursor ACP",
  authState: "connected",
  capabilities: ["streaming", "tool-requests", "approvals", "cancellation"],
  models: [{ id: "auto", label: "Auto", available: true }],
};

const approval: ApprovalRequest = {
  id: "cursor-call-1",
  service: "cursor",
  action: "Run a command",
  mode: "full-access",
  riskLevel: "high",
  dataUsed: ["command: pnpm test"],
  consequence: "Allow Cursor to run the command once.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "deny"],
};

function fixture(events: ManagedRuntimeEvent[]) {
  const respondApproval = vi.fn(async () => {});
  const runtime: ManagedRuntimeHandle = {
    initialize: vi.fn(async () => {}),
    async *submitTurn() {
      for (const event of events) yield event;
    },
    respondApproval,
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const deps: BackendDeps = {
    createTransport: () => null,
    createManagedRuntime: () => runtime,
  };
  return { deps, respondApproval, runtime };
}

describe("managed provider runtime backend", () => {
  it("streams provider output and marks provider-reported token usage with unknown cost", async () => {
    const setup = fixture([
      { type: "text-delta", text: "Hello from Cursor" },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
      { type: "done", finishReason: "stop" },
    ]);
    const backend = createManagedRuntimeBackend(provider, setup.deps);
    const events = [];
    for await (const event of backend!.run(
      { model: "auto", messages: [], tools: [], maxTokens: 100 },
      { execute: async () => "" },
    )!) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: "text-delta", text: "Hello from Cursor" });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0,
      costUnknown: true,
    });
    expect(setup.runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("routes ACP permission requests through Fable and rejects them when authorization fails", async () => {
    const setup = fixture([
      {
        type: "approval-request",
        requestId: "permission-1",
        callId: "call-1",
        tool: "cursor:execute",
        arguments: "{\"command\":\"pnpm test\"}",
        approval,
      },
      { type: "done", finishReason: "stop" },
    ]);
    const backend = createManagedRuntimeBackend(provider, setup.deps);
    const events = [];
    for await (const event of backend!.run(
      { model: "auto", messages: [], tools: [], maxTokens: 100 },
      {
        execute: async () => "",
        authorize: async () => {
          throw new Error("Denied by user");
        },
      },
    )!) {
      events.push(event);
    }
    expect(setup.respondApproval).toHaveBeenCalledWith("permission-1", false);
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "call-1",
      ok: false,
      output: "Denied by user",
    });
  });

  it("does not replay an approval as a denial when native delivery fails", async () => {
    const setup = fixture([
      {
        type: "approval-request",
        requestId: "permission-1",
        callId: "call-1",
        tool: "cursor:execute",
        arguments: "{}",
        approval,
      },
      { type: "done", finishReason: "stop" },
    ]);
    setup.respondApproval.mockRejectedValueOnce(new Error("delivery failed"));
    const backend = createManagedRuntimeBackend(provider, setup.deps);
    const events = [];
    for await (const event of backend!.run(
      { model: "auto", messages: [], tools: [], maxTokens: 100 },
      {
        execute: async () => "",
        authorize: async () => {},
      },
    )!) {
      events.push(event);
    }
    expect(setup.respondApproval).toHaveBeenCalledTimes(1);
    expect(setup.respondApproval).toHaveBeenCalledWith("permission-1", true);
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "call-1",
      ok: false,
      output: "delivery failed",
    });
  });
});
