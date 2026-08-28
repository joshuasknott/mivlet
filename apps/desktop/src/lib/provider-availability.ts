import type { BackendProvider } from "@fable/protocol";

// Fable does not offer an embedded or loopback local-model path. Provider-hosted
// xAI models remain available through the same encrypted API-key boundary as
// the other native providers.
const DISABLED_PROVIDER_IDS = new Set(["grok", "ollama"]);

export function isFableProviderEnabled(providerId: string): boolean {
  return !DISABLED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export function enabledFableProviders(
  providers: BackendProvider[],
): BackendProvider[] {
  return providers.filter((provider) => isFableProviderEnabled(provider.id));
}
