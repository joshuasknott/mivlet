import type { BackendProvider, BackendVerifyResult } from "@mivlet/protocol";
import type { ModelDiscoveryResult } from "@mivlet/connectors";
import { enabledMivletProviders } from "../../lib/provider-availability";
import {
  listRuntimeBackends,
  listRuntimeBackendModels,
  verifyRuntimeBackend,
} from "../../runtime/domains/providers";

// The native requests retain their own network deadlines. This renderer bound
// also covers a missing/unresponsive IPC response; late results have no authority.
const REQUEST_TIMEOUT_MS = 20_000;

async function bounded<T>(request: () => Promise<T>, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request().catch(() => fallback),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function unavailable(
  provider: BackendProvider,
  result: BackendVerifyResult | null,
): BackendProvider {
  const recovery =
    result?.outcome === "auth-failed"
      ? "Replace the API key and reconnect."
      : "Check your network, then choose Check connection to retry the saved key.";
  return {
    ...provider,
    authState: result?.outcome === "auth-failed" ? "needs-auth" : "unavailable",
    capabilities: [],
    models: provider.models.map((model) => ({ ...model, available: false })),
    installHint: `${result?.message ?? "Mivlet could not verify this saved provider."} ${recovery}`,
  };
}

/** One account scope's transient requests; never stores credentials or durable data. */
export function createProviderConnectionRequests(options: {
  isCurrent: () => boolean;
  onProviders: (providers: BackendProvider[]) => void;
  onDiscovery: (
    providerId: string,
    result: ModelDiscoveryResult | null,
  ) => void;
}) {
  let active = true;
  let refreshGeneration = 0;
  let catalogueGeneration = 0;
  let refreshPromise: Promise<BackendProvider[] | null> | null = null;
  let providers: BackendProvider[] = [];
  const epochs = new Map<string, number>();
  const verifying = new Map<string, Promise<BackendVerifyResult | null>>();
  const discovering = new Map<string, Promise<void>>();
  const verified = new Map<string, BackendVerifyResult | null>();
  const mutating = new Set<string>();
  const capture = (providerId: string) => ({
    providerId,
    epoch: epochs.get(providerId) ?? 0,
  });
  const isCurrent = (token?: ReturnType<typeof capture>) =>
    active &&
    options.isCurrent() &&
    (!token || token.epoch === (epochs.get(token.providerId) ?? 0));
  const publish = () => {
    if (isCurrent()) options.onProviders(providers);
  };

  const verify = (providerId: string): Promise<BackendVerifyResult | null> => {
    if (!isCurrent() || mutating.has(providerId))
      return Promise.resolve({
        providerId,
        outcome: "failed",
        message:
          "The connection is changing. Wait for it to finish, then check again.",
      });
    const existing = verifying.get(providerId);
    if (existing) return existing;
    const token = capture(providerId);
    const request = bounded(() => verifyRuntimeBackend(providerId), {
      providerId,
      outcome: "failed" as const,
      message:
        "The connection check did not finish. Check your network and try again.",
    })
      .then((result) => {
        if (isCurrent(token)) verified.set(providerId, result);
        return result;
      })
      .finally(() => {
        if (verifying.get(providerId) === request) verifying.delete(providerId);
      });
    verifying.set(providerId, request);
    return request;
  };

  const refresh = (
    checkedProviderId?: string,
  ): Promise<BackendProvider[] | null> => {
    if (!isCurrent()) return Promise.resolve(null);
    if (refreshPromise) return refreshPromise;
    const generation = ++refreshGeneration;
    const request = bounded(listRuntimeBackends, null)
      .then((listed) => {
        if (!isCurrent() || generation !== refreshGeneration || !listed)
          return null;
        const saved = enabledMivletProviders(listed);
        const catalogue = ++catalogueGeneration;
        for (const previous of providers) {
          if (
            previous.id !== checkedProviderId &&
            (previous.authState === "connected" ||
              verifying.has(previous.id) ||
              discovering.has(previous.id) ||
              verified.has(previous.id)) &&
            !saved.some(
              (entry) =>
                entry.id === previous.id && entry.authState === "connected",
            )
          ) {
            epochs.set(previous.id, (epochs.get(previous.id) ?? 0) + 1);
            discovering.delete(previous.id);
            verifying.delete(previous.id);
            verified.delete(previous.id);
          }
        }
        providers = saved.map((provider) => {
          if (mutating.has(provider.id) && provider.authState === "connected")
            return unavailable(provider, null);
          if (
            provider.backendType !== "native-api" ||
            provider.authState !== "connected"
          )
            return provider;
          const result = verified.get(provider.id);
          if (result?.outcome === "ready" || result?.outcome === "configured")
            return provider;
          if (verified.has(provider.id))
            return unavailable(provider, result ?? null);
          return {
            ...unavailable(provider, null),
            authState: "connecting" as const,
            installHint: "Checking the saved connection…",
          };
        });
        publish();
        // Release each genuinely usable provider independently. No slow secondary
        // provider holds the workspace gate, and pending credentials never unlock it.
        for (const provider of saved) {
          if (
            provider.backendType !== "native-api" ||
            provider.authState !== "connected" ||
            mutating.has(provider.id)
          )
            continue;
          if (provider.id === checkedProviderId && verified.has(provider.id))
            continue;
          const token = capture(provider.id);
          void verify(provider.id).then((result) => {
            if (
              !isCurrent(token) ||
              catalogue !== catalogueGeneration ||
              mutating.has(provider.id)
            )
              return;
            providers = providers.map((entry) =>
              entry.id !== provider.id
                ? entry
                : result?.outcome === "ready" ||
                    result?.outcome === "configured"
                  ? provider
                  : unavailable(provider, result),
            );
            publish();
          });
        }
        return providers;
      })
      .finally(() => {
        if (refreshPromise === request) refreshPromise = null;
      });
    refreshPromise = request;
    return request;
  };

  const discover = (providerId: string): Promise<void> => {
    if (!isCurrent() || mutating.has(providerId)) return Promise.resolve();
    const existing = discovering.get(providerId);
    if (existing) return existing;
    const token = capture(providerId);
    const request = bounded(() => listRuntimeBackendModels(providerId), {
      outcome: "failed" as const,
      models: [],
      message:
        "Model discovery did not finish. Choose Refresh models to try again.",
    })
      .then((result) => {
        if (isCurrent(token)) options.onDiscovery(providerId, result);
      })
      .finally(() => {
        if (discovering.get(providerId) === request)
          discovering.delete(providerId);
      });
    discovering.set(providerId, request);
    return request;
  };

  const invalidate = (providerId: string) => {
    epochs.set(providerId, (epochs.get(providerId) ?? 0) + 1);
    ++refreshGeneration;
    refreshPromise = null;
    verifying.delete(providerId);
    discovering.delete(providerId);
    verified.delete(providerId);
    mutating.add(providerId);
    providers = providers.map((provider) =>
      provider.id === providerId ? unavailable(provider, null) : provider,
    );
    if (providers.length) publish();
    return capture(providerId);
  };

  return {
    capture,
    isCurrent,
    verify,
    refresh,
    discover,
    invalidate,
    finishMutation: (token: ReturnType<typeof capture>) => {
      if (isCurrent(token)) mutating.delete(token.providerId);
    },
    dispose: () => {
      active = false;
    },
    activate: () => {
      active = true;
    },
  };
}
