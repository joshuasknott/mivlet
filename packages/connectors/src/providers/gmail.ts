import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import {
  ProviderHttpClient,
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
  assertGoogleScopes,
  googleConfigurationMessage,
  googleConnectorPermissions,
  googleOAuthEndpoints,
  googleRequiredScopeIds,
  googleScopeDescriptions,
  googleScopeIds
} from "./google-shared";

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GMAIL_CAPABILITIES = [
  { id: "gmail.search", kind: "read", consequential: false, description: "Search selected mailbox results." },
  { id: "gmail.read", kind: "read", consequential: false, description: "Read a selected message or thread." },
  { id: "gmail.create-draft", kind: "write", consequential: true, description: "Create an approved draft." },
  { id: "gmail.send", kind: "write", consequential: true, description: "Send one explicitly approved message." }
] satisfies ConnectorCapability[];

export const GMAIL_OAUTH_SCOPES = googleScopeIds("gmail");
export const GMAIL_SCOPE_DESCRIPTIONS = googleScopeDescriptions("gmail");
export const GMAIL_PERMISSIONS = googleConnectorPermissions("gmail");
export const GMAIL_SETUP_MESSAGE = googleConfigurationMessage("gmail");

export interface GmailPayload {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  internalDate?: string;
  labels?: string[];
}

export function normalizeGmailItem(payload: GmailPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "gmail",
    title: payload.subject || "(No subject)",
    kind: "message",
    summary: `Message from ${payload.from}`,
    provenance: "Gmail · selected search result",
    freshness: payload.internalDate ?? "Provider freshness unavailable",
    trust: "untrusted",
    contentPreview: payload.snippet,
    providerMetadata: {
      threadId: payload.threadId,
      from: payload.from,
      labels: (payload.labels ?? []).join(",")
    }
  };
}

export function shapeGmailSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("gmail", query, limit);
}

export function prepareGmailDraft(payload: {
  to: string;
  subject: string;
  body: string;
}) {
  return prepareConnectorAction(
    "gmail",
    "Gmail",
    "gmail.create-draft",
    { ...payload, targetId: payload.to },
    "medium",
    "Creates an email draft. It does not send the email."
  );
}

export function prepareGmailSend(payload: {
  draftId?: string;
  to: string;
  subject: string;
  cc?: string;
  bcc?: string;
  body?: string;
  attachments?: string;
}) {
  return prepareConnectorAction(
    "gmail",
    "Gmail",
    "gmail.send",
    { ...payload, targetId: payload.draftId ?? payload.to },
    "high",
    "Sends the selected email to external recipients."
  );
}

export function mapGmailError(error: ProviderErrorLike) {
  return classifyConnectorError("gmail", error);
}

/**
 * Live Gmail adapter. Public-PKCE auth (no broker), per `broker-contract.ts`.
 * Reads map to the Gmail v1 REST surface and walk `nextPageToken` cursors.
 *
 * Sync is conservative by design: list reads return message stubs only
 * (id/threadId), and single-message reads use `format=metadata` limited to a
 * small set of envelope headers plus the snippet — never full message bodies
 * or attachments. That keeps synced data to useful metadata while avoiding
 * pulling and persisting private email content wholesale.
 */
export interface GmailAdapterOptions
  extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  scopes?: readonly string[];
}

export function createGmailAdapter(options: GmailAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const endpoints = googleOAuthEndpoints(options.authBaseUrl);
  const auth = googleOAuthClient({
    ...options,
    connectorId: "gmail",
    ...endpoints,
    scopes: options.scopes ?? googleRequiredScopeIds("gmail")
  });
  const http = new ProviderHttpClient(
    "gmail",
    options.apiBaseUrl ?? "https://gmail.googleapis.com/gmail/v1/users/me/",
    options.fetch
  );
  return {
    id: "gmail",
    capabilities: GMAIL_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      assertGoogleScopes("gmail", tokens, [GMAIL_READ_SCOPE]);
      const mapped = gmailReadRequest(request);
      const { data, response } = await http.request<unknown>(mapped, tokens);
      const messages = isObject(data) && Array.isArray(data.messages)
        ? data.messages.map(redactGmailObject)
        : isObject(data)
          ? [redactGmailObject(data)]
          : [];
      return page(messages, response, gmailNextCursor(data));
    },
    async write(request, tokens) {
      assertGoogleScopes(
        "gmail",
        tokens,
        request.capability === "gmail.create-draft"
          ? [GMAIL_COMPOSE_SCOPE]
          : [GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE]
      );
      const { data } = await http.request<unknown>(gmailWriteRequest(request), tokens);
      if (!isObject(data)) throw new Error("Gmail returned a malformed write response.");
      return redactGmailObject(data);
    }
  };
}

// Gmail metadata reads return envelope headers + snippet without the raw body.
// We never request format=raw in synced reads, so full message content is not
// pulled wholesale.

function gmailReadRequest(request: ConnectorRequest): ProviderRequest {
  const input = request.input;
  switch (request.capability) {
    case "gmail.search":
      return {
        path: "messages",
        signal: request.signal,
        query: {
          q: optional(input, "query"),
          maxResults: bounded(input.limit),
          pageToken: request.cursor
        }
      };
    case "gmail.read":
      return {
        path: `messages/${required(input, "messageId")}`,
        signal: request.signal,
        // format=metadata returns envelope headers + snippet without the raw
        // body. We don't restrict metadataHeaders because the shared query
        // type carries scalars only; the default header set is conservative.
        query: { format: "metadata" }
      };
    default:
      throw new Error(`Unsupported Gmail read capability: ${request.capability}`);
  }
}

function gmailWriteRequest(request: ConnectorWriteRequest): ProviderRequest {
  const input = request.input;
  switch (request.capability) {
    case "gmail.create-draft":
      return { method: "POST", path: "drafts", body: draftBody(input), signal: request.signal };
    case "gmail.send":
      return { method: "POST", path: "messages/send", body: { raw: required(input, "raw") }, signal: request.signal };
    default:
      throw new Error(`Unsupported Gmail write capability: ${request.capability}`);
  }
}

function draftBody(input: Record<string, unknown>): JsonObject {
  const message: JsonObject = {};
  const headers: string[] = [];
  const to = optional(input, "to");
  if (to) headers.push(`To: ${to}`);
  const subject = optional(input, "subject");
  if (subject) headers.push(`Subject: ${subject}`);
  if (headers.length) message.raw = btoa(`${headers.join("\r\n")}\r\n\r\n${optional(input, "body") ?? ""}`);
  return { message };
}

function redactGmailObject(value: JsonObject): JsonObject {
  // Strip raw payload bytes and any history/credential-like fields so the
  // knowledge layer only ever sees envelope metadata, not message bodies.
  const copy = { ...value };
  for (const key of ["raw", "payload", "historyId", "sizeEstimate", "internalDate", "token", "apiKey"]) {
    delete copy[key];
  }
  return copy;
}

function gmailNextCursor(data: unknown): string | undefined {
  const token = stringValue(data, "nextPageToken");
  return token && token.length > 0 ? token : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error(`Gmail capability requires ${key}.`);
  }
  return String(value);
}
function optional(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}
function bounded(value: unknown): number {
  return typeof value === "number" ? Math.max(1, Math.min(100, Math.floor(value))) : 20;
}
