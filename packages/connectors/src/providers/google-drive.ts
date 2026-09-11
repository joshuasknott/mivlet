import type {
  ConnectorCapability,
  ConnectorError,
  ConnectorErrorCode,
  ConnectorPage,
  ConnectorSearchItem,
  ConnectorTokenSet
} from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import {
  ProviderHttpClient,
  asObjects,
  googleOAuthClient,
  isObject,
  page,
  providerError,
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
  assertGoogleScopes,
  googleConfigurationMessage,
  googleConnectorPermissions,
  googleOAuthEndpoints,
  googleRequiredScopeIds,
  googleScopeDescriptions,
  googleScopeIds
} from "./google-shared";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Google Docs plain-text export. Narrow on purpose: only editable Google Docs
// export to plain text; Sheets, Slides, folders, and binaries are never pulled
// and no broader Drive scope is requested. Bounds mirror the native import
// boundary (20k preview characters, 4 MiB payload, 30s request timeout) so the
// adapter never ingests unbounded content.
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_DOC_EXPORT_MIME = "text/plain";
const DRIVE_EXPORT_FIELDS = "id,name,mimeType,modifiedTime,webViewLink";
const DRIVE_EXPORT_MAX_CHARACTERS = 20_000;
const DRIVE_EXPORT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DRIVE_EXPORT_TIMEOUT_MS = 30_000;
const DRIVE_EXPORT_MAX_REDIRECTS = 3;

export const GOOGLE_DRIVE_CAPABILITIES = [
  { id: "drive.search", kind: "read", consequential: false, description: "Search accessible Drive metadata." },
  { id: "drive.read", kind: "read", consequential: false, description: "Read an authorized Drive file's metadata." },
  { id: "drive.export", kind: "read", consequential: false, description: "Export an authorized Google Docs file as bounded plain text." },
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
      ? "File explicitly selected for Mivlet"
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
  scopes?: readonly string[];
}

export function createGoogleDriveAdapter(
  options: GoogleDriveAdapterOptions
): ConnectorAdapter<JsonObject, JsonObject> {
  const endpoints = googleOAuthEndpoints(options.authBaseUrl);
  const auth = googleOAuthClient({
    ...options,
    connectorId: "google-drive",
    ...endpoints,
    scopes: options.scopes ?? googleRequiredScopeIds("google-drive")
  });
  const apiBaseUrl = options.apiBaseUrl ?? "https://www.googleapis.com/drive/v3/";
  const http = new ProviderHttpClient("google-drive", apiBaseUrl, options.fetch);
  const fetcher = options.fetch ?? fetch;
  return {
    id: "google-drive",
    capabilities: GOOGLE_DRIVE_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      assertGoogleScopes(
        "google-drive",
        tokens,
        request.capability === "drive.search"
          ? [DRIVE_FILE_SCOPE, DRIVE_METADATA_SCOPE, DRIVE_READ_SCOPE]
          : [DRIVE_FILE_SCOPE, DRIVE_READ_SCOPE]
      );
      if (request.capability === "drive.export") {
        return googleDriveExportDocument(http, apiBaseUrl, fetcher, request, tokens);
      }
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
      assertGoogleScopes("google-drive", tokens, [DRIVE_FILE_SCOPE]);
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

/**
 * Bounded read-only export of a Google Docs file as plain text.
 *
 * The export path is deliberately narrow and defensive:
 * - Metadata lookup stays distinct from content retrieval. The exact file's
 *   MIME type is checked first; only `application/vnd.google-apps.document`
 *   is exportable to plain text. Sheets, Slides, folders, and binaries fail
 *   closed before any content request.
 * - Content egress enforces a 4 MiB payload cap, a 30s timeout, and forwards
 *   caller cancellation. Credentials are attached only to the original Google
 *   export endpoint and are never re-sent to a redirect target.
 * - The returned item preserves file identity, name, source URL, MIME type,
 *   provenance, and carries the bounded plain-text preview for ingestion.
 */
async function googleDriveExportDocument(
  http: ProviderHttpClient,
  apiBaseUrl: string,
  fetcher: FetchLike,
  request: ConnectorRequest,
  tokens: ConnectorTokenSet
): Promise<ConnectorPage<JsonObject>> {
  const fileId = required(request.input, "fileId");
  const { data } = await http.request<JsonObject>(
    { path: `files/${fileId}`, signal: request.signal, query: { fields: DRIVE_EXPORT_FIELDS } },
    tokens
  );
  const id = stringValue(data, "id");
  const name = stringValue(data, "name");
  const mimeType = stringValue(data, "mimeType");
  if (!id || !name || !mimeType) {
    throw driveExportError("invalid-request", "Drive returned malformed file metadata.");
  }
  if (mimeType !== GOOGLE_DOC_MIME) {
    throw driveExportError(
      "invalid-request",
      "This Drive item is not a Google Docs document and cannot be exported as plain text."
    );
  }
  const text = await fetchDriveExportText(apiBaseUrl, fetcher, fileId, tokens, request.signal);
  const characters = Array.from(text);
  const truncated = characters.length > DRIVE_EXPORT_MAX_CHARACTERS;
  const preview = truncated ? characters.slice(0, DRIVE_EXPORT_MAX_CHARACTERS).join("") : text;
  const item = normalizeGoogleDriveItem({
    id,
    name,
    mimeType,
    modifiedTime: stringValue(data, "modifiedTime"),
    webViewLink: stringValue(data, "webViewLink"),
    textExport: preview,
    selected: request.input.selected === true
  });
  const exported: JsonObject = {
    ...item,
    providerMetadata: {
      ...item.providerMetadata,
      ...(truncated ? { truncated: "true" } : {})
    }
  };
  return page([exported]);
}

async function fetchDriveExportText(
  apiBaseUrl: string,
  fetcher: FetchLike,
  fileId: string,
  tokens: ConnectorTokenSet,
  callerSignal?: AbortSignal
): Promise<string> {
  const { signal, cleanup } = boundExportSignal(callerSignal);
  try {
    const url = new URL(`files/${fileId}/export`, apiBaseUrl);
    url.searchParams.set("mimeType", GOOGLE_DOC_EXPORT_MIME);
    let current = url.toString();
    // Credentials are attached only to the original Google export endpoint.
    // A redirect target is followed without re-sending the Authorization
    // header; the redirect chain is bounded.
    let authorized = true;
    for (let hop = 0; hop <= DRIVE_EXPORT_MAX_REDIRECTS; hop += 1) {
      if (signal.aborted) throw exportAbort(signal);
      let response: Response;
      try {
        response = await fetcher(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            accept: GOOGLE_DOC_EXPORT_MIME,
            ...(authorized
              ? { authorization: `${tokens.tokenType || "Bearer"} ${tokens.accessToken}` }
              : {})
          }
        });
      } catch (error) {
        throw mapExportEgressError(signal, error);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop === DRIVE_EXPORT_MAX_REDIRECTS) {
          throw driveExportError(
            "invalid-request",
            "The Drive export redirected too many times."
          );
        }
        current = new URL(location, current).toString();
        authorized = false;
        continue;
      }
      if (!response.ok) {
        throw providerError(
          "google-drive",
          response.status,
          undefined,
          response.headers.get("retry-after") ?? undefined
        );
      }
      return await readBoundedExportText(response, signal);
    }
    throw driveExportError("invalid-request", "The Drive export redirected too many times.");
  } finally {
    cleanup();
  }
}

