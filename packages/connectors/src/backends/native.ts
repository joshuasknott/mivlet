/**
 * Native model API adapter. Mivlet owns the full agent loop here — tool
 * dispatch, streaming, approval routing, memory, usage/cost, and cancellation —
 * unlike Codex browser sign-in, which uses provider-owned app-server state.
 *
 * All native providers are API-key only, so the only two meaningful auth states
 * are `needs-auth` (empty capabilities — fail closed) and `connected` (the full
 * capability set, including `usage-cost`). There is no entitlement-pending
 * state for native providers.
 *
 * Per-provider HTTP/SSE shaping lives in `@fable/connectors/native-api/`; this
 * module only declares the provider shape and capabilities for the registry.
 */

import type { BackendProvider } from "@fable/protocol";
import { resolveCapabilities } from "./capabilities";
import {
  nativeProviderCatalog,
  type NativeProviderCatalogEntry,
  type NativeProviderId
} from "./catalog";

export const NATIVE_BACKEND_TYPE = "native-api" as const;

function nativeProvider(providerId: NativeProviderId): NativeProviderCatalogEntry {
  const provider = nativeProviderCatalog.find((entry) => entry.providerId === providerId);
  if (!provider) {
    throw new Error(`Unknown native provider: ${providerId}`);
  }
  return provider;
}

/** Build a native API provider for a given auth state. */
export function resolveNativeProvider(
  providerId: NativeProviderId,
  authState: BackendProvider["authState"]
): BackendProvider {
  const provider = nativeProvider(providerId);
  const capabilities = resolveCapabilities(NATIVE_BACKEND_TYPE, authState, true);

  return {
    id: providerId,
    instanceId: providerId,
    driverKind: "native-api",
    backendType: NATIVE_BACKEND_TYPE,
    label: provider.label,
    description: provider.description,
    authState,
    capabilities,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    setup: {
      kind: providerId === "custom" ? "custom" : "api-key",
      label: provider.authLabel,
      description: providerId === "custom"
        ? "Use one explicit OpenAI-compatible endpoint."
        : "Use a metered API key stored by Mivlet's local credential boundary.",
      recommended: false
    },
    installHint: undefined
  };
}
