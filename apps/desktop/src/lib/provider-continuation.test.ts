import { describe, expect, it } from "vitest";
import type { AgentTurnRequest, BackendProvider } from "@mivlet/protocol";
import { provider, model, continuation } from "../test/provider-continuation-fixtures";
import { applyProviderContinuation, providerContinuationAvailable } from "./provider-continuation";

const request: AgentTurnRequest = { model: "test", messages: [{ role: "system", content: "Current scoped instructions" },
  { role: "user", content: "  My exact new request\n" }], tools: [], maxTokens: 2048 };

describe("provider continuation dispatch", () => {
  it("preserves roles, provenance, order and the exact separate current request", () => {
    const result = applyProviderContinuation(request, continuation, provider, model, "");
    expect(result.messages.map(m => m.role)).toEqual(["system", "user", "user", "assistant", "user"]);
    expect(result.messages[2].content).toContain("message=m1; revision=r1");
    expect(result.messages[3].content).toContain("state=streaming");
    expect(result.messages.at(-1)).toEqual(request.messages.at(-1));
    expect(result.messages.every(m => !m.images && !m.toolCallId)).toBe(true);
    expect(result).not.toHaveProperty("threadId");
    expect(request.messages).toHaveLength(2);
  });
  it("revalidates a smaller model window and keeps the current request on failure", () => {
    const before = JSON.stringify(request);
    expect(() => applyProviderContinuation(request, continuation, provider,
      { ...model, capabilities: { contextWindow: 1000 } }, "")).toThrow(/unchanged/);
    expect(JSON.stringify(request)).toBe(before);
  });
  it("does not reuse stale previous-model telemetry and bounds unknown models", () => {
    const unknown = { ...model, capabilities: {} };
    expect(applyProviderContinuation(request, continuation, provider, unknown, "").messages).toHaveLength(5);
    expect(() => applyProviderContinuation({ ...request, messages: [{ role: "user", content: "x".repeat(100_000) }] },
      continuation, provider, unknown, "")).toThrow();
  });
  it("rejects changed routes, disconnected and unsupported adapters", () => {
    expect(() => applyProviderContinuation(request, continuation, provider, { ...model, id: "other" }, "")).toThrow();
    expect(providerContinuationAvailable({ ...provider, authState: "sign-in-required" })).toBe(false);
    expect(providerContinuationAvailable({ ...provider, backendType: "unknown" as BackendProvider["backendType"] })).toBe(false);
    expect(providerContinuationAvailable({ ...provider, backendType: "claude-agent" })).toBe(true);
  });
});
