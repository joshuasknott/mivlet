import type { ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface GoogleDrivePayload {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  textExport?: string;
  selected: boolean;
}

export function normalizeGoogleDriveItem(payload: GoogleDrivePayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "google-drive",
    title: payload.name,
    kind: "file",
    summary: payload.selected
      ? "File explicitly selected for Fable"
      : "File metadata; import is unavailable until selected",
    provenance: "Google Drive · selected file",
    freshness: payload.modifiedTime ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.webViewLink ? { url: payload.webViewLink } : {}),
    ...(payload.textExport ? { contentPreview: payload.textExport } : {}),
    providerMetadata: { mimeType: payload.mimeType, selected: String(payload.selected) }
  };
}

export function shapeGoogleDriveSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("google-drive", query, limit);
}

export function mapGoogleDriveError(error: ProviderErrorLike) {
  return classifyConnectorError("google-drive", error);
}
