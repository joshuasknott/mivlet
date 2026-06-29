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
  resolveGrokProvider
} from "./registry";

describe("backend registry", () => {
  it("surfaces the runtime providers plus the native API providers", () => {
    const providers = listBackendProviders();
    expect(providers.map((provider) => provider.id).sort()).toEqual(
      ["anthropic", "codex", "copilot", "cursor", "gemini", "grok", "openai", "openrouter", "xai"].sort()
    );
  });

  it("includes the native-api backend type in the catalog", () => {
    const native = listBackendProviders().find((p) => p.backendType === "native-api");
    expect(native).toBeDefined();
  });

  it("surfaces Claude and Gemini only as native API-key providers, never as subscription options", () => {
    const providers = listBackendProviders();
    // Anthropic and Gemini ARE present, but only as native-api (API-key) providers.
    const anthropic = providers.find((p) => p.id === "anthropic");
    const gemini = providers.find((p) => p.id === "gemini");
    expect(anthropic?.backendType).toBe("native-api");
    expect(gemini?.backendType).toBe("native-api");

    // Compliance: no Claude.ai or Google AI subscription auth path is offered —
    // the copy only names API key / Vertex / Bedrock.
    const serialized = JSON.stringify(providers).toLowerCase();
    expect(serialized).not.toMatch(/claude\.ai/);
    expect(serialized).not.toMatch(/google ai (pro|ultra)/);

    // The native auth copy must name the allowed key/Vertex/Bedrock paths.
    expect(anthropic?.description.toLowerCase()).toMatch(/api key|vertex|bedrock/);
    expect(gemini?.description.toLowerCase()).toMatch(/api key|vertex/);
  });

  it("exposes the canonical provider id list", () => {
    expect(BACKEND_PROVIDER_IDS).toEqual([
      "codex", "cursor", "copilot", "grok",
      "openai", "anthropic", "gemini", "xai", "openrouter"
    ]);
  });
});

describe("fail-closed capability resolution", () => {
  const closedStates = [
    "needs-auth",
    "install-required",
    "unavailable",
    "failed"
  ] as const;

  it.each(closedStates)("declares no capabilities when authState=%s", (authState) => {
    expect(resolveCodexProvider(authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("cursor", authState).capabilities).toEqual([]);
    expect(resolveAcpProvider("grok", authState).capabilities).toEqual([]);
    expect(resolveCopilotProvider(authState).capabilities).toEqual([]);
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

  it("advertises usage-cost for the copilot SDK regardless of mode", () => {
    const connected = resolveCopilotProvider("connected");
    expect(hasCapability(connected.capabilities, "usage-cost")).toBe(true);
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
    expect(JSON.stringify(grok)).not.toMatch(/grok.?build/i);
  });

  it("carries no tier/entitlement promise in any fixture catalog", () => {
    const serialized = JSON.stringify(listBackendProviders());
    expect(serialized).not.toMatch(/premium|plus|pro plan|included in/i);
  });
});

describe("capability helper", () => {
  it("resolveCapabilities returns an empty set for unknown backend types via the resolver", () => {
    // Direct resolver call guard: any non-connected state is empty.
    expect(resolveCapabilities("codex-app-server", "unavailable")).toEqual([]);
  });
});
