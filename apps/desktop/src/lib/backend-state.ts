/**
 * Display model for agent-runtime backend auth states.
 *
 * The state vocabulary (`BackendAuthState`) is owned by the protocol layer;
 * this module is the single source of truth for how each state is *presented*
 * in the onboarding and settings surfaces. It keeps the restrained, plain,
 * non-technical tone: short labels, no jargon, honest about what each state
 * means and what the user can do about it.
 *
 * Two presentation dimensions:
 *   - `authKind` — how a provider takes credentials (api-key vs provider-owned
 *     login vs install-gated). Derived from `backendType`, never stored. This
 *     is what decides whether onboarding shows a key field at all.
 *   - `stateView` — how to render a given auth state (tone, label, action).
 *
 * Secrets are never present here — this operates on `BackendProvider` shapes
 * that carry auth state + capabilities only.
 */

import type { BackendAuthState, BackendProvider, BackendVerifyOutcome } from "@fable/protocol";

/** How a provider authenticates. Determines the onboarding affordance. */
export type BackendAuthKind = "api-key" | "provider-login" | "install-gated";

/**
 * Derive the auth kind from backend type. This is structural, not stored:
 *   - native-api → `api-key` (Fable owns the loop; the user supplies a key)
 *   - codex-app-server / acp / copilot-sdk → `provider-login`
 *
 * `install-gated` is reserved for providers whose runtime is missing
 * (resolved from auth state in `actionForProvider`).
 */
export function authKindForProvider(provider: BackendProvider): BackendAuthKind {
  switch (provider.backendType) {
    case "native-api":
      return "api-key";
    case "local-loopback":
      return "install-gated";
    case "codex-app-server":
    case "acp":
    case "copilot-sdk":
      return "provider-login";
    default:
      return "provider-login";
  }
}

/** The visual tone of a state badge / status note. */
export type BackendStateTone = "ready" | "neutral" | "info" | "caution" | "danger";

export interface BackendStateView {
  /** Short, plain label for the badge (e.g. "Connected", "Install required"). */
  label: string;
  /** Visual tone driving color. */
  tone: BackendStateTone;
  /**
   * A plain, non-technical explanation of what this state means, shown under
   * the provider row when the state is anything other than `connected`.
   */
  hint?: string;
}

/** True for states where the backend cannot serve any request. */
export function isFailClosedState(state: BackendAuthState): boolean {
  return state !== "connected";
}

/**
 * Map an auth state to its display view. Keeps copy in one place so the
 * onboarding and settings surfaces never drift.
 */
export function stateViewFor(state: BackendAuthState): BackendStateView {
  switch (state) {
    case "connected":
      return { label: "Connected", tone: "ready" };
    case "ready":
      // Terminal-success alias the onboarding sets before the boundary
      // re-resolves to "connected". Present it as ready/positive.
      return { label: "Ready", tone: "ready" };
    case "connecting":
      return {
        label: "Connecting",
        tone: "info",
        hint: "Checking the key with the provider…"
      };
    case "sign-in-required":
      return {
        label: "Sign in required",
        tone: "caution",
        hint: "This provider is installed but not signed in. Use its own app to sign in."
      };
    case "install-required":
      return {
        label: "Install required",
        tone: "caution",
        hint: "Install this provider's app or CLI, then come back."
      };
    case "start-required":
      return {
        label: "Start required",
        tone: "caution",
        hint: "The local runtime is installed, but its service is not running."
      };
    case "download-required":
      return {
        label: "Model required",
        tone: "caution",
        hint: "The local runtime is running, but no usable model is installed."
      };
    case "needs-auth":
      return { label: "Not connected", tone: "neutral" };
    case "expired":
      return {
        label: "Expired",
        tone: "danger",
        hint: "This sign-in has expired. Sign in again from the provider."
      };
    case "unsupported":
      return {
        label: "Not supported here",
        tone: "danger",
        hint: "This provider can't be used from this build of Fable."
      };
    case "failed":
      return {
        label: "Couldn't connect",
        tone: "danger",
        hint: "We couldn't reach the provider. Your key is saved — try again in a moment."
      };
    case "entitlement-pending":
      return {
        label: "Checking access",
        tone: "info",
        hint: "Signed in. Confirming what this account can access."
      };
    case "unavailable":
    default:
      return {
        label: "Unavailable",
        tone: "danger",
        hint: "Something went wrong reading this provider's status."
      };
  }
}

/** The single context-correct action label for a provider in onboarding. */
export function actionLabelForProvider(provider: BackendProvider): string {
  const kind = authKindForProvider(provider);
  switch (provider.authState) {
    case "connected":
    case "ready":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "expired":
      return kind === "api-key" ? "Add key again" : "Sign in again";
    case "sign-in-required":
    case "install-required":
      return kind === "install-gated" ? "Install required" : "Set up";
    case "start-required":
      return "Start runtime";
    case "download-required":
      return "Add model";
    case "unsupported":
      return "Not supported";
    case "failed":
      return "Retry";
    default:
      return kind === "api-key" ? "Add API key" : "Set up";
  }
}

