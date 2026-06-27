/**
 * Copilot SDK adapter — desktop is a supported target.
 *
 * Four auth modes are surfaced as selectable options, all routed through the
 * Rust credential boundary:
 *   - subscriber (GitHub Copilot subscription),
 *   - OAuth app,
 *   - automation token,
 *   - BYOK (bring your own key).
 *
 * The resolved capability set is independent of the auth mode (the SDK exposes
 * the same surface either way) but a missing/invalid credential still fails
 * closed. No live SDK calls happen this goal; that is deferred to the
 * agent-loop goal.
 */

import type { BackendProvider } from "@arden/protocol";
import { resolveCapabilities } from "./capabilities";
import { copilotFixtures, type CopilotAuthMode } from "./fixtures";

export const COPILOT_PROVIDER_ID = "copilot";
export const COPILOT_BACKEND_TYPE = "copilot-sdk" as const;

/** The auth modes the Copilot SDK adapter accepts. */
export const COPILOT_AUTH_MODES: readonly CopilotAuthMode[] = [
  "subscriber",
  "oauth-app",
  "automation-token",
  "byok"
];

/** Build the Copilot provider for a given auth state. */
export function resolveCopilotProvider(
  authState: BackendProvider["authState"]
): BackendProvider {
  const fixture = copilotFixtures;
  const capabilities = resolveCapabilities(COPILOT_BACKEND_TYPE, authState);

  return {
    id: COPILOT_PROVIDER_ID,
    backendType: COPILOT_BACKEND_TYPE,
    label: fixture.label,
    description: fixture.description,
    authState,
    capabilities,
    models: fixture.models.map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    installHint: fixture.installHint
  };
}
