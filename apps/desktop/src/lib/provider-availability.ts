import type { BackendProvider } from "@fable/protocol";
import { BACKEND_PROVIDER_IDS } from "@fable/connectors";

export function isFableProviderEnabled(providerId: string): boolean {
  return (BACKEND_PROVIDER_IDS as readonly string[]).includes(
    providerId.trim().toLowerCase()
  );
}

export function enabledFableProviders(
  providers: BackendProvider[],
): BackendProvider[] {
  return providers.filter((provider) => isFableProviderEnabled(provider.id));
}
