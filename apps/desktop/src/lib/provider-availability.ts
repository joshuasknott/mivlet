import type { BackendProvider } from "@mivlet/protocol";
import { BACKEND_PROVIDER_IDS } from "@mivlet/connectors";

export function isMivletProviderEnabled(providerId: string): boolean {
  return (BACKEND_PROVIDER_IDS as readonly string[]).includes(
    providerId.trim().toLowerCase()
  );
}

export function enabledMivletProviders(
  providers: BackendProvider[],
): BackendProvider[] {
  return providers.filter((provider) => isMivletProviderEnabled(provider.id));
}
