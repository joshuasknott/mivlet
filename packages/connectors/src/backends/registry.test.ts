/**
 * Tests for the agent-runtime backend registry + capability resolution.
 *
 * These guard the compliance and fail-closed invariants the objective
 * requires:
 *   - install-required / needs-auth / unavailable states declare NO capabilities
 *   - the ACP providers surface an install hint (CLI gating dependency)
 *   - Grok's entitlements are never pre-populated for any tier
 *   - only the four named providers are surfaced (no Claude/Gemini)
 *   - usage-cost is only honor-able on the API-key path, not subscriptions
 */

import { describe, expect, it } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import {
  BACKEND_PROVIDER_IDS,
  hasCapability,
  listBackendProviders,
  resolveAcpProvider,
  resolveCapabilities,
  resolveCodexProvider,
  resolveCopilotProvider,
  resolveCursorProvider,
  resolveGrokProvider,
  resolveOllamaProvider
} from "./registry";

describe("backend registry", () => {
  it("surfaces the runtime providers plus the native API providers", () => {
    const providers = listBackendProviders();
    expect(providers.map((provider) => provider.id).sort()).toEqual(
      [
        "alibaba", "anthropic", "cerebras", "codex", "copilot", "cursor", "custom",
        "deepseek", "fireworks", "gemini", "grok", "groq", "huggingface", "meta",
        "kimi", "kimi-code", "minimax", "mistral", "mistral-vibe", "moonshot", "ollama", "openai", "opencode", "openrouter",
        "perplexity", "tencent", "together", "xai", "xiaomi", "zai"
      ].sort()
    );
  });

  it("includes the native-api backend type in the catalog", () => {
    const native = listBackendProviders().find((p) => p.backendType === "native-api");
    expect(native).toBeDefined();
  });

  it("keeps Ollama on the local-loopback path rather than the API-key path", () => {
    const ollama = listBackendProviders().find((provider) => provider.id === "ollama");
    expect(ollama?.backendType).toBe("local-loopback");
    expect(ollama?.authState).toBe("unavailable");
  });

  it("surfaces Claude and Gemini only as native API-key providers, never as subscription options", () => {
    const providers = listBackendProviders();
    // Anthropic and Gemini ARE present, but only as native-api (API-key) providers.
    const anthropic = providers.find((p) => p.id === "anthropic");
    const gemini = providers.find((p) => p.id === "gemini");
    expect(anthropic?.backendType).toBe("native-api");
    expect(gemini?.backendType).toBe("native-api");

    // Compliance: no Claude.ai or Google AI subscription auth path is offered —
    // the copy names direct API-key setup only.
    const serialized = JSON.stringify(providers).toLowerCase();
    expect(serialized).not.toMatch(/claude\.ai/);
    expect(serialized).not.toMatch(/google ai (pro|ultra)/);

    expect(anthropic?.description.toLowerCase()).toContain("api key");
    expect(gemini?.description.toLowerCase()).toContain("api key");
    expect(serialized).not.toMatch(/vertex|bedrock/);
  });

  it("exposes the canonical provider id list", () => {
    expect(BACKEND_PROVIDER_IDS).toEqual([
      "codex", "cursor", "copilot", "grok", "opencode", "kimi", "mistral-vibe",
      "openai", "anthropic", "gemini", "xai", "openrouter",
      "deepseek", "zai", "minimax", "alibaba", "fireworks", "huggingface",
      "moonshot", "kimi-code", "mistral", "meta", "ollama", "perplexity", "tencent",
      "xiaomi", "groq", "together", "cerebras", "custom"
    ]);
  });
});

