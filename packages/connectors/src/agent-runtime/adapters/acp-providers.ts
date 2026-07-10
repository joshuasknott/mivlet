/**
 * Provider-specific ACP executable definitions.
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
  /** Allowed CLI executable names, in discovery order (never bundled). */
  executableCandidates: readonly string[];
  /** Mandatory arguments used every time the ACP server is launched. */
  launchArgs: readonly string[];
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
    executableCandidates: ["agent", "cursor-agent"],
    launchArgs: ["acp"],
    authProbeArgs: ["status"],
    entitlementsPending: false
  },
  copilot: {
    executableCandidates: ["copilot"],
    launchArgs: ["--acp", "--stdio"],
    authProbeArgs: ["version"],
    entitlementsPending: false
  },
  grok: {
    executableCandidates: ["grok"],
    launchArgs: ["--no-auto-update", "agent", "stdio"],
    authProbeArgs: ["--no-auto-update", "models"],
    entitlementsPending: true
  },
  opencode: {
    executableCandidates: ["opencode"],
    launchArgs: ["acp"],
    authProbeArgs: ["models"],
    entitlementsPending: false
  },
  kimi: {
    executableCandidates: ["kimi"],
    launchArgs: ["acp"],
    // Kimi's ACP `authenticate` method validates its provider-owned login.
    authProbeArgs: [],
    entitlementsPending: false
  },
  "mistral-vibe": {
    executableCandidates: ["vibe-acp"],
    launchArgs: [],
    // Vibe's browser/API-key setup remains entirely provider-owned.
    authProbeArgs: [],
    entitlementsPending: false
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
    | "unavailable"
    | "failed";
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
      // A real auth failure (401/forbidden) is a distinct state from a generic
      // probe failure: the CLI is installed and reached its endpoint but was
      // denied. Reported as "failed" (fail-closed: no capabilities) so the shell
      // can surface it accurately.
      return {
        providerId,
        authState: "failed",
        capabilities: [],
        entitlementsPending: definition.entitlementsPending
      };
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
