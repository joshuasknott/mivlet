/**
 * Frontend helpers for agent-runtime backend capabilities.
 *
 * The UI may only render a control for a capability the adapter actually
 * declared. These helpers keep that rule in one place and map capabilities to
 * the UI affordances they unlock. Secrets are never present here — this
 * operates on `BackendProvider.capabilities` (auth state + caps only).
 */

import type { BackendCapability, BackendProvider } from "@arden/protocol";
import { hasCapability } from "@arden/connectors";

/** True when the provider declares the requested capability. */
export function providerHasCapability(
  provider: BackendProvider,
  capability: BackendCapability
): boolean {
  return hasCapability(provider.capabilities, capability);
}

/** Providers that are usable (connected and declaring at least one capability). */
export function usableBackends(providers: BackendProvider[]): BackendProvider[] {
  return providers.filter(
    (provider) => provider.authState === "connected" && provider.capabilities.length > 0
  );
}

/** True when at least one provider is connected and capable. */
export function hasConnectedBackend(providers: BackendProvider[]): boolean {
  return usableBackends(providers).length > 0;
}

/**
 * Map a capability to a short human label for the connectors/onboarding UI.
 * Returns undefined for capabilities that have no first-class affordance.
 */
export function capabilityLabel(capability: BackendCapability): string | undefined {
  switch (capability) {
    case "threads":
      return "Threads";
    case "streaming":
      return "Streaming";
    case "tool-requests":
      return "Tool requests";
    case "approvals":
      return "Approvals";
    case "file-changes":
      return "File changes";
    case "usage-cost":
      return "Usage & cost";
    case "model-availability":
      return "Model selection";
    case "cancellation":
      return "Cancel runs";
    case "authentication":
      return undefined;
    default:
      return undefined;
  }
}

/** The capability affordances to surface for a provider (label-bearing ones). */
export function providerCapabilityLabels(provider: BackendProvider): string[] {
  return provider.capabilities
    .map(capabilityLabel)
    .filter((label): label is string => Boolean(label));
}
