/**
 * Generic ACP adapter (stdio/JSON-RPC) shared by Cursor and Grok.
 *
 * ACP (Agent Client Protocol) is the shared transport: a user-installed CLI
 * speaks JSON-RPC over stdio and Fable normalizes its events. This adapter
 * depends on that CLI being installed — if it is absent the provider fails
 * closed with `authState: "install-required"` and an `installHint`. No CLI is
 * ever bundled or redistributed (licensing not yet reviewed).
 *
 * Compliance invariants enforced here:
 *   - Grok's `entitlements` array is **always empty until a post-login check**
 *     resolves it. Nothing promises any X/Premium tier includes Grok Build.
 *   - The CLI absence yields zero capabilities, not a degraded fake set.
 */

import type { BackendProvider } from "@fable/protocol";
import { resolveCapabilities } from "./capabilities";
import { acpFixtures, type AcpFixture, type AcpProviderId } from "./fixtures";

export const ACP_BACKEND_TYPE = "acp" as const;

/** Map a provider id to its ACP fixture (install hint, models). */
function acpFixture(providerId: AcpProviderId): AcpFixture {
  const fixture = acpFixtures.find((entry) => entry.providerId === providerId);
  if (!fixture) {
    throw new Error(`Unknown ACP provider: ${providerId}`);
  }
  return fixture;
}

/**
 * Build an ACP provider (Cursor or Grok) for a given auth state.
 *
 * @param providerId "cursor" | "grok"
 * @param authState install-required when the CLI is missing, entitlement-pending
 *   for Grok post-login before its entitlement resolves, connected otherwise.
 */
export function resolveAcpProvider(
  providerId: AcpProviderId,
  authState: BackendProvider["authState"]
): BackendProvider {
  const fixture = acpFixture(providerId);
  const capabilities = resolveCapabilities(ACP_BACKEND_TYPE, authState);

  return {
    id: providerId,
    backendType: ACP_BACKEND_TYPE,
    label: fixture.label,
    description: fixture.description,
    authState,
    capabilities,
    models: fixture.models.map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    installHint: fixture.installHint,
    // Grok entitlements are detected post-login only — never pre-populated.
    entitlements: providerId === "grok" ? [] : undefined
  };
}

export const resolveCursorProvider = (authState: BackendProvider["authState"]) =>
  resolveAcpProvider("cursor", authState);

export const resolveGrokProvider = (authState: BackendProvider["authState"]) =>
  resolveAcpProvider("grok", authState);

export const resolveOpenCodeProvider = (authState: BackendProvider["authState"]) =>
  resolveAcpProvider("opencode", authState);

export const resolveKimiProvider = (authState: BackendProvider["authState"]) =>
  resolveAcpProvider("kimi", authState);

export const resolveMistralVibeProvider = (authState: BackendProvider["authState"]) =>
  resolveAcpProvider("mistral-vibe", authState);
