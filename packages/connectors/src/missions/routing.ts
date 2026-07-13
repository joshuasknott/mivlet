import type { Spine } from "@fable/protocol";

type ProviderRoute = Spine.Connections.ProviderRoute;
type ProviderRoutePreference = Spine.Missions.ProviderRoutePreference;
type ProviderRouteSelection = Spine.Missions.ProviderRouteSelection;
type ProviderRouteObservationSnapshot = Spine.Missions.ProviderRouteObservationSnapshot;
type ProviderRouteQualitySnapshot = Spine.Missions.ProviderRouteQualitySnapshot;
type ProviderRoutePricingEvidence = Spine.Missions.ProviderRoutePricingEvidence;
type ProviderRouteCostSnapshot = Spine.Missions.ProviderRouteCostSnapshot;

export interface MissionRouteCandidate {
  route: ProviderRoute;
  capabilityIds: readonly string[];
  supportsTools: boolean;
  contextWindowTokens: number;
  quality?: ProviderRouteQualitySnapshot;
  estimatedLatencyMs?: number;
  observation?: ProviderRouteObservationSnapshot;
  pricing?: ProviderRoutePricingEvidence;
  risk: "low" | "medium" | "high" | "critical";
}

export interface MissionRouteRequest {
  workspaceId: string;
  capabilityId: string;
  requiredInputTokens: number;
  requiredOutputTokens: number;
  requiresTools: boolean;
  allowedPlacementKinds: readonly Spine.Connections.ExecutionPlacementKind[];
  boundaries: Spine.Connections.CapabilityResolutionBoundary;
  allowDegraded: boolean;
  maximumRisk: MissionRouteCandidate["risk"];
  maxCostMinorUnits?: number;
  currency?: string;
  /** Only an exact matching evaluator cohort may influence this decision. */
  qualityPolicyRef?: string;
  preference?: ProviderRoutePreference;
  weights?: { quality: number; cost: number; speed: number };
  selectedAt: string;
}

export interface MissionRouteDecision {
  selection: ProviderRouteSelection;
  score: number;
  reason: string;
  rejected: readonly { providerRouteId: string; reasons: readonly string[] }[];
}

export class MissionRoutingError extends Error {
  constructor(message: string, readonly rejected: MissionRouteDecision["rejected"] = []) {
    super(message);
    this.name = "MissionRoutingError";
  }
}

/** Deterministic, fail-closed selection over already-authorized provider routes. */
export function selectMissionProviderRoute(
  request: MissionRouteRequest,
  candidates: readonly MissionRouteCandidate[]
): MissionRouteDecision {
  validateRequest(request);
  candidates.forEach((candidate) => {
    validateCandidateObservation(candidate);
    validateCandidateQuality(candidate);
    validateCandidatePricing(candidate);
  });
  const rejected: Array<{ providerRouteId: string; reasons: string[] }> = [];
  const eligible = candidates.flatMap((candidate) => {
    const reasons = rejectionReasons(request, candidate);
    if (reasons.length) {
      rejected.push({ providerRouteId: candidate.route.id, reasons });
      return [];
    }
    const cost = candidate.pricing ? estimateCost(request, candidate.pricing) : undefined;
    return [{ candidate, cost, score: score(request, candidate, cost) }];
  });
  if (!eligible.length) throw new MissionRoutingError("No provider route satisfies the mission boundary.", rejected);
  eligible.sort((left, right) => right.score - left.score || left.candidate.route.id.localeCompare(right.candidate.route.id));
  const selected = eligible[0]!;
  const preferred = request.preference?.policy === "prefer" ? new Set(request.preference.providerRouteIds) : undefined;
  const fellBack = preferred && preferred.size > 0 && !preferred.has(selected.candidate.route.id);
  if (fellBack && request.preference?.allowFallback !== true) {
    throw new MissionRoutingError("The preferred provider route is unavailable and fallback is disabled.", rejected);
  }
  const fallbackFromProviderRouteId = fellBack
    ? request.preference?.providerRouteIds.find((id) => candidates.some((candidate) => candidate.route.id === id))
    : undefined;
  const selectedQuality = matchingQuality(request, selected.candidate);
  const reason = routeReason(request, selected.candidate, selected.cost, fellBack === true);
  return {
    selection: {
      providerRouteId: selected.candidate.route.id,
      selectedAt: request.selectedAt,
      reason,
      ...(fallbackFromProviderRouteId ? { fallbackFromProviderRouteId } : {}),
      boundaryPolicyRef: boundaryReference(request.boundaries),
      ...(selected.candidate.observation ? { observation: selected.candidate.observation } : {}),
      ...(selectedQuality ? { quality: selectedQuality } : {}),
      ...(selected.cost ? { cost: selected.cost } : {})
    },
    score: selected.score,
    reason,
    rejected
  };
}

