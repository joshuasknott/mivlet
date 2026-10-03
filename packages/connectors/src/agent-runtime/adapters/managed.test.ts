import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, BackendProvider } from "@mivlet/protocol";
import type {
  BackendDeps,
  ManagedRuntimeEvent,
  ManagedRuntimeHandle,
} from "../contract";
import { createManagedRuntimeBackend } from "./managed";
import { registeredToolSpecs } from "../../native-api/tools";

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
  it("executes shared tools through Mivlet and returns the actual result to Claude", async () => {
    const call = { type: "tool-request", requestId: "rpc-1", callId: "call-1",
      approvalId: "native-opaque", tool: "read-file", arguments: '{"path":"report.md"}' } as const;
    const setup = fixture([call, { type: "done", finishReason: "stop" }]);
    const respondTool = vi.fn(async () => {});
    setup.runtime.respondTool = respondTool;
    const execute = vi.fn(async () => "actual file contents");
    const backend = createManagedRuntimeBackend({ ...provider, id: "claude",
      backendType: "claude-agent", driverKind: "claude-agent" }, setup.deps)!;
    const events = [];
    for await (const event of backend.run({ model: "auto", messages: [],
      tools: registeredToolSpecs().filter(tool => tool.name === "read-file"), maxTokens: 100 },
      { execute, permissionMode: "read-only" })!) events.push(event);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      id: "native-opaque", mode: "read-only", dataUsed: ["path: report.md"],
    }), call.arguments);
    expect(respondTool).toHaveBeenCalledWith("rpc-1", {
      callId: "call-1", ok: true, output: "actual file contents",
    });
    expect(events).toContainEqual({ type: "tool-result",
      callId: "call-1", ok: true, output: "actual file contents" });
    expect(setup.respondApproval).not.toHaveBeenCalled();
  });

  it.each(["write-file", "invented"])("denies %s without executing or substituting provider tools", async tool => {
    const setup = fixture([{ type: "tool-request", requestId: "rpc-1", callId: "call-1",
      approvalId: "native-opaque", tool, arguments: '{"path":"report.md","content":"change"}' }]);
    const respondTool = vi.fn(async () => {});
    setup.runtime.respondTool = respondTool;
    const execute = vi.fn(async () => "should not run");
    const backend = createManagedRuntimeBackend(provider, setup.deps)!;
    for await (const _event of backend.run({ model: "auto", messages: [],
      tools: registeredToolSpecs(), maxTokens: 100 }, { execute, permissionMode: "read-only" })!) { /* drain */ }
    expect(execute).not.toHaveBeenCalled();
    expect(respondTool).toHaveBeenCalledWith("rpc-1", expect.objectContaining({ ok: false }));
  });

  it("does not repeat a completed shared effect or respond twice after delivery fails", async () => {
    const setup = fixture([{ type: "tool-request", requestId: "rpc-1", callId: "call-1",
      approvalId: "native-opaque", tool: "read-file", arguments: '{"path":"report.md"}' }]);
    const respondTool = vi.fn(async () => { throw new Error("transport closed"); });
    setup.runtime.respondTool = respondTool;
    const execute = vi.fn(async () => "completed");
    const backend = createManagedRuntimeBackend(provider, setup.deps)!;
    const events = [];
    for await (const event of backend.run({ model: "auto", messages: [],
      tools: registeredToolSpecs(), maxTokens: 100 }, { execute })!) events.push(event);
    expect(execute).toHaveBeenCalledOnce();
    expect(respondTool).toHaveBeenCalledOnce();
    expect(setup.runtime.cancel).toHaveBeenCalledOnce();
    expect(events.some(event => event.type === "error")).toBe(true);
    expect(setup.runtime.shutdown).toHaveBeenCalledOnce();
  });
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

  it("routes ACP permission requests through Mivlet and rejects them when authorization fails", async () => {
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