async function readBoundedExportText(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DRIVE_EXPORT_MAX_RESPONSE_BYTES) {
    throw driveExportError("invalid-request", "This Drive document exceeds Mivlet's safe export size limit.");
  }
  let bytes: Uint8Array;
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (signal.aborted) throw exportAbort(signal);
    bytes = new Uint8Array(buffer);
    if (bytes.byteLength > DRIVE_EXPORT_MAX_RESPONSE_BYTES) {
      throw driveExportError("invalid-request", "This Drive document exceeds Mivlet's safe export size limit.");
    }
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        if (signal.aborted) throw exportAbort(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > DRIVE_EXPORT_MAX_RESPONSE_BYTES) {
            throw driveExportError(
              "invalid-request",
              "This Drive document exceeds Mivlet's safe export size limit."
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw driveExportError(
      "invalid-request",
      "This Drive document is not plain text and cannot be imported."
    );
  }
}

/** A caller-aware export signal: caller cancellation wins, otherwise a hard timeout. */
function boundExportSignal(
  callerSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortForCaller = () => controller.abort(callerSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new DOMException("The Drive export timed out.", "TimeoutError")),
    DRIVE_EXPORT_TIMEOUT_MS
  );
  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", abortForCaller, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortForCaller);
    }
  };
}

function mapExportEgressError(signal: AbortSignal, error: unknown): unknown {
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      return driveExportError(
        "provider-unavailable",
        "The Drive export timed out before it could complete."
      );
    }
    return reason instanceof Error ? reason : exportAbort(signal);
  }
  if (error instanceof DOMException && error.name === "AbortError") return error;
  return providerError("google-drive", 0, undefined, undefined);
}

function exportAbort(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new DOMException("The Drive export was cancelled.", "AbortError");
}

function driveExportError(code: ConnectorErrorCode, message: string): ConnectorError {
  return { connectorId: "google-drive", code, message, retryable: false };
}