/**
 * Whether the provider offers a primary onboarding action the user can take on
 * this screen right now. API-key providers always do; provider-login providers
 * do only when they're already connected (otherwise they route to real setup).
 */
export function canActOnProvider(provider: BackendProvider): boolean {
  if (provider.authState === "connecting") return false;
  if (authKindForProvider(provider) === "api-key") return true;
  // Provider-owned runtimes: no fake connect here. The action is informational
  // (routes to real setup) unless already connected.
  return provider.authState === "connected" || provider.authState === "ready";
}

/** Token set of CSS class modifiers, kept off the hot path. */
export function stateClassFor(state: BackendAuthState): string {
  const tone = stateViewFor(state).tone;
  return `og-provider--${tone}`;
}

/**
 * The per-provider model-discovery lifecycle.
 *
 * This is a *runtime* condition layered on top of a provider's auth state, not
 * a new auth state. A provider can be `connected` (its key verifies) while its
 * model list is any of these — e.g. discovery `failed` means "key is good, we
 * just couldn't fetch the catalogue right now," which is a recoverable runtime
 * problem rather than a credentials problem.
 *
 * `idle` means discovery has not run yet for this provider.
 */
export type ModelDiscoveryOutcome =
  | "idle"
  | "loading"
  | "success"
  | "empty"
  | "offline"
  | "unsupported"
  | "failed";

/**
 * Display view for a provider's model-discovery state. Kept here so the
 * Settings refresh affordance and the connected-but-degraded hint never drift.
 */
export function modelDiscoveryView(
  outcome: ModelDiscoveryOutcome
): BackendStateView {
  switch (outcome) {
    case "loading":
      return {
        label: "Refreshing models",
        tone: "info",
        hint: "Checking which models this account can use…"
      };
    case "success":
      return { label: "Models available", tone: "ready" };
    case "empty":
      return {
        label: "No models found",
        tone: "caution",
        hint:
          "This account surfaced no usable models. Check your plan or billing with the provider."
      };
    case "offline":
      return {
        label: "Models unavailable",
        tone: "caution",
        hint:
          "Couldn't reach the provider to load models. Your key is fine — try refreshing in a moment."
      };
    case "failed":
      return {
        label: "Couldn't load models",
        tone: "caution",
        hint:
          "Model loading failed. Your key is fine — refresh to try again."
      };
    case "unsupported":
      return {
        label: "Model list not supported",
        tone: "danger",
        hint: "This provider doesn't expose a model list. Pick a model manually."
      };
    case "idle":
    default:
      return { label: "Models", tone: "neutral" };
  }
}

/**
 * Whether a discovery outcome should surface the recoverable
 * "connected-but-degraded" treatment: connected key, but we cannot confirm the
 * model list. Used to keep the connected badge honest about runtime health.
 */
export function isDiscoveryDegraded(outcome: ModelDiscoveryOutcome): boolean {
  return (
    outcome === "empty" ||
    outcome === "offline" ||
    outcome === "failed" ||
    outcome === "unsupported"
  );
}

export interface ConnectResultCopy {
  /** User-facing message. Never mentions the raw key value or stack traces. */
  message: string;
  tone: BackendStateTone;
  /** Whether retrying may succeed (false for a rejected/missing key). */
  retryable: boolean;
}

/**
 * Turn a `BackendVerifyResult.outcome` (plus the missing-key flag the boundary
 * raises for a never-stored credential) into user-facing copy.
 *
 * The Rust boundary returns `auth-failed` for both a missing key and a rejected
 * key; `missingKey` distinguishes them so the message reads as a configuration
 * gap ("add a key") rather than a wrong key ("your key was rejected"). Secrets
 * and stack traces are never surfaced.
 */
export function connectResultCopy(
  outcome: BackendVerifyOutcome,
  options: { missingKey?: boolean; detail?: string } = {}
): ConnectResultCopy {
  const detail = options.detail ? ` (${options.detail})` : "";
  switch (outcome) {
    case "ready":
      return {
        message: "Connected and verified.",
        tone: "ready",
        retryable: false
      };
    case "auth-failed":
      // Missing key is a configuration gap, not a wrong key. Rejected key is a
      // wrong/expired credential. Both are non-retryable until the user acts.
      return options.missingKey
        ? {
            message: `No API key stored for this provider yet. Add a key to connect.${detail}`,
            tone: "danger",
            retryable: false
          }
        : {
            message: `The API key was rejected or has expired. Check the key and try again.${detail}`,
            tone: "danger",
            retryable: false
          };
    case "offline":
      return {
        message: `Couldn't reach the provider to confirm the connection. Try again in a moment.${detail}`,
        tone: "caution",
        retryable: true
      };
    case "unsupported":
      return {
        message: `This provider can't be verified from this build of Fable.${detail}`,
        tone: "danger",
        retryable: false
      };
    case "failed":
    default:
      return {
        message: `Couldn't verify the connection right now. Try again in a moment.${detail}`,
        tone: "caution",
        retryable: true
      };
  }
}
