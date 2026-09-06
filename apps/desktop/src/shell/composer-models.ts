import type { ProviderModelOption } from "../lib/provider-models";

function parsedModelVersion(modelId: string, prefix: string) {
  const match = modelId.toLowerCase().match(new RegExp(`^${prefix}-?(\\d+)(?:\\.(\\d+))?`));
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2] ?? 0);
}

/**
 * Keep the composer focused on viable current-generation choices without
 * changing the runtime's full, provider-aware model catalogue.
 */
export function composerModelsFor(
  providerId: string | undefined,
  models: ProviderModelOption[]
): ProviderModelOption[] {
  const available = models.filter(
    (model) => model.available && (!providerId || model.providerId === providerId)
  );
  if (available.length === 0) return [];
  if (providerId === "openai") {
    const hasGpt5 = available.some((model) => model.modelId.toLowerCase().startsWith("gpt-5"));
    if (hasGpt5) {
      const preferred = available.filter((model) => {
        const id = model.modelId.toLowerCase();
        return id.startsWith("gpt-5") || /^o[3-9]/.test(id);
      });
      if (preferred.length > 0) return preferred;
    }
    const hasGpt4 = available.some((model) => model.modelId.toLowerCase().startsWith("gpt-4"));
    if (hasGpt4) return available.filter((model) => !model.modelId.toLowerCase().startsWith("gpt-3.5"));
  }
  if (providerId === "antigravity") {
    const versioned = available
      .map((model) => ({ model, version: parsedModelVersion(model.modelId, "gemini") }))
      .filter((entry): entry is { model: ProviderModelOption; version: number } => entry.version !== null);
    const maxVersion = Math.max(...versioned.map((entry) => entry.version), 0);
    if (maxVersion > 0) {
      const preferred = versioned.filter((entry) => entry.version === maxVersion).map((entry) => entry.model);
      if (preferred.length > 0) return preferred;
    }
  }
  return available;
}
