/**
 * Dynamic capability resolution for agent-runtime backends.
 *
 * Capabilities are declared per provider *instance* from its current auth
 * state, never as a static provider flag. An adapter returns exactly the set
 * it can honor; the UI may only render a control for a reported capability.
 *
 * When a backend cannot honor a capability (no CLI installed, entitlement
 * unknown, not authenticated) it declares an empty capability set and surfaces
 * a fail-closed `authState` instead of faking support.
 */

import type {
  BackendAuthState,
  BackendCapability,
  BackendType
} from "@fable/protocol";

/** A capability set that supports `includes` without array copying. */
export type CapabilitySet = readonly BackendCapability[];

const CODEX_SUBSCRIPTION_CAPS: CapabilitySet = [
  "authentication",
  "threads",
  "streaming",
  "tool-requests",
  "approvals",
  "file-changes",
  "model-availability",
  "cancellation"
];

const CODEX_API_KEY_CAPS: CapabilitySet = [
  "authentication",
  "threads",
  "streaming",
  "tool-requests",
  "approvals",
  "file-changes",
  "model-availability",
  "cancellation",
  // usage-cost is only honor-able against metered API keys, not subscriptions.
  "usage-cost"
];

/**
 * Native-API providers declare the full capability set when connected: Fable owns
 * the loop, so it honors streaming, tool-requests + approvals, file-changes,
 * usage-cost (metered against the API key), model-availability, and cancellation.
 */
const NATIVE_API_CAPS: CapabilitySet = [
  "authentication",
  "threads",
  "streaming",
  "tool-requests",
  "approvals",
  "file-changes",
  "usage-cost",
  "model-availability",
  "cancellation"
];

/** Empty set returned for any fail-closed auth state. */
const NO_CAPS: CapabilitySet = [];

/**
 * Resolve the capability set a backend can honor for its `backendType` and
 * current `authState`. Only `connected` yields capabilities; every other state
 * fails closed.
 *
 * @param withUsageCost When true, the resolved set may include `usage-cost`
 *   (used for Codex's BYOK/API-key path). Subscription paths never get it.
 */
export function resolveCapabilities(
  backendType: BackendType,
  authState: BackendAuthState,
  withUsageCost = false
): BackendCapability[] {
  // Fail closed for every state that cannot actually serve requests.
  if (authState !== "connected") {
    return [...NO_CAPS];
  }

  switch (backendType) {
    case "codex-app-server":
      return withUsageCost ? [...CODEX_API_KEY_CAPS] : [...CODEX_SUBSCRIPTION_CAPS];
    case "native-api":
      return [...NATIVE_API_CAPS];
    default:
      return [...NO_CAPS];
  }
}

/** True when the resolved capability set contains the requested capability. */
export function hasCapability(
  capabilities: CapabilitySet,
  capability: BackendCapability
): boolean {
  return capabilities.includes(capability);
}
