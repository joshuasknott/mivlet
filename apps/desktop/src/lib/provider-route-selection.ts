import type { ProviderRouteExecutionBinding } from "@mivlet/protocol";
import { catalogueCapabilities, selectProviderRoute } from "@mivlet/connectors";
import { listRuntimeNativeProviderRoutes } from "../runtime/domains/providers";

export async function selectNativeProviderRoute(input: {
  providerId: string;
  model: string;
  requiredInputTokens: number;
  requiredOutputTokens: number;
  requiresTools: boolean;
}): Promise<ProviderRouteExecutionBinding> {
  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes)
    throw new Error("Provider routing requires the desktop runtime.");
  const pinnedRoute = routes.find(
    (route) =>
      route.providerFamily === input.providerId &&
      route.modelOrRuntimeReference === input.model,
  );
  const capabilities = catalogueCapabilities(input.providerId, input.model);
  const configuredCustomModel =
    input.providerId === "custom" && pinnedRoute !== undefined;
  if (!pinnedRoute || (!capabilities && !configuredCustomModel)) {
    throw new Error("The selected model has no authorized provider route.");
  }
  if (configuredCustomModel && input.requiresTools) {
    throw new Error(
      "The configured custom model does not declare tool support.",
    );
  }
  const requestedContextTokens =
    input.requiredInputTokens + input.requiredOutputTokens;
  const decision = selectProviderRoute(
    {
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
      preference: {
        policy: "require",
        providerRouteIds: [pinnedRoute.id],
        allowFallback: false,
      },
    },
    routes.map((route) => {
      const routeCapabilities = catalogueCapabilities(
        route.providerFamily,
        route.modelOrRuntimeReference,
      );
      const isPinnedConfiguredCustomRoute =
        route.id === pinnedRoute.id && route.providerFamily === "custom";
      return {
        route,
        capabilityIds: ["model.generate"],
        supportsTools: routeCapabilities?.tools === true,
        // Custom provider capability metadata is deliberately unknown. Grant
        // only the capacity needed by this plain-chat attempt; the provider still
        // owns the live limit check and Rust revalidates the exact configured model.
        contextWindowTokens:
          routeCapabilities?.contextWindow ??
          (isPinnedConfiguredCustomRoute ? requestedContextTokens : 0),
        ...(route.observationSummary
          ? {
              estimatedLatencyMs: route.observationSummary.medianLatencyMs,
              observation: route.observationSummary,
            }
          : {}),
        ...(route.pricingSummary ? { pricing: route.pricingSummary } : {}),
        ...(route.qualitySummary ? { quality: route.qualitySummary } : {}),
        risk: "medium" as const,
      };
    }),
  );
  return {
    workspaceId: pinnedRoute.workspaceId,
    selection: decision.selection,
  };
}
