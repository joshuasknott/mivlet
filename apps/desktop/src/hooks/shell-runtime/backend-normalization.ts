import type { BackendAuthState, BackendCapability, BackendProvider, FirstWaveConnectorId } from "@fable/protocol";
import { FIRST_WAVE_CONNECTOR_IDS, resolveCapabilities } from "@fable/connectors";

/**
 * Map a Rust ACP CLI probe outcome to a truthful {@link BackendAuthState} +
 * capability set. Mirrors the pure `detectAcpRuntime` resolver but is kept
 * inline here so the shell does not import the contract's probe type directly.
 * No secret is read — the probe reports only install/auth availability.
 */
export function acpAuthStateFor(
  outcome: "not-installed" | "signed-out" | "connected" | "auth-failed" | "unavailable"
): { authState: BackendAuthState; capabilities: BackendCapability[] } {
  switch (outcome) {
    case "connected":
      return {
        authState: "connected",
        capabilities: resolveCapabilities("acp", "connected")
      };
    case "signed-out":
      return { authState: "needs-auth", capabilities: [] };
    case "not-installed":
      return { authState: "install-required", capabilities: [] };
    case "auth-failed":
      // CLI reached its endpoint but was denied (401/forbidden): distinct from
      // a generic probe failure so the shell surfaces it accurately.
      return { authState: "failed", capabilities: [] };
    case "unavailable":
    default:
      return { authState: "unavailable", capabilities: [] };
  }
}


export function localLoopbackCapabilities(provider: BackendProvider): BackendCapability[] {
  const caps = resolveCapabilities("local-loopback", provider.authState);
  const hasToolModel = provider.models.some(
    (model) => model.capabilities?.tools === true && model.available
  );
  if (provider.authState === "connected" && hasToolModel) {
    return Array.from(
      new Set<BackendCapability>([
        ...caps,
        "tool-requests",
        "approvals",
        "file-changes"
      ])
    );
  }
  return caps;
}


export function isFirstWaveConnectorId(value: string): value is FirstWaveConnectorId {
  return (FIRST_WAVE_CONNECTOR_IDS as readonly string[]).includes(value);
}
