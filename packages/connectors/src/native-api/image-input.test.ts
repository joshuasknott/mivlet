import { describe, expect, it } from "vitest";
import { listBackendProviders } from "../backends/registry";
import type { BackendProvider } from "@mivlet/protocol";
import { computerVisionUnavailableReason, supportsUserImageInput } from "./computer-vision";

describe("transient composer image routes", () => {
  const provider = { ...listBackendProviders().find(provider => provider.id === "claude")!,
    authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
  const model = { id: "sonnet", label: "Sonnet", available: true };
  it.each(["sonnet", "opus", "haiku"])("admits the official Claude %s alias without granting screenshot tools", id => {
    expect(supportsUserImageInput(provider, { ...model, id })).toBe(true);
    expect(computerVisionUnavailableReason(provider, { ...model, id })).toMatch(/no audited native screenshot/);
  });
  it("refuses disconnected, unavailable, incompatible and unknown routes/models", () => {
    expect(supportsUserImageInput({ ...provider, authState: "unavailable" }, model)).toBe(false);
    expect(supportsUserImageInput(provider, { ...model, available: false })).toBe(false);
    expect(supportsUserImageInput(provider, { ...model, id: "unknown", capabilities: { vision: true } })).toBe(false);
    expect(supportsUserImageInput(provider, { ...model, capabilities: { vision: false } })).toBe(false);
    expect(supportsUserImageInput({ ...provider, driverKind: "cursor-acp" }, model)).toBe(false);
    for (const route of listBackendProviders().filter(route => !["codex", "claude"].includes(route.id))) {
      expect(supportsUserImageInput({ ...route, authState: "connected" }, { ...model, capabilities: { vision: true } })).toBe(false);
    }
    const codex = { ...provider, backendType: "codex-app-server", driverKind: "codex" } as BackendProvider;
    expect(supportsUserImageInput(codex, { ...model, capabilities: { vision: true } })).toBe(true);
    expect(supportsUserImageInput(codex, model)).toBe(false);
  });
});
