import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, BackendProvider } from "@fable/protocol";
import type { AntigravityAcpEvent, AntigravityAcpHandle, BackendDeps } from "../contract";
import { createAntigravityBackend } from "./antigravity";

const approval: ApprovalRequest = {
  id: "antigravity-call-1",
  service: "antigravity",
  action: "Edit the workspace file",
  mode: "trusted-scope",
  riskLevel: "medium",
  dataUsed: ["file: notes.md"],
  consequence: "Allow Antigravity to edit the workspace file.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "deny"]
};

const provider: BackendProvider = {
  id: "antigravity",
  backendType: "antigravity-acp",
  label: "Google Antigravity",
  description: "ACP",
  authState: "connected",
  capabilities: ["streaming", "tool-requests", "approvals", "cancellation"],
  models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", available: true }]
};

function deps(handle: AntigravityAcpHandle): BackendDeps {
  return {
    createTransport: () => null,
    createAntigravityAcp: () => handle
  };
}

function handle(events: AntigravityAcpEvent[]) {
  const respondApproval = vi.fn(async () => {});
  const value: AntigravityAcpHandle = {
    initialize: vi.fn(async () => {}),
    async *submitTurn() { for (const event of events) yield event; },
    respondApproval,
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {})
  };
  return { value, respondApproval };
}

describe("Antigravity ACP backend", () => {
  it("uses Mivlet's approval-only gate and lets the provider execute exactly once", async () => {
    const fixture = handle([
      { type: "text-delta", text: "Working" },
      { type: "approval-request", requestId: "7", callId: "call-1", tool: "antigravity:edit", arguments: "{}", approval },
      { type: "done", finishReason: "stop" }
    ]);
    const backend = createAntigravityBackend(provider, deps(fixture.value));
    const authorize = vi.fn(async () => {});
    const execute = vi.fn(async () => "must not execute");
    const events = [];
    for await (const event of backend!.run({ model: "gemini-2.5-pro", messages: [], tools: [], maxTokens: 100 }, { execute, authorize })!) events.push(event);
    expect(authorize).toHaveBeenCalledWith(approval);
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.respondApproval).toHaveBeenCalledWith("7", true);
    expect(events).toContainEqual({ type: "tool-result", callId: "call-1", ok: true, output: "Approved for Antigravity to execute once." });
  });

  it("fails closed when the approval-only gate denies the request", async () => {
    const fixture = handle([
      { type: "approval-request", requestId: "8", callId: "call-2", tool: "antigravity:shell", arguments: "{}", approval },
      { type: "done", finishReason: "stop" }
    ]);
    const backend = createAntigravityBackend(provider, deps(fixture.value));
    for await (const _event of backend!.run({ model: "gemini-2.5-pro", messages: [], tools: [], maxTokens: 100 }, { execute: async () => "", authorize: async () => { throw new Error("Denied"); } })!) { /* drain */ }
    expect(fixture.respondApproval).toHaveBeenCalledWith("8", false);
  });
});
