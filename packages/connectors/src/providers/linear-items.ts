import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

/**
 * User-safe Linear result shapes for UI/model consumption, mirroring the
 * Slack/Notion/Vercel helpers. These are pure shaping functions: they never
 * touch the network or credentials and only carry metadata the desktop runtime
 * surfaces to the model and the connection UI.
 */
export interface LinearPayload {
  id: string;
  /** Mirrors the ConnectorItemKind union Linear entities map onto. */
  kind: "issue" | "project";
  /** Human-readable identifier, e.g. "FBL-12". */
  identifier: string;
  title: string;
  workspace: string;
  team?: string;
  state?: string;
  url?: string;
  description?: string;
  updatedAt?: string;
}

export function normalizeLinearItem(payload: LinearPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "linear",
    title: payload.identifier ? `${payload.identifier} · ${payload.title}` : payload.title,
    kind: payload.kind,
    summary: payload.description ?? `${payload.kind} in ${payload.workspace}`,
    provenance: `Linear · ${payload.workspace}`,
    freshness: payload.updatedAt ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.description ? { contentPreview: payload.description } : {}),
    providerMetadata: {
      workspace: payload.workspace,
      ...(payload.team ? { team: payload.team } : {}),
      ...(payload.state ? { state: payload.state } : {})
    }
  };
}

export function shapeLinearSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("linear", query, limit);
}

export function mapLinearError(error: ProviderErrorLike) {
  return classifyConnectorError("linear", error);
}
