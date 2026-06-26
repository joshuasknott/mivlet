/**
 * Native model API adapter. Arden owns the full agent loop here — tool
 * dispatch, streaming, approval routing, memory, usage/cost, and cancellation —
 * unlike the runtime backends (Codex/Cursor/Copilot/Grok) that borrow sessions
 * and approvals from their providers.
 *
 * All native providers are API-key only, so the only two meaningful auth states
 * are `needs-auth` (empty capabilities — fail closed) and `connected` (the full
 * capability set, including `usage-cost`). There is no entitlement-pending
 * state for native providers.
 *
 * Per-provider HTTP/SSE shaping lives in `@arden/connectors/native-api/`; this
 * module only declares the provider shape and capabilities for the registry.
 */

import type { BackendProvider } from "@arden/protocol";
import { resolveCapabilities } from "./capabilities";
import { nativeFixtures, type NativeFixture, type NativeProviderId } from "./fixtures";

export const NATIVE_BACKEND_TYPE = "native-api" as const;

function nativeFixture(providerId: NativeProviderId): NativeFixture {
  const fixture = nativeFixtures.find((entry) => entry.providerId === providerId);
  if (!fixture) {
    throw new Error(`Unknown native provider: ${providerId}`);
  }
  return fixture;
}

/** Build a native API provider for a given auth state. */
export function resolveNativeProvider(
  providerId: NativeProviderId,
  authState: BackendProvider["authState"]
): BackendProvider {
  const fixture = nativeFixture(providerId);
  const capabilities = resolveCapabilities(NATIVE_BACKEND_TYPE, authState, true);

  return {
    id: providerId,
    backendType: NATIVE_BACKEND_TYPE,
    label: fixture.label,
    description: fixture.description,
    authState,
    capabilities,
    models: fixture.models.map((model) => ({
      id: model.id,
      label: model.label,
      available: authState === "connected"
    })),
    installHint: undefined
  };
}