function validateCandidateQuality(candidate: MissionRouteCandidate): void {
  const quality = candidate.quality;
  if (!quality) return;
  if (!quality.reference.startsWith("route-policy-summary:v1:")
    || !quality.policyRevisionRef.startsWith("native-policy:")
    || !Number.isInteger(quality.sampleCount) || quality.sampleCount < 1 || quality.sampleCount > 50
    || !Number.isInteger(quality.passedCount) || quality.passedCount < 0 || quality.passedCount > quality.sampleCount
    || !Number.isInteger(quality.routingScoreBasisPoints) || quality.routingScoreBasisPoints < 0 || quality.routingScoreBasisPoints > 10_000
    || quality.routingScoreBasisPoints !== Math.floor((quality.passedCount + 1) * 10_000 / (quality.sampleCount + 2))
    || !Number.isFinite(Date.parse(quality.latestEvaluatedAt))) {
    throw new MissionRoutingError("Route policy evidence requires a valid immutable evaluator-revision snapshot.");
  }
}

function validateCandidatePricing(candidate: MissionRouteCandidate): void {
  const pricing = candidate.pricing;
  if (!pricing) return;
  if (!pricing.reference.startsWith("route-pricing:v1:")
    || !/^[A-Z]{3}$/.test(pricing.currencyCode)
    || !Number.isInteger(pricing.inputRateMinorUnits) || pricing.inputRateMinorUnits < 0
    || !Number.isInteger(pricing.outputRateMinorUnits) || pricing.outputRateMinorUnits < 0
    || !Number.isInteger(pricing.unitTokens) || pricing.unitTokens < 1
    || !Number.isFinite(Date.parse(pricing.reviewedAt))
    || !isPublicHttpsUrl(pricing.sourceUrl)) {
    throw new MissionRoutingError("Route cost requires valid source-attributed exact-model pricing evidence.");
  }
}

function estimateCost(request: MissionRouteRequest, pricing: ProviderRoutePricingEvidence): ProviderRouteCostSnapshot {
  const numerator = request.requiredInputTokens * pricing.inputRateMinorUnits
    + request.requiredOutputTokens * pricing.outputRateMinorUnits;
  if (!Number.isSafeInteger(numerator)) {
    throw new MissionRoutingError("Route cost estimate exceeds the safe numeric range.");
  }
  return {
    ...pricing,
    estimatedInputTokens: request.requiredInputTokens,
    estimatedOutputTokens: request.requiredOutputTokens,
    estimatedCostMinorUnits: Math.ceil(numerator / pricing.unitTokens)
  };
}

function validateCandidateObservation(candidate: MissionRouteCandidate): void {
  if (candidate.estimatedLatencyMs === undefined && candidate.observation === undefined) return;
  const observation = candidate.observation;
  if (!observation
    || candidate.estimatedLatencyMs !== observation.medianLatencyMs
    || !observation.reference.startsWith("route-observation-summary:v1:")
    || !Number.isInteger(observation.sampleCount) || observation.sampleCount < 1
    || !Number.isInteger(observation.medianLatencyMs) || observation.medianLatencyMs < 0
    || !Number.isInteger(observation.usageSampleCount) || observation.usageSampleCount < 0
    || observation.usageSampleCount > observation.sampleCount
    || !Number.isFinite(Date.parse(observation.latestObservedAt))) {
    throw new MissionRoutingError("Observed route latency requires a valid immutable observation snapshot.");
  }
}

function rejectionReasons(request: MissionRouteRequest, candidate: MissionRouteCandidate): string[] {
  const { route } = candidate;
  const reasons: string[] = [];
  if (route.workspaceId !== request.workspaceId) reasons.push("workspace-mismatch");
  if (!candidate.capabilityIds.includes(request.capabilityId)) reasons.push("capability-unavailable");
  if (route.state !== "available" && !(request.allowDegraded && route.state === "degraded")) reasons.push("route-unavailable");
  if (route.health.state !== "healthy" && !(request.allowDegraded && route.health.state === "degraded")) reasons.push("route-unhealthy");
  if (request.requiresTools && !candidate.supportsTools) reasons.push("tools-unavailable");
  if (candidate.contextWindowTokens < request.requiredInputTokens + request.requiredOutputTokens) reasons.push("context-insufficient");
  if (!sameBoundaries(route.boundaries, request.boundaries)) reasons.push("boundary-mismatch");
  if (!route.placement.allowedKinds.some((kind) => request.allowedPlacementKinds.includes(kind))) reasons.push("placement-denied");
  if (riskRank(candidate.risk) > riskRank(request.maximumRisk)) reasons.push("risk-exceeded");
  const estimatedCostMinorUnits = candidate.pricing ? estimateCost(request, candidate.pricing).estimatedCostMinorUnits : undefined;
  if (request.maxCostMinorUnits !== undefined && (estimatedCostMinorUnits === undefined || estimatedCostMinorUnits > request.maxCostMinorUnits)) reasons.push("cost-exceeded");
  if (route.budgetLimit?.maxInputTokens !== undefined && route.budgetLimit.maxInputTokens < request.requiredInputTokens) reasons.push("input-budget-exceeded");
  if (route.budgetLimit?.maxOutputTokens !== undefined && route.budgetLimit.maxOutputTokens < request.requiredOutputTokens) reasons.push("output-budget-exceeded");
  if (route.budgetLimit?.maxCostMinorUnits !== undefined && (estimatedCostMinorUnits === undefined || estimatedCostMinorUnits > route.budgetLimit.maxCostMinorUnits)) reasons.push("route-cost-limit-exceeded");
  if (request.currency && candidate.pricing && candidate.pricing.currencyCode !== request.currency) reasons.push("currency-mismatch");
  if (request.currency && route.budgetLimit?.currency && route.budgetLimit.currency !== request.currency) reasons.push("currency-mismatch");
  const preference = request.preference;
  if (preference?.policy === "require" && !preference.providerRouteIds.includes(route.id)) reasons.push("provider-pin-mismatch");
  if (preference?.policy === "exclude" && preference.providerRouteIds.includes(route.id)) reasons.push("provider-excluded");
  return [...new Set(reasons)];
}

