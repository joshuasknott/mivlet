import type { BackendProvider } from "@fable/protocol";

// These adapters remain internal foundations, but are not offered in the
// current product until their setup and run journeys meet the same standard as
// the supported provider paths.
const PAUSED_PROVIDER_IDS = new Set(["grok", "ollama", "xai"]);

export function isFableProviderEnabled(providerId: string): boolean {
  return !PAUSED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function enabledFableProviders(
  providers: BackendProvider[],
): BackendProvider[] {
  return providers.filter((provider) => isFableProviderEnabled(provider.id));
}
