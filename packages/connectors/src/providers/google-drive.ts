import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export const GOOGLE_DRIVE_CAPABILITIES = [
  { id: "drive.search", kind: "read", consequential: false, description: "Search accessible Drive metadata." },
  { id: "drive.read", kind: "read", consequential: false, description: "Read, download, or export an authorized Drive file." },
  ...["create-file", "update-file", "move-file", "rename-file", "share-file", "delete-file"].map((action) => ({
    id: `google-drive.${action}`,
    kind: "write" as const,
    consequential: true,
    description: `${action.replaceAll("-", " ")} after explicit approval.`
  }))
] satisfies ConnectorCapability[];

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

export function prepareGoogleDriveAction(
  action: "google-drive.create-file" | "google-drive.update-file" | "google-drive.move-file" |
    "google-drive.rename-file" | "google-drive.share-file" | "google-drive.delete-file",
  payload: Record<string, string>
) {
  const destructive = action === "google-drive.share-file" || action === "google-drive.delete-file";
  const consequences: Record<typeof action, string> = {
    "google-drive.create-file": "Creates a Google Drive file after explicit approval.",
    "google-drive.update-file": "Updates the selected Google Drive file after explicit approval.",
    "google-drive.move-file": "Moves the selected Google Drive item after explicit approval.",
    "google-drive.rename-file": "Renames the selected Google Drive item after explicit approval.",
    "google-drive.share-file": "Shares the selected Google Drive item with an external recipient.",
    "google-drive.delete-file": "Deletes the selected Google Drive item."
  };
  return prepareConnectorAction(
    "google-drive",
    "Google Drive",
    action,
    payload,
    destructive ? "high" : "medium",
    consequences[action]
  );
}
