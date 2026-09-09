/**
 * Merge dynamic model discovery with the curated fallback catalogue.
 *
 * Truth rules (the core of "model availability is truthful"):
 *   - A generation model returned by the provider is `available: true`. Its
 *     optional capability detail comes from the catalogue where known. A new
 *     model remains runnable with conservative request defaults rather than
 *     waiting for a Mivlet release; unknown capabilities are never fabricated.
 *   - When discovery ran successfully (even if it returned nothing extra), a
 *     catalogue-only id the provider did NOT list is `available: false` — we do
 *     not advertise an executable model the provider did not surface.
 *   - When discovery did NOT run (offline, preview/test runtime, transport
 *     failure, `discoveryRan === false`), catalogue ids stay `available` per the
 *     caller's `connected` flag so the fallback catalogue can still drive a run.
 *
 * Pure: no network, no key. The Rust `list_backend_models` command performs the
 * GET; this module only merges the result with the catalogue. Fixture-testable.
 */

import type { BackendModel } from "@fable/protocol";
import { catalogueCapabilities } from "./model-catalogue";
import { modelReasoning } from "./reasoning";

/** A model id the provider's list-models endpoint returned. */
export interface DiscoveredModel {
  id: string;
  available: boolean;
  /** Optional provider-reported capabilities, used only when the runtime can substantiate them. */
  capabilities?: BackendModel["capabilities"];
  reasoning?: BackendModel["reasoning"];
}

export type DiscoveryOutcome = "success" | "unsupported" | "offline" | "failed" | "empty";

export interface ModelDiscoveryResult {
  outcome: DiscoveryOutcome;
  models: DiscoveredModel[];
  message?: string;
}

export interface MergeDiscoveryOptions {
  providerId: string;
  /** The catalogue ids to merge (typically the native fixture models). */
  catalogueModels: BackendModel[];
  /** The ids the provider's list-models endpoint returned (empty when it failed). */
  discovered: DiscoveredModel[];
  /** True when the provider is connected (drives catalogue availability when
   *  discovery did not run). */
  connected: boolean;
  /** True when discovery actually ran (transport succeeded, even if empty).
   *  False = offline/preview/failure → fallback to catalogue availability. */
  discoveryRan: boolean;
}

/**
 * Merge discovered and catalogue models into a truthful selectable list. See
 * the module header for the availability rules. Order: discovered first
 * (provider's own ordering), then catalogue-only ids not already present.
 */
export function mergeDiscoveredModels(options: MergeDiscoveryOptions): BackendModel[] {
  const { providerId, catalogueModels, discovered, connected, discoveryRan } = options;
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const out: BackendModel[] = [];
  const seen = new Set<string>();

  // 1) Discovered ids: available when the provider says so (default true; Gemini
  //    embeds may mark non-generation models unavailable).
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const capabilities = model.capabilities ?? catalogueCapabilities(providerId, model.id);
    out.push({
      id: model.id,
      label: catalogueModels.find((entry) => entry.id === model.id)?.label ?? model.id,
      available: model.available,
      capabilities,
      reasoning: modelReasoning(providerId, {
        ...catalogueModels.find((entry) => entry.id === model.id),
        ...model, label: model.id
      })
    });
  }

  // 2) Catalogue-only ids. When discovery ran, they are available only if the
  //    provider also surfaced them (already handled above) — otherwise
  //    unavailable. When discovery did NOT run, the catalogue is the fallback
  //    and availability follows the connection state.
  for (const entry of catalogueModels) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      label: entry.label,
      available: discoveryRan ? discoveredIds.has(entry.id) : connected,
      capabilities: entry.capabilities ?? catalogueCapabilities(providerId, entry.id),
      reasoning: modelReasoning(providerId, entry)
    });
  }

  return out;
}
