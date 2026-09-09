import type { BackendProvider } from "@fable/protocol";
import { resolveCapabilities } from "./capabilities";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_BACKEND_TYPE = "antigravity-acp" as const;

export function resolveAntigravityProvider(
  authState: BackendProvider["authState"] = "install-required"
): BackendProvider {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    instanceId: ANTIGRAVITY_PROVIDER_ID,
    driverKind: "antigravity-acp",
    backendType: ANTIGRAVITY_BACKEND_TYPE,
    label: "Google Antigravity",
    description: "Use Gemini models through Google's official Antigravity ACP agent.",
    authState,
    capabilities: resolveCapabilities(ANTIGRAVITY_BACKEND_TYPE, authState, false),
    models: [],
    setup: {
      kind: "browser",
      label: "Google account",
      description: "Sign in through Google's official Antigravity browser flow.",
      recommended: true
    },
    installHint: "Mivlet installs Google's pinned Antigravity ACP runtime locally."
  };
}
