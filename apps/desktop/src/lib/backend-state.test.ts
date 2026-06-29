import { describe, expect, it } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import {
  actionLabelForProvider,
  authKindForProvider,
  isFailClosedState,
  stateClassFor,
  stateViewFor
} from "./backend-state";

const nativeProvider = (over: Partial<BackendProvider> = {}): BackendProvider => ({
  id: "openai",
  backendType: "native-api",
  label: "OpenAI",
  description: "OpenAI native",
  authState: "needs-auth",
  capabilities: [],
  models: [],
  ...over
});

const codexProvider = (over: Partial<BackendProvider> = {}): BackendProvider => ({
  id: "codex",
  backendType: "codex-app-server",
  label: "Codex",
  description: "Codex app-server",
  authState: "install-required",
  capabilities: [],
  models: [],
  ...over
});

describe("authKindForProvider", () => {
  it("classifies native-api providers as api-key", () => {
    expect(authKindForProvider(nativeProvider())).toBe("api-key");
  });

  it("classifies provider-owned runtimes as provider-login (never api-key)", () => {
    expect(authKindForProvider(codexProvider())).toBe("provider-login");
    expect(
      authKindForProvider(nativeProvider({ id: "cursor", backendType: "acp" }))
    ).toBe("provider-login");
    expect(
      authKindForProvider(nativeProvider({ id: "copilot", backendType: "copilot-sdk" }))
    ).toBe("provider-login");
  });
});

describe("stateViewFor", () => {
  it("marks only connected/ready as the ready (positive) tone", () => {
    expect(stateViewFor("connected").tone).toBe("ready");
    expect(stateViewFor("ready").tone).toBe("ready");
  });

  it("gives install-required a caution tone and plain hint", () => {
    const view = stateViewFor("install-required");
    expect(view.tone).toBe("caution");
    expect(view.label).toMatch(/install/i);
    expect(view.hint).toBeTruthy();
  });

  it("gives the transient/error states danger or info tones, never ready", () => {
    expect(stateViewFor("failed").tone).toBe("danger");
    expect(stateViewFor("expired").tone).toBe("danger");
    expect(stateViewFor("unsupported").tone).toBe("danger");
    expect(stateViewFor("sign-in-required").tone).toBe("caution");
    expect(stateViewFor("connecting").tone).toBe("info");
  });

  it("falls closed for unknown states (never ready)", () => {
    // The vocabulary is closed; an unexpected string must not masquerade as ready.
    expect(stateViewFor("unavailable" as never).tone).not.toBe("ready");
    expect(stateViewFor("nonsense" as never).tone).not.toBe("ready");
  });
});

describe("isFailClosedState", () => {
  it("treats every state except connected as fail-closed", () => {
    expect(isFailClosedState("connected")).toBe(false);
    for (const state of [
      "needs-auth",
      "sign-in-required",
      "install-required",
      "connecting",
      "expired",
      "unsupported",
      "failed",
      "ready",
      "entitlement-pending",
      "unavailable"
    ] as const) {
      expect(isFailClosedState(state)).toBe(true);
    }
  });
});

describe("actionLabelForProvider", () => {
  it("offers 'Add API key' for an unconnected native provider", () => {
    expect(actionLabelForProvider(nativeProvider({ authState: "needs-auth" }))).toBe(
      "Add API key"
    );
  });

  it("never offers an api-key action for provider-owned runtimes", () => {
    // Provider-owned runtimes route to real setup; the label must not imply a
    // key field is available.
    const label = actionLabelForProvider(codexProvider({ authState: "install-required" }));
    expect(label.toLowerCase()).not.toContain("api key");
  });

  it("shows Connected once a provider is connected", () => {
    expect(actionLabelForProvider(nativeProvider({ authState: "connected" }))).toBe("Connected");
  });
});

describe("stateClassFor", () => {
  it("emits a tone modifier class for each state", () => {
    expect(stateClassFor("connected")).toBe("og-provider--ready");
    expect(stateClassFor("install-required")).toBe("og-provider--caution");
    expect(stateClassFor("failed")).toBe("og-provider--danger");
  });
});
