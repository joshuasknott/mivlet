import type { BackendProvider } from "@mivlet/protocol";
import { resolveCapabilities } from "./capabilities";
import {
  managedProviderCatalog,
  type ManagedProviderCatalogEntry,
  type ManagedProviderId
} from "./catalog";

function catalogEntry(providerId: ManagedProviderId): ManagedProviderCatalogEntry {
  const entry = managedProviderCatalog.find((candidate) => candidate.providerId === providerId);
  if (!entry) throw new Error(`Unknown managed provider: ${providerId}`);
  return entry;
}

/** Build one provider-owned runtime instance without exposing its credentials. */
export function resolveManagedProvider(
  providerId: ManagedProviderId,
  authState: BackendProvider["authState"] = "unavailable"
): BackendProvider {
  const entry = catalogEntry(providerId);
  return {
    id: entry.providerId,
    instanceId: entry.providerId,
    driverKind: entry.driverKind,
    backendType: entry.backendType,
    label: entry.label,
    description: entry.description,
    authState,
    capabilities: resolveCapabilities(entry.backendType, authState, false),
    models: entry.models.map((model) => ({
      ...model,
      available: authState === "connected"
    })),
    setup: {
      kind: "provider-cli",
      label: entry.setupLabel,
      description: entry.setupDescription,
      recommended: true
    },
    installHint: entry.installHint
  };
}
