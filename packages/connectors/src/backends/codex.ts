/**
 * Codex app-server adapter — the recommended "Continue with ChatGPT/Codex" path.
 *
 * This module is the *logic* side of the logic/data split. It declares the
 * Codex provider shape and resolves its capabilities from auth state. The
 * static catalog (models, install hint) lives in `./catalog`.
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

import type { BackendProvider } from "@fable/protocol";
import { resolveCapabilities } from "./capabilities";
import { codexCatalog, type CodexCatalogEntry } from "./catalog";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_BACKEND_TYPE = "codex-app-server" as const;

/** Build the Codex provider for a given auth state. */
export function resolveCodexProvider(
  authState: BackendProvider["authState"],
  options: { usingApiKey?: boolean; models?: CodexCatalogEntry["models"] } = {}
): BackendProvider {
  const provider = codexCatalog;
  const withUsageCost = Boolean(options.usingApiKey);
  const capabilities = resolveCapabilities(
    CODEX_BACKEND_TYPE,
    authState,
    withUsageCost
  );

  return {
    id: CODEX_PROVIDER_ID,
    backendType: CODEX_BACKEND_TYPE,
    label: provider.label,
    description: provider.description,
    authState,
    capabilities,
    models: (options.models ?? provider.models).map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    installHint: provider.installHint
  };
}
