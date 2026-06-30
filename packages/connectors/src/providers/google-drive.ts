import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import {
  ProviderHttpClient,
  asObjects,
  googleOAuthClient,
  isObject,
  page,
  stringValue,
  type FetchLike,
  type JsonObject,
  type OAuthClientOptions,
  type ProviderRequest
} from "./http";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";
import {
  googleConfigurationMessage,
  googleConnectorPermissions,
  googleScopeDescriptions,
  googleScopeIds
} from "./google-shared";

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

export const GOOGLE_DRIVE_OAUTH_SCOPES = googleScopeIds("google-drive");
export const GOOGLE_DRIVE_SCOPE_DESCRIPTIONS = googleScopeDescriptions("google-drive");
export const GOOGLE_DRIVE_PERMISSIONS = googleConnectorPermissions("google-drive");
export const GOOGLE_DRIVE_SETUP_MESSAGE = googleConfigurationMessage("google-drive");

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

/**
 * Live Google Drive adapter. Google is a public-PKCE provider excluded from
 * the auth broker (see broker-contract.ts), so authorization, refresh, and
 * revocation go directly to Google's OAuth2 endpoints via `googleOAuthClient`.
 * Reads map to the Drive v3 REST surface and walk `nextPageToken` cursors.
 *
 * Sync is conservative: we only fetch file metadata plus an optional text
 * export for editable Docs-type files; binary/native content is never pulled.
 */
export interface GoogleDriveAdapterOptions
  extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

export function createGoogleDriveAdapter(
  options: GoogleDriveAdapterOptions
): ConnectorAdapter<JsonObject, JsonObject> {
  const authBase = new URL(options.authBaseUrl ?? "https://accounts.google.com/");
  const auth = googleOAuthClient({
    ...options,
    connectorId: "google-drive",
    authorizationEndpoint: new URL("o/oauth2/v2/auth", authBase).toString(),
    tokenEndpoint: new URL("o/oauth2/token", authBase).toString(),
    identityEndpoint: new URL("oauth2/v3/userinfo", authBase).toString(),
    revocationEndpoint: new URL("o/oauth2/revoke", authBase).toString(),
    scopes: [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/drive.readonly"
    ]
  });
  const http = new ProviderHttpClient(
    "google-drive",
    options.apiBaseUrl ?? "https://www.googleapis.com/drive/v3/",
    options.fetch
  );
  return {
    id: "google-drive",
    capabilities: GOOGLE_DRIVE_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      const mapped = googleDriveReadRequest(request);
      const { data, response } = await http.request<unknown>(mapped, tokens);
      const files = isObject(data) && Array.isArray(data.files)
        ? asObjects(data.files).map(redactDriveObject)
        : isObject(data)
          ? [redactDriveObject(data)]
          : [];
      return page(files, response, googleDriveNextCursor(data));
    },
    async write(request, tokens) {
      const { data } = await http.request<unknown>(googleDriveWriteRequest(request), tokens);
      if (!isObject(data)) throw new Error("Google Drive returned a malformed write response.");
      return redactDriveObject(data);
    }
  };
}

// Drive v3 file metadata fields we surface. Kept narrow on purpose: name,
// kind, dates, and links — never full ACLs or sensitive inline content.
const DRIVE_FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,webViewLink,iconLink,size";

function googleDriveReadRequest(request: ConnectorRequest): ProviderRequest {
  const input = request.input;
  const pageSize = bounded(input.limit);
  switch (request.capability) {
    case "drive.search":
      return {
        path: "files",
        signal: request.signal,
        query: {
          q: optional(input, "query"),
          pageSize,
          pageToken: request.cursor,
          fields: `files(${DRIVE_FILE_FIELDS}),nextPageToken`,
          orderBy: "modifiedTime desc"
        }
      };
    case "drive.read":
      return {
        path: `files/${required(input, "fileId")}`,
        signal: request.signal,
        query: { fields: DRIVE_FILE_FIELDS }
      };
    default:
      throw new Error(`Unsupported Google Drive read capability: ${request.capability}`);
  }
}

function googleDriveWriteRequest(request: ConnectorWriteRequest): ProviderRequest {
  const input = request.input;
  switch (request.capability) {
    case "google-drive.create-file":
      return { method: "POST", path: "files", body: fileBody(input), signal: request.signal };
    case "google-drive.update-file":
      return { method: "PATCH", path: `files/${required(input, "fileId")}`, body: fileBody(input), signal: request.signal };
    case "google-drive.move-file": {
      const parents = required(input, "addParents");
      return {
        method: "PATCH",
        path: `files/${required(input, "fileId")}`,
        signal: request.signal,
        query: { addParents: parents, removeParents: optional(input, "removeParents"), fields: DRIVE_FILE_FIELDS }
      };
    }
    case "google-drive.rename-file":
      return { method: "PATCH", path: `files/${required(input, "fileId")}`, body: { name: required(input, "name") }, signal: request.signal };
    case "google-drive.share-file":
      return {
        method: "POST",
        path: `files/${required(input, "fileId")}/permissions`,
        body: { type: optional(input, "type") ?? "user", role: required(input, "role"), emailAddress: optional(input, "emailAddress") },
        signal: request.signal
      };
    case "google-drive.delete-file":
      return { method: "DELETE", path: `files/${required(input, "fileId")}`, signal: request.signal };
    default:
      throw new Error(`Unsupported Google Drive write capability: ${request.capability}`);
  }
}

function fileBody(input: Record<string, unknown>): JsonObject {
  const body: JsonObject = {};
  const name = optional(input, "name");
  if (name) body.name = name;
  const mimeType = optional(input, "mimeType");
  if (mimeType) body.mimeType = mimeType;
  const description = optional(input, "description");
  if (description) body.description = description;
  return body;
}

function redactDriveObject(value: JsonObject): JsonObject {
  // Drop permission/ACL detail and any embedded credential-ish fields so the
  // knowledge layer never persists sharing grants alongside file metadata.
  const copy = { ...value };
  for (const key of ["permissions", "owners", "lastModifyingUser", "sharedWithMeTime", "permissionIds", "apiKey", "token"]) {
    delete copy[key];
  }
  return copy;
}

function googleDriveNextCursor(data: unknown): string | undefined {
  const token = stringValue(data, "nextPageToken");
  return token && token.length > 0 ? token : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error(`Google Drive capability requires ${key}.`);
  }
  return String(value);
}
function optional(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}
function bounded(value: unknown): number {
  return typeof value === "number" ? Math.max(1, Math.min(100, Math.floor(value))) : 25;
}
