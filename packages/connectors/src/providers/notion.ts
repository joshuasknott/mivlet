import type { ConnectorSearchItem } from "@arden/protocol";
import {
  classifyConnectorError,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface NotionPayload {
  id: string;
  object: "page" | "database";
  title: string;
  workspace: string;
  lastEditedTime?: string;
  url?: string;
  plainText?: string;
}

export function normalizeNotionItem(payload: NotionPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "notion",
    title: payload.title,
    kind: payload.object,
    summary: `${payload.object} shared with the Arden connection`,
    provenance: `Notion · ${payload.workspace}`,
    freshness: payload.lastEditedTime ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.plainText ? { contentPreview: payload.plainText } : {}),
    providerMetadata: { workspace: payload.workspace, object: payload.object }
  };
}

export function shapeNotionSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("notion", query, limit);
}

export function mapNotionError(error: ProviderErrorLike) {
  return classifyConnectorError("notion", error);
}
