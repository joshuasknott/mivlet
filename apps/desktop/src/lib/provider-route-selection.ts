import type { ProviderRouteExecutionBinding, Spine } from "@fable/protocol";
import { catalogueCapabilities, selectMissionProviderRoute } from "@fable/connectors";
import {
  listRuntimeNativeProviderRoutes,
  type RuntimeNativeProviderRoute
} from "../runtime";

export async function selectNativeProviderRoute(input: {
  providerId: string;
  model: string;
  requiredInputTokens: number;
  requiredOutputTokens: number;
  requiresTools: boolean;
}): Promise<ProviderRouteExecutionBinding> {
  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes) throw new Error("Provider routing requires the desktop runtime.");
  const pinnedRoute = routes.find((route) =>
    route.providerFamily === input.providerId && route.modelOrRuntimeReference === input.model
  );
  const capabilities = catalogueCapabilities(input.providerId, input.model);
  if (!pinnedRoute || !capabilities) throw new Error("The selected model has no authorized provider route.");
  const decision = selectMissionProviderRoute({
    workspaceId: pinnedRoute.workspaceId,
    capabilityId: "model.generate",
    requiredInputTokens: input.requiredInputTokens,
    requiredOutputTokens: input.requiredOutputTokens,
    requiresTools: input.requiresTools,
    allowedPlacementKinds: ["local-desktop"],
    boundaries: pinnedRoute.boundaries,
    allowDegraded: false,
    maximumRisk: "medium",
    selectedAt: new Date().toISOString(),
    preference: { policy: "require", providerRouteIds: [pinnedRoute.id], allowFallback: false }
  }, routes.map((route) => ({
    route,
    capabilityIds: ["model.generate"],
    supportsTools: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.tools === true,
    contextWindowTokens: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.contextWindow ?? 0,
    ...(route.observationSummary ? {
      estimatedLatencyMs: route.observationSummary.medianLatencyMs,
      observation: route.observationSummary
    } : {}),
    ...(route.pricingSummary ? { pricing: route.pricingSummary } : {}),
    ...(route.qualitySummary ? { quality: route.qualitySummary } : {}),
    risk: "medium" as const
  })));
  return { workspaceId: pinnedRoute.workspaceId, selection: decision.selection };
}

export interface RuntimeMissionWorkerRoute {
  route: RuntimeNativeProviderRoute;
  execution: ProviderRouteExecutionBinding;
}

/**
 * Resolve a general worker only inside its immutable no-fallback route and
 * local-placement policy. Differing provider, billing, privacy, or placement
 * boundaries are never compared as fallback candidates.
 */
export async function selectRuntimeMissionWorkerRoute(
  worker: Spine.Missions.Worker
): Promise<RuntimeMissionWorkerRoute> {
  const preference = worker.routePreference;
  const placement = worker.placementPreference;
  if (
    !preference
    || preference.allowFallback
    || !placement
    || placement.policy !== "require"
    || placement.allowTransfer
    || placement.locality !== "local"
    || placement.executionNodeIds.length !== 1
    || placement.executionNodeIds[0] !== "local-desktop"
  ) {
    throw new Error("The Mission worker lacks its exact local execution policy.");
  }
  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes) throw new Error("Provider routing requires the desktop runtime.");
  const preferred = new Set(preference.providerRouteIds);
  const candidates = routes.filter((route) => {
    if (route.workspaceId !== worker.workspaceId) return false;
    if (preference.policy === "require") return preferred.has(route.id);
    if (preference.policy === "exclude") return !preferred.has(route.id);
    if (preference.policy === "prefer" && !preference.allowFallback) {
      return preferred.has(route.id);
    }
    return true;
  });
  if (candidates.length === 0) {
    throw new Error("No currently authorized route matches the saved Mission policy.");
  }
  const boundary = candidates[0]!.boundaries;
  if (candidates.some((route) => !sameBoundary(route.boundaries, boundary))) {
    throw new Error(
      "The saved Mission policy spans provider, billing, privacy, or placement boundaries."
    );
  }
  const decision = selectMissionProviderRoute({
    workspaceId: worker.workspaceId,
    capabilityId: "model.generate",
    requiredInputTokens: worker.budget.maxInputTokens ?? 1,
    requiredOutputTokens: worker.budget.maxOutputTokens ?? 1,
    requiresTools: worker.tools.length > 0,
    allowedPlacementKinds: ["local-desktop"],
    boundaries: boundary,
    allowDegraded: false,
    maximumRisk: "medium",
    selectedAt: new Date().toISOString(),
    preference
  }, candidates.map((route) => ({
    route,
    capabilityIds: ["model.generate"],
    supportsTools:
      catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.tools === true,
    contextWindowTokens:
      catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.contextWindow ?? 0,
    ...(route.observationSummary ? {
      estimatedLatencyMs: route.observationSummary.medianLatencyMs,
      observation: route.observationSummary
    } : {}),
    ...(route.pricingSummary ? { pricing: route.pricingSummary } : {}),
    ...(route.qualitySummary ? { quality: route.qualitySummary } : {}),
    risk: "medium" as const
  })));
  const route = candidates.find((candidate) => candidate.id === decision.selection.providerRouteId);
  if (!route) throw new Error("The selected Mission route is unavailable.");
  return {
    route,
    execution: { workspaceId: worker.workspaceId, selection: decision.selection }
  };
}

function sameBoundary(
  left: Spine.Connections.RouteBoundaryPolicy,
  right: Spine.Connections.RouteBoundaryPolicy
): boolean {
  return left.privacyBoundary === right.privacyBoundary
    && left.billingBoundary === right.billingBoundary
    && left.providerBoundary === right.providerBoundary
    && left.placementBoundary === right.placementBoundary;
}