function score(request: MissionRouteRequest, candidate: MissionRouteCandidate, cost?: ProviderRouteCostSnapshot): number {
  const weights = request.weights ?? { quality: 0.5, cost: 0.25, speed: 0.25 };
  const costScore = cost === undefined ? 0.5 : 1 / (1 + cost.estimatedCostMinorUnits);
  const speedScore = candidate.estimatedLatencyMs === undefined ? 0.5 : 1 / (1 + candidate.estimatedLatencyMs / 1_000);
  const preferenceBonus = request.preference?.policy === "prefer" && request.preference.providerRouteIds.includes(candidate.route.id) ? 1 : 0;
  const healthPenalty = candidate.route.state === "degraded" || candidate.route.health.state === "degraded" ? 0.15 : 0;
  const quality = matchingQuality(request, candidate);
  const qualityScore = quality ? quality.routingScoreBasisPoints / 10_000 : 0.5;
  return round(weights.quality * qualityScore + weights.cost * costScore + weights.speed * speedScore + preferenceBonus - healthPenalty);
}

function validateRequest(request: MissionRouteRequest): void {
  const integers = [request.requiredInputTokens, request.requiredOutputTokens, request.maxCostMinorUnits].filter((value): value is number => value !== undefined);
  if (!request.workspaceId.trim() || !request.capabilityId.trim() || integers.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new MissionRoutingError("Mission route request is invalid.");
  }
  if (!request.allowedPlacementKinds.length || !Number.isFinite(Date.parse(request.selectedAt))) {
    throw new MissionRoutingError("Mission route placement or selection time is invalid.");
  }
  if (request.qualityPolicyRef !== undefined && (!request.qualityPolicyRef.startsWith("native-policy:") || request.qualityPolicyRef.length > 240)) {
    throw new MissionRoutingError("Mission route quality policy reference is invalid.");
  }
  const weights = request.weights ?? { quality: 0.5, cost: 0.25, speed: 0.25 };
  if ([weights.quality, weights.cost, weights.speed].some((value) => !Number.isFinite(value) || value < 0) || weights.quality + weights.cost + weights.speed <= 0) {
    throw new MissionRoutingError("Mission route weights are invalid.");
  }
  if (request.preference && request.preference.policy !== "automatic" && request.preference.providerRouteIds.length === 0) {
    throw new MissionRoutingError("Mission route preference requires explicit route ids.");
  }
}

function routeReason(request: MissionRouteRequest, candidate: MissionRouteCandidate, cost: ProviderRouteCostSnapshot | undefined, fallback: boolean): string {
  const quality = matchingQuality(request, candidate);
  const parts = [
    `Selected ${candidate.route.displayName} for ${request.capabilityId}`,
    quality === undefined ? "quality unobserved" : `policy evidence ${quality.passedCount} of ${quality.sampleCount} outputs passed`,
    cost === undefined ? "cost unobserved" : `estimated cost ${cost.estimatedCostMinorUnits} ${cost.currencyCode} minor units`,
    candidate.estimatedLatencyMs === undefined ? "latency unobserved" : `estimated latency ${candidate.estimatedLatencyMs} ms`,
    candidate.route.health.state === "degraded" || candidate.route.state === "degraded" ? "degraded route allowed" : "healthy route",
    fallback ? "same-boundary fallback" : undefined
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

function matchingQuality(request: MissionRouteRequest, candidate: MissionRouteCandidate): ProviderRouteQualitySnapshot | undefined {
  return request.qualityPolicyRef !== undefined && candidate.quality?.policyRevisionRef === request.qualityPolicyRef
    ? candidate.quality
    : undefined;
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function sameBoundaries(route: Spine.Connections.RouteBoundaryPolicy, request: Spine.Connections.CapabilityResolutionBoundary): boolean {
  return route.privacyBoundary === request.privacyBoundary && route.billingBoundary === request.billingBoundary
    && route.providerBoundary === request.providerBoundary && route.placementBoundary === request.placementBoundary;
}

function boundaryReference(boundaries: Spine.Connections.CapabilityResolutionBoundary): string {
  return `boundary:${[boundaries.privacyBoundary, boundaries.billingBoundary, boundaries.providerBoundary, boundaries.placementBoundary].map(encodeURIComponent).join(":")}`;
}

function riskRank(value: MissionRouteCandidate["risk"]): number {
  return ({ low: 0, medium: 1, high: 2, critical: 3 })[value];
}

function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
