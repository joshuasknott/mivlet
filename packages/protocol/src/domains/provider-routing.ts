import type { IsoDateTime, ProviderRouteId } from "../spine/primitives.js";

/** Optional user preference applied while choosing an authorized provider route. */
export interface ProviderRoutePreference {
  policy: "automatic" | "prefer" | "require" | "exclude";
  providerRouteIds: readonly ProviderRouteId[];
  allowFallback: boolean;
}

/** Immutable latency and usage summary derived from native observations. */
export interface ProviderRouteObservationSnapshot {
  reference: string;
  sampleCount: number;
  medianLatencyMs: number;
  usageSampleCount: number;
  latestObservedAt: IsoDateTime;
}

/** Immutable evaluator summary used only when its policy revision matches. */
export interface ProviderRouteQualitySnapshot {
  reference: string;
  policyRevisionRef: string;
  sampleCount: number;
  passedCount: number;
  routingScoreBasisPoints: number;
  latestEvaluatedAt: IsoDateTime;
}

/** Source-attributed exact-model pricing. */
export interface ProviderRoutePricingEvidence {
  reference: string;
  currencyCode: string;
  inputRateMinorUnits: number;
  outputRateMinorUnits: number;
  unitTokens: number;
  sourceUrl: string;
  reviewedAt: IsoDateTime;
}

export interface ProviderRouteCostSnapshot extends ProviderRoutePricingEvidence {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMinorUnits: number;
}

/** Secret-free route decision carried unchanged to native provider egress. */
export interface ProviderRouteSelection {
  providerRouteId: ProviderRouteId;
  selectedAt: IsoDateTime;
  reason: string;
  fallbackFromProviderRouteId?: ProviderRouteId;
  boundaryPolicyRef?: string;
  observation?: ProviderRouteObservationSnapshot;
  quality?: ProviderRouteQualitySnapshot;
  cost?: ProviderRouteCostSnapshot;
}
