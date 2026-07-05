import type { BackendProvider } from "@fable/protocol";
import { resolveCapabilities } from "./capabilities";

export const LOCAL_LOOPBACK_BACKEND_TYPE = "local-loopback" as const;

export function resolveOllamaProvider(
  authState: BackendProvider["authState"] = "unavailable"
): BackendProvider {
  return {
    id: "ollama",
    backendType: LOCAL_LOOPBACK_BACKEND_TYPE,
    label: "Ollama",
    description:
      "Use an externally managed Ollama service on 127.0.0.1. Fable never bundles models or downloads them automatically.",
    authState,
    capabilities: resolveCapabilities(LOCAL_LOOPBACK_BACKEND_TYPE, authState),
    models: [],
    installHint:
      "Install Ollama, start its local service, then pull a model with Ollama before returning to Fable."
  };
}
