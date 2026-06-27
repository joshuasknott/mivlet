import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface VercelPayload {
  id: string;
  kind: "project" | "deployment";
  name: string;
  team: string;
  state?: string;
  environment?: "preview" | "production";
  url?: string;
  updatedAt?: string;
}

export function normalizeVercelItem(payload: VercelPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "vercel",
    title: payload.name,
    kind: payload.kind,
    summary: payload.state
      ? `${payload.environment ?? "deployment"} · ${payload.state}`
      : `Project in ${payload.team}`,
    provenance: `Vercel · ${payload.team}`,
    freshness: payload.updatedAt ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    providerMetadata: {
      team: payload.team,
      ...(payload.state ? { state: payload.state } : {}),
      ...(payload.environment ? { environment: payload.environment } : {})
    }
  };
}

export function shapeVercelSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("vercel", query, limit);
}

export function prepareVercelPromotion(deploymentId: string) {
  return prepareConnectorAction(
    "vercel",
    "Vercel",
    "vercel.promote",
    { targetId: deploymentId },
    "high",
    "Promotes the selected deployment to production."
  );
}

export function prepareVercelRollback(deploymentId: string) {
  return prepareConnectorAction(
    "vercel",
    "Vercel",
    "vercel.rollback",
    { targetId: deploymentId },
    "high",
    "Rolls production back to the selected deployment."
  );
}

export function mapVercelError(error: ProviderErrorLike) {
  return classifyConnectorError("vercel", error);
}
