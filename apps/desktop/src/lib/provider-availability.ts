import type { BackendProvider } from "@fable/protocol";

// The unsupported Grok CLI path stays hidden. Provider-hosted xAI models remain
// available through the same encrypted API-key boundary as other providers.
const DISABLED_PROVIDER_IDS = new Set(["grok"]);

export function isFableProviderEnabled(providerId: string): boolean {
  return !DISABLED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function enabledFableProviders(
  providers: BackendProvider[],
): BackendProvider[] {
  return providers.filter((provider) => isFableProviderEnabled(provider.id));
}
