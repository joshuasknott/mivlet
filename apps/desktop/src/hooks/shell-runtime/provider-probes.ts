import type { BackendProvider } from "@fable/protocol";
import { detectRuntimeAcpCli, detectRuntimeLocalModel } from "../../runtime";
import {
  acpAuthStateFor,
  localLoopbackCapabilities,
} from "./backend-normalization";

async function safeDetectAcpCli(
  providerId: string,
): Promise<
  | "not-installed"
  | "signed-out"
  | "connected"
  | "auth-failed"
  | "unavailable"
  | null
> {
  if (typeof detectRuntimeAcpCli !== "function") return null;
  try {
    return await detectRuntimeAcpCli(providerId);
  } catch {
    return null;
  }
}

export async function mergeAcpProbeResults(
  providers: BackendProvider[],
): Promise<BackendProvider[]> {
  if (providers.every((provider) => provider.backendType !== "acp")) {
    return providers;
  }
  return Promise.all(
    providers.map(async (provider) => {
      if (provider.backendType !== "acp") return provider;
      const probe = await safeDetectAcpCli(provider.id);
      if (!probe) return provider;
      const { authState, capabilities } = acpAuthStateFor(probe);
      return {
        ...provider,
        authState,
        capabilities,
        models: provider.models.map((model) => ({
          ...model,
          available: authState === "connected",
        })),
      };
    }),
  );
}

export async function mergeLocalLoopbackProbeResults(
  providers: BackendProvider[],
): Promise<BackendProvider[]> {
  if (
    providers.every((provider) => provider.backendType !== "local-loopback")
  ) {
    return providers;
  }
  return Promise.all(
    providers.map(async (provider) => {
      if (provider.backendType !== "local-loopback") return provider;
      const probe = await detectRuntimeLocalModel(provider.id);
      if (!probe) return provider;
      const next: BackendProvider = {
        ...provider,
        authState: probe.authState,
        models: probe.models,
        installHint: probe.message,
      };
      return {
        ...next,
        capabilities: localLoopbackCapabilities(next),
      };
    }),
  );
}
