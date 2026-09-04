import type { BackendModel, BackendProvider } from "@fable/protocol";
import { modelReasoning } from "@fable/connectors/native-api/reasoning";

/**
 * A model option carries its owning backend alongside the provider model id.
 * `id` is the stable UI/persistence key; `modelId` is the exact id sent to the
 * provider. The persisted key is always provider-qualified so connecting a
 * second provider later cannot silently reroute an existing selection.
 */
export interface ProviderModelOption extends BackendModel {
  providerId: string;
  providerLabel: string;
  modelId: string;
}

export interface ProviderModels {
  provider: BackendProvider;
  models: BackendModel[];
}

const MODEL_KEY_SEPARATOR = "::";

/** Build collision-safe model choices for every connected, runnable backend. */
export function providerModelOptions(entries: ProviderModels[]): ProviderModelOption[] {
  return entries.flatMap(({ provider, models }) =>
    models.map((model) => ({
      ...model,
      reasoning: modelReasoning(provider.id, model),
      id: `${provider.id}${MODEL_KEY_SEPARATOR}${model.id}`,
      modelId: model.id,
      providerId: provider.id,
      providerLabel: provider.label
    }))
  );
}

/**
 * Resolve the persisted picker key, including legacy snapshots that stored only
 * a provider model id before Fable supported multiple active providers.
 */
export function resolveProviderModelOption(
  options: ProviderModelOption[],
  persistedId: string
): ProviderModelOption | undefined {
  if (persistedId.includes(MODEL_KEY_SEPARATOR)) {
    return options.find((option) => option.id === persistedId && option.available);
  }

  const legacyMatches = options.filter(
    (option) => option.modelId === persistedId && option.available
  );
  if (legacyMatches.length === 1) return legacyMatches[0];
  if (persistedId) return undefined;
  return options.find((option) => option.available);
}

/** Return the active provider's original model catalogue from flattened choices. */
export function modelsForProvider(
  options: ProviderModelOption[],
  providerId: string | undefined
): BackendModel[] {
  if (!providerId) return [];
  return options
    .filter((option) => option.providerId === providerId)
    .map(({ providerId: _providerId, providerLabel: _providerLabel, modelId, ...option }) => ({
      ...option,
      id: modelId
    }));
}