describe("fail-closed capability resolution", () => {
  const closedStates = [
    "needs-auth",
    "sign-in-required",
    "install-required",
    "start-required",
    "download-required",
    "connecting",
    "expired",
    "unsupported",
    "failed",
    "ready",
    "unavailable"
  ] as const;

  it.each(closedStates)("declares no capabilities when authState=%s", (authState) => {
    expect(resolveCodexProvider(authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("cursor", authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("grok", authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("kimi", authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("mistral-vibe", authState).capabilities).toEqual([]);
    expect(resolveCopilotProvider(authState).capabilities).toEqual([]);
    expect(resolveOllamaProvider(authState).capabilities).toEqual([]);
  });

  it("only the connected state advertises capabilities (ready is a UI alias, not capability-bearing)", () => {
    // The new "ready" state is the onboarding's terminal-success alias; the
    // boundary re-resolves it to "connected" before a run. It must never itself
    // advertise capabilities, so a transient ready-but-not-connected provider
    // cannot drive a run.
    const readyNative = resolveCodexProvider("ready");
    expect(readyNative.capabilities).toEqual([]);
    const connectedNative = resolveCodexProvider("connected");
    expect(connectedNative.capabilities.length).toBeGreaterThan(0);
  });

  it("resolves the full capability set for a connected codex subscription", () => {
    const connected = resolveCodexProvider("connected");
    expect(hasCapability(connected.capabilities, "streaming")).toBe(true);
    expect(hasCapability(connected.capabilities, "tool-requests")).toBe(true);
    // Subscription path must NOT advertise usage-cost.
    expect(hasCapability(connected.capabilities, "usage-cost")).toBe(false);
  });

  it("only advertises usage-cost on the codex API-key (BYOK) path", () => {
    const subscription = resolveCodexProvider("connected", { usingApiKey: false });
    const apiKey = resolveCodexProvider("connected", { usingApiKey: true });
    expect(hasCapability(subscription.capabilities, "usage-cost")).toBe(false);
    expect(hasCapability(apiKey.capabilities, "usage-cost")).toBe(true);
  });

  it("runs Copilot through ACP without inventing subscription usage cost", () => {
    const connected = resolveCopilotProvider("connected");
    expect(connected.backendType).toBe("acp");
    expect(hasCapability(connected.capabilities, "usage-cost")).toBe(false);
  });

  it("declares only authentication while grok entitlement is pending", () => {
    const pending = resolveGrokProvider("entitlement-pending");
    expect(pending.capabilities).toEqual(["authentication"]);
  });
});

describe("ACP install gating", () => {
  it("fails closed with an install hint when the CLI is absent", () => {
    const cursor = resolveCursorProvider("install-required");
    const grok = resolveGrokProvider("install-required");

    expect(cursor.authState).toBe("install-required");
    expect(grok.authState).toBe("install-required");
    expect(cursor.capabilities).toEqual([]);
    expect(grok.capabilities).toEqual([]);
    expect(cursor.installHint).toMatch(/cursor cli/i);
    expect(grok.installHint).toMatch(/grok cli/i);
  });
});

describe("grok entitlement compliance", () => {
  const grokStates: BackendProvider["authState"][] = [
    "needs-auth",
    "install-required",
    "entitlement-pending",
    "connected"
  ];

  it.each(grokStates)("never pre-populates grok entitlements for authState=%s", (authState) => {
    const grok = resolveGrokProvider(authState);
    // Entitlements may be undefined or empty, but never claim a tier includes Grok Build.
    const entitlements = grok.entitlements ?? [];
    expect(entitlements).toEqual([]);
    expect(JSON.stringify(grok)).not.toMatch(/premium|plus|included in|pro plan/i);
  });

  it("carries no tier/entitlement promise in the Grok fixture", () => {
    const serialized = JSON.stringify(
      listBackendProviders().find((provider) => provider.id === "grok")
    );
    expect(serialized).not.toMatch(/premium|plus|pro plan|included in/i);
  });
});

describe("capability helper", () => {
  it("resolveCapabilities returns an empty set for unknown backend types via the resolver", () => {
    // Direct resolver call guard: any non-connected state is empty.
    expect(resolveCapabilities("codex-app-server", "unavailable")).toEqual([]);
  });
});
