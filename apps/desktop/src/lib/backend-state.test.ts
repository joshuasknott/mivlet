import { describe, expect, it } from "vitest";
import {
  BACKEND_AUTH_FAIL_CLOSED_STATES,
  BACKEND_AUTH_STATE_PARITY,
  BACKEND_AUTH_STATE_VALUES
} from "@fable/protocol";
import type { BackendProvider } from "@fable/protocol";
import {
  actionLabelForProvider,
  authKindForProvider,
  connectResultCopy,
  isFailClosedState,
  modelDiscoveryView,
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

describe("modelDiscoveryView", () => {
  it("reports loading and success as ready/neutral, never danger", () => {
    const loading = modelDiscoveryView("loading");
    expect(loading.tone).toBe("info");
    expect(loading.label).toMatch(/refresh|checking|loading/i);
    const success = modelDiscoveryView("success");
    expect(["ready", "neutral"]).toContain(success.tone);
  });

  it("treats empty as caution and explains it is not an account failure", () => {
    const view = modelDiscoveryView("empty");
    expect(view.tone).toBe("caution");
    expect(view.hint).toBeTruthy();
    // The copy must not claim the key is wrong — empty is an account/catalogue
    // condition, not an auth failure.
    expect(view.hint!.toLowerCase()).not.toContain("key");
  });

  it("treats offline/failed as recoverable runtime states offering retry", () => {
    for (const outcome of ["offline", "failed"] as const) {
      const view = modelDiscoveryView(outcome);
      expect(view.tone).toBe("caution");
      expect(view.hint!.toLowerCase()).toMatch(/retry|refresh|try again/);
      // Never expose an internal stack trace phrasing as a key problem.
      expect(view.hint!.toLowerCase()).not.toContain("stack");
    }
  });

  it("marks unsupported as danger without mentioning the key", () => {
    const view = modelDiscoveryView("unsupported");
    expect(view.tone).toBe("danger");
    expect(view.hint!.toLowerCase()).not.toContain("key");
  });

  it("keeps idle neutral with no hint", () => {
    const view = modelDiscoveryView("idle");
    expect(view.tone).toBe("neutral");
    expect(view.hint).toBeUndefined();
  });

  it("falls closed for unknown outcomes (never ready)", () => {
    expect(modelDiscoveryView("nonsense" as never).tone).not.toBe("ready");
  });
});

describe("connectResultCopy", () => {
  it("distinguishes a missing key from a rejected key", () => {
    // The Rust boundary returns auth-failed for both missing and rejected keys,
    // but a missing key must read as a configuration gap, not a wrong key.
    const missing = connectResultCopy("auth-failed", { missingKey: true });
    expect(missing.message.toLowerCase()).toMatch(/no key|not.*stored|add.*key/);
    expect(missing.message.toLowerCase()).not.toMatch(/reject|invalid|wrong/);

    const rejected = connectResultCopy("auth-failed");
    expect(rejected.message.toLowerCase()).toMatch(/reject|invalid|couldn't verify/);
  });

  it("keeps transient outcomes (offline/failed) retryable and non-alarming", () => {
    const offline = connectResultCopy("offline");
    expect(offline.retryable).toBe(true);
    expect(offline.tone).toBe("caution");
    expect(offline.message.toLowerCase()).not.toContain("key");

    const failed = connectResultCopy("failed");
    expect(failed.retryable).toBe(true);
    expect(failed.tone).toBe("caution");
  });

  it("treats ready as success and unsupported as not-a-key-problem", () => {
    expect(connectResultCopy("ready").tone).toBe("ready");
    const unsupported = connectResultCopy("unsupported");
    expect(unsupported.message.toLowerCase()).not.toContain("key");
  });
});

describe("backend auth-state vocabulary parity", () => {
  it("has no duplicate auth states in the canonical vocabulary list", () => {
    // Guards against the duplicate-`failed` regression drifting back in.
    expect(new Set(BACKEND_AUTH_STATE_VALUES).size).toBe(BACKEND_AUTH_STATE_VALUES.length);
  });

  it("covers every fail-closed state plus connected exactly", () => {
    const expected = new Set([...BACKEND_AUTH_STATE_VALUES]);
    const actual = new Set<string>([...BACKEND_AUTH_FAIL_CLOSED_STATES, "connected"]);
    expect(actual).toEqual(expected);
  });

  it("passes the protocol parity assertion at import time", () => {
    // The self-check runs on load; surfacing it as an explicit assertion keeps
    // a drift caught here rather than only at the Rust boundary.
    expect(BACKEND_AUTH_STATE_PARITY).toBe(true);
  });

  it("matches the Rust boundary's 11 distinct auth states", () => {
    // Mirrors BACKEND_AUTH_STATES in apps/desktop/src-tauri/src/models.rs.
    expect(BACKEND_AUTH_STATE_VALUES).toHaveLength(11);
  });
});
