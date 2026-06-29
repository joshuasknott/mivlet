/**
 * Provider-specific ACP definitions: Cursor and Grok.
 *
 * This is the ONLY place a concrete provider's executable discovery and
 * capability declarations live. The generic ACP protocol handling
 * (`./acp/*`) never references provider ids — it speaks JSON-RPC over the
 * injected transport. Adding a future ACP provider = one entry in
 * {@link ACP_PROVIDERS}.
 *
 * Compliance invariants:
 *   - No CLI is bundled or redistributed; the executable name is only used to
 *     probe availability through the (Rust-owned) process boundary.
 *   - No subscription token is collected, stored, or passed. Auth is CLI-owned.
 *   - Grok's entitlements stay pending until a real post-login check.
 *   - `usage-cost` is never claimed for a subscription/CLI ACP provider.
 */

import type { AcpProviderId } from "../../backends/fixtures";
import { resolveCapabilities } from "../../backends/capabilities";

/**
 * The outcome of probing a CLI's availability + auth state. The desktop wires
 * this to a dedicated Rust command that runs the provider's status probe (e.g.
 * `cursor agent status`); Fable itself never spawns the process from JS.
 */
export type AcpCliProbeOutcome =
  | "not-installed"
  | "signed-out"
  | "connected"
  | "auth-failed"
  | "unavailable";

/**
 * A probe that runs the provider's CLI to detect install/auth state. Injected
 * so the adapter stays pure and fixture-testable; production wires the Rust
 * boundary, tests inject a scripted fake. Holds no secret.
 */
export type AcpCliProbe = (providerId: AcpProviderId) => Promise<AcpCliProbeOutcome>;

/** A provider's executable discovery spec. */
export interface AcpProviderDefinition {
  /** The CLI executable name (probed for availability; never bundled). */
  executable: string;
  /** Args passed to the executable to probe auth state (no secrets). */
  authProbeArgs: readonly string[];
  /**
   * True for Grok: entitlements are resolved post-login only, never promised
   * for any tier in fixture/preview data.
   */
  entitlementsPending: boolean;
}

/**
 * The ACP provider definitions. Each names a user-installed CLI; Fable probes
 * availability through the Rust boundary and never holds its auth.
 */
export const ACP_PROVIDERS: Record<AcpProviderId, AcpProviderDefinition> = {
  cursor: {
    executable: "cursor",
    authProbeArgs: ["agent", "status"],
    entitlementsPending: false
  },
  grok: {
    executable: "grok",
    authProbeArgs: ["status"],
    entitlementsPending: true
  }
};

/** The detected runtime state for an ACP provider. */
export interface AcpRuntimeDetection {
  providerId: AcpProviderId;
  authState:
    | "connected"
    | "needs-auth"
    | "install-required"
    | "entitlement-pending"
    | "unavailable";
  capabilities: readonly import("@fable/protocol").BackendCapability[];
  entitlementsPending: boolean;
}

/**
 * Detect an ACP provider's runtime state from a CLI probe. Maps the probe
 * outcome to a truthful {@link BackendAuthState} + capability set.
 *
 *   not-installed   → install-required (no capabilities)
 *   signed-out      → needs-auth       (no capabilities)
 *   auth-failed     → unavailable      (no capabilities)
 *   unavailable     → unavailable      (no capabilities)
 *   connected       → connected        (full ACP capability set)
 *
 * For Grok, the connected state still reports `entitlementsPending` until a
 * post-login entitlement check resolves it.
 */
export async function detectAcpRuntime(
  providerId: AcpProviderId,
  probe: AcpCliProbe
): Promise<AcpRuntimeDetection> {
  const definition = ACP_PROVIDERS[providerId];
  if (!definition) {
    throw new Error(`Unknown ACP provider: ${providerId}`);
  }

  const outcome = await probe(providerId);

  switch (outcome) {
    case "not-installed":
      return {
        providerId,
        authState: "install-required",
        capabilities: [],
        entitlementsPending: definition.entitlementsPending
      };
    case "signed-out":
      return {
        providerId,
        authState: "needs-auth",
        capabilities: [],
        entitlementsPending: definition.entitlementsPending
      };
    case "auth-failed":
    case "unavailable":
      return {
        providerId,
        authState: "unavailable",
        capabilities: [],
        entitlementsPending: definition.entitlementsPending
      };
    case "connected":
      return {
        providerId,
        authState: "connected",
        capabilities: resolveCapabilities("acp", "connected"),
        entitlementsPending: definition.entitlementsPending
      };
    default:
      // Unknown probe outcome: fail closed.
      return {
        providerId,
        authState: "unavailable",
        capabilities: [],
        entitlementsPending: definition.entitlementsPending
      };
  }
}
