/**
 * Codex app-server adapter — the recommended "Continue with ChatGPT/Codex" path.
 *
 * This module is the *logic* side of the logic/data split. It declares the
 * Codex provider shape and resolves its capabilities from auth state. The
 * fixture/preview catalog (models, install hint) lives in `./fixtures`.
 *
 * Two auth paths are supported, both routed through the Rust credential
 * boundary:
 *   - subscription: ChatGPT login reached via the Codex app-server.
 *   - OpenAI API key (BYOK): a metered key whose capability set additionally
 *     includes `usage-cost`.
 *
 * No live transport is spawned here this goal — the app-server socket is
 * described, not opened. Activating it is deferred to the agent-loop goal.
 */

import type { BackendProvider } from "@arden/protocol";
import { resolveCapabilities } from "./capabilities";
import { codexFixtures, type CodexFixture } from "./fixtures";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_BACKEND_TYPE = "codex-app-server" as const;

/** Build the Codex provider for a given auth state. */
export function resolveCodexProvider(
  authState: BackendProvider["authState"],
  options: { usingApiKey?: boolean; models?: CodexFixture["models"] } = {}
): BackendProvider {
  const fixture = codexFixtures;
  const withUsageCost = Boolean(options.usingApiKey);
  const capabilities = resolveCapabilities(
    CODEX_BACKEND_TYPE,
    authState,
    withUsageCost
  );

  return {
    id: CODEX_PROVIDER_ID,
    backendType: CODEX_BACKEND_TYPE,
    label: fixture.label,
    description: fixture.description,
    authState,
    capabilities,
    models: (options.models ?? fixture.models).map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    installHint: fixture.installHint
  };
}
