import { describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_IDS,
  listBackendProviders,
  resolveCodexProvider,
  resolveNativeProvider,
} from "./registry";

describe("provider registry", () => {
  it("exposes the account-first lineup plus direct-key and custom fallbacks", () => {
    expect(BACKEND_PROVIDER_IDS).toEqual([
      "codex",
      "openai",
      "claude",
      "anthropic",
      "antigravity",
      "grok",
      "xai",
      "deepseek",
      "openrouter",
      "cursor",
      "opencode",
      "custom",
    ]);
    expect(listBackendProviders().map((provider) => provider.id)).toEqual(
      BACKEND_PROVIDER_IDS,
    );
  });

  it("starts every provider disconnected and fail closed", () => {
    for (const provider of listBackendProviders()) {
      expect(provider.authState).toBe(
        ["antigravity", "claude", "grok", "cursor", "opencode"].includes(
          provider.id,
        )
          ? "install-required"
          : "needs-auth",
      );
      expect(provider.capabilities).toEqual([]);
      expect(provider.models.every((model) => !model.available)).toBe(true);
      expect(provider.instanceId).toBe(provider.id);
      expect(provider.driverKind).toBeTruthy();
      expect(provider.setup).toBeTruthy();
    }
  });

  it("enables the native capability boundary only after connection", () => {
    const connected = resolveNativeProvider("xai", "connected");
    expect(connected.capabilities).toContain("streaming");
    expect(connected.capabilities).toContain("approvals");
  });

  it("keeps Codex browser sign-in separate from metered API credentials", () => {
    expect(resolveCodexProvider("connected").capabilities).not.toContain(
      "usage-cost",
    );
    expect(
      resolveCodexProvider("connected", { usingApiKey: true }).capabilities,
    ).toContain("usage-cost");
  });
});
