import { describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_IDS,
  listBackendProviders,
  resolveCodexProvider,
  resolveNativeProvider
} from "./registry";

describe("provider registry", () => {
  it("exposes only the current browser, direct-key, and custom providers", () => {
    expect(BACKEND_PROVIDER_IDS).toEqual([
      "codex",
      "openai",
      "anthropic",
      "gemini",
      "xai",
      "custom"
    ]);
    expect(listBackendProviders().map((provider) => provider.id)).toEqual(
      BACKEND_PROVIDER_IDS
    );
  });

  it("starts every provider disconnected and fail closed", () => {
    for (const provider of listBackendProviders()) {
      expect(provider.authState).toBe("needs-auth");
      expect(provider.capabilities).toEqual([]);
      expect(provider.models.every((model) => !model.available)).toBe(true);
    }
  });

  it("enables the native capability boundary only after connection", () => {
    const connected = resolveNativeProvider("xai", "connected");
    expect(connected.capabilities).toContain("streaming");
    expect(connected.capabilities).toContain("approvals");
  });

  it("keeps Codex browser sign-in separate from metered API credentials", () => {
    expect(resolveCodexProvider("connected").capabilities).not.toContain("usage-cost");
    expect(resolveCodexProvider("connected", { usingApiKey: true }).capabilities)
      .toContain("usage-cost");
  });
});
