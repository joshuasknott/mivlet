/**
 * Direct Gemini API-key route: provider registration, truthful availability,
 * and the boundary between the Gemini API key route and Antigravity account
 * authentication. The Gemini wire shaper/parser fixtures live in
 * `native-api/gemini.test.ts`; this file owns the catalogue admission.
 */

import { describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_IDS,
  listBackendProviders,
  providerDriverForInstance,
  resolveNativeProvider,
} from "./registry";
import { resolveAntigravityProvider } from "./antigravity";

describe("direct Gemini provider registration", () => {
  it("registers one native-api driver grouped under the Google family", () => {
    const driver = providerDriverForInstance("gemini");
    expect(driver).toBeDefined();
    expect(driver?.driverKind).toBe("native-api");
    expect(driver?.category).toBe("api");
    expect(driver?.familyId).toBe("antigravity");
    expect(BACKEND_PROVIDER_IDS).toContain("gemini");
  });

  it("starts disconnected with no capabilities or available models", () => {
    const provider = resolveNativeProvider("gemini", "needs-auth");
    expect(provider.id).toBe("gemini");
    expect(provider.instanceId).toBe("gemini");
    expect(provider.driverKind).toBe("native-api");
    expect(provider.backendType).toBe("native-api");
    expect(provider.authState).toBe("needs-auth");
    expect(provider.capabilities).toEqual([]);
    expect(provider.models.every((model) => !model.available)).toBe(true);
    expect(provider.setup).toMatchObject({
      kind: "api-key",
      label: "Gemini API key",
      recommended: false,
    });
  });

  it("advertises the full native capability set only after connection", () => {
    const connected = resolveNativeProvider("gemini", "connected");
    expect(connected.authState).toBe("connected");
    expect(connected.capabilities).toEqual(
      expect.arrayContaining([
        "authentication",
        "streaming",
        "tool-requests",
        "approvals",
        "usage-cost",
        "model-availability",
        "cancellation",
      ]),
    );
    expect(connected.models.every((model) => model.available)).toBe(true);
  });

  it("ships only officially current curated model ids", () => {
    const provider = resolveNativeProvider("gemini", "connected");
    const ids = provider.models.map((model) => model.id);
    // gemini-3.5-flash (GA 2026-05-19) and gemini-2.5-pro (stable) are the
    // current docs pair; live discovery may surface more.
    expect(ids).toContain("gemini-3.5-flash");
    expect(ids).toContain("gemini-2.5-pro");
  });

  it("keeps the Gemini API-key route distinct from Antigravity account auth", () => {
    const gemini = resolveNativeProvider("gemini", "connected");
    const antigravity = resolveAntigravityProvider("connected");
    expect(gemini.driverKind).not.toBe(antigravity.driverKind);
    expect(gemini.backendType).not.toBe(antigravity.backendType);
    expect(gemini.setup?.kind).toBe("api-key");
    expect(antigravity.setup?.kind).toBe("browser");
    expect(gemini.installHint).toBeUndefined();
    expect(antigravity.installHint).toBeDefined();
  });

  it("appears in the built-in catalogue once, fail closed by default", () => {
    const providers = listBackendProviders();
    const matches = providers.filter((provider) => provider.id === "gemini");
    expect(matches).toHaveLength(1);
    expect(matches[0].authState).toBe("needs-auth");
  });
});
