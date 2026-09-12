import { describe, expect, it } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import { listBackendProviders } from "../backends/registry";
import { computerVisionUnavailableReason, supportsNativeComputerVision, supportsSharedComputerTools } from "./computer-vision";

describe("computer route availability", () => {
  it.each([['openai', 'gpt-4.1'], ['anthropic', 'claude-sonnet-4-6'], ['xai', 'grok-4']])("allows %s only with both its implemented protocol and model capabilities", (id, modelId) => {
    const provider = { ...listBackendProviders().find(provider => provider.id === id)!, authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const model = { id: modelId, label: modelId, available: true };
    expect(computerVisionUnavailableReason(provider, model)).toBeNull();
    expect(supportsNativeComputerVision(id, { ...model, capabilities: { vision: true, tools: false } })).toBe(false);
    expect(supportsNativeComputerVision(id, { ...model, capabilities: { vision: false, tools: true } })).toBe(false);
    expect(supportsNativeComputerVision(id, { ...model, available: false })).toBe(false);
    expect(supportsNativeComputerVision(id, { ...model, id: 'unknown', capabilities: { vision: true, tools: true } })).toBe(false);
  });

  it("audits every registered route without confusing provider-owned tools with Mivlet tools", () => {
    const providers = listBackendProviders().map(provider => ({ ...provider, authState: "connected", capabilities: ["tool-requests"] } as BackendProvider));
    const vision = { id: "vision", label: "Vision", available: true, capabilities: { vision: true, tools: true } };
    expect(providers.filter(supportsSharedComputerTools).map(p => p.id)).toEqual(["codex", "openai", "anthropic", "xai", "deepseek", "alibaba", "moonshot", "zai", "groq", "together", "fireworks", "cerebras", "mistral", "openrouter", "nvidia", "siliconflow", "cohere", "custom"]);
    for (const id of ["claude", "cursor", "grok", "opencode", "antigravity"]) {
      expect(computerVisionUnavailableReason(providers.find(p => p.id === id), vision)).toMatch(/no Mivlet computer-tool response bridge/);
    }
    expect(computerVisionUnavailableReason(providers.find(p => p.id === "custom"), vision)).toMatch(/metadata alone/);
    // DeepSeek shares Mivlet's tool boundary but has no audited screenshot
    // bridge: vision metadata alone must not enable screenshot control.
    expect(computerVisionUnavailableReason(providers.find(p => p.id === "deepseek"), vision)).toMatch(/metadata alone/);
    expect(supportsNativeComputerVision("deepseek", vision)).toBe(false);
    expect(supportsNativeComputerVision("gemini", { ...vision, id: "gemini-3.5-flash" })).toBe(false);
    expect(computerVisionUnavailableReason(providers.find(p => p.id === "codex"), vision)).toBeNull();
  });
});
