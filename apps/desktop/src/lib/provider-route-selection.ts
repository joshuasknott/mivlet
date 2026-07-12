import type { ProviderRouteExecutionBinding } from "@fable/protocol";
import { catalogueCapabilities, selectMissionProviderRoute } from "@fable/connectors";
import { listRuntimeNativeProviderRoutes } from "../runtime";

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
    risk: "medium" as const
  })));
  return { workspaceId: pinnedRoute.workspaceId, selection: decision.selection };
}
