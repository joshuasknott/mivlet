import type { ConnectorAccountSummary, ConnectorCapability, ConnectorError, ConnectorErrorCode, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, oauthClient, page, type FetchLike, type JsonObject, type OAuthClientOptions } from "./http";

const slackCapabilities: Array<[string, "read" | "write", boolean]> = [
  ["slack.channels.list", "read", false], ["slack.history.read", "read", false],
  ["slack.thread.read", "read", false], ["slack.users.list", "read", false], ["slack.message.post", "write", true],
  ["slack.reply.post", "write", true], ["slack.message.update", "write", true], ["slack.message.delete", "write", true],
  ["slack.reaction.add", "write", true], ["slack.reaction.remove", "write", true]
];
export const SLACK_CAPABILITIES: ConnectorCapability[] = slackCapabilities.map(([id, kind, consequential]) => ({ id, kind, consequential, description: id.replaceAll(".", " ") }));

export interface SlackAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

/**
 * Real Slack REST adapter. The confidential client exchange + identity stays at
 * the configured auth broker; this adapter only performs direct Slack Web API
 * reads and writes with a token resolved by the desktop credential boundary.
 */
export function createSlackAdapter(options: SlackAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const broker = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options, connectorId: "slack",
    authorizationEndpoint: new URL("oauth/slack/authorize", broker).toString(),
    handoffEndpoint: new URL("oauth/slack/handoff", broker).toString(),
    refreshEndpoint: new URL("oauth/slack/refresh", broker).toString(),
    revocationEndpoint: new URL("oauth/slack/revoke", broker).toString(),
    scopes: [
      "channels:read", "groups:read", "im:read", "mpim:read",
      "channels:history", "groups:history",
      "users:read", "chat:write", "reactions:write"
    ]
  });
  const http = new ProviderHttpClient("slack", options.apiBaseUrl ?? "https://slack.com/api/", options.fetch);
  return {
    id: "slack", capabilities: SLACK_CAPABILITIES, ...auth,
    async read(request, tokens) { return readSlack(http, request, tokens); },
    async write(request, tokens) {
      const methods: Record<string, string> = { "slack.message.post": "chat.postMessage", "slack.reply.post": "chat.postMessage", "slack.message.update": "chat.update", "slack.message.delete": "chat.delete", "slack.reaction.add": "reactions.add", "slack.reaction.remove": "reactions.remove" };
      const method = methods[request.capability]; if (!method) throw new Error(`Unsupported Slack write capability: ${request.capability}`);
      requireSlackWriteInput(request.capability, request.input);
      // Slack Web API writes have no idempotency support, so a retryable
      // classification would risk duplicate posts/updates. Writes never retry.
      return slackApi(http, method, request.input, tokens, "POST", request.signal, false);
    }
  };
}

async function readSlack(http: ProviderHttpClient, request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<JsonObject>> {
  const i = request.input; let method: string; let input: Record<string, unknown>;
  // A blank cursor means "start from the first page", never an empty cursor
  // parameter that Slack would reject with invalid_cursor.
  const cursor = request.cursor || undefined;
  if (request.capability === "slack.channels.list") [method, input] = ["conversations.list", { limit: i.limit ?? 200, cursor, types: i.types ?? "public_channel,private_channel" }];
  else if (request.capability === "slack.history.read") [method, input] = ["conversations.history", { channel: required(i, "channel"), limit: i.limit ?? 100, cursor, oldest: i.oldest, latest: i.latest }];
  else if (request.capability === "slack.thread.read") [method, input] = ["conversations.replies", { channel: required(i, "channel"), ts: required(i, "ts"), limit: i.limit ?? 100, cursor }];
  else if (request.capability === "slack.users.list") [method, input] = ["users.list", { limit: i.limit ?? 200, cursor }];
  else throw new Error(`Unsupported Slack read capability: ${request.capability}`);
  const data = await slackApi(http, method, input, tokens, "GET", request.signal);
  const messages = data.messages;
  const messageRecord =
    typeof messages === "object" && messages !== null && !Array.isArray(messages)
      ? messages as JsonObject
      : undefined;
  const metadata =
    typeof data.response_metadata === "object" &&
    data.response_metadata !== null &&
    !Array.isArray(data.response_metadata)
      ? data.response_metadata as JsonObject
      : undefined;
  const items =
    arrayValue(data.channels) ??
    arrayValue(messageRecord?.matches) ??
    arrayValue(messages) ??
    arrayValue(data.members) ??
    [];
  // A next_cursor identical to the requested cursor never advances the page;
  // dropping it keeps pagination bounded instead of looping forever.
  const nextCursor =
    typeof metadata?.next_cursor === "string" && metadata.next_cursor && metadata.next_cursor !== request.cursor
      ? metadata.next_cursor
      : undefined;
  return page(items.map(slackRecord), nextCursor);
}

async function slackApi(http: ProviderHttpClient, method: string, input: Record<string, unknown>, tokens: ConnectorTokenSet, verb = "GET", signal?: AbortSignal, retryable = true): Promise<JsonObject> {
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  let data: unknown;
  let retryAfter: string | undefined;
  try {
    const result = await http.request<unknown>({ method: verb, path: method, ...(verb === "GET" ? { query: clean as Record<string, string> } : { body: clean }), signal }, tokens);
    data = result.data;
    retryAfter = result.headers.get("retry-after") ?? undefined;
  } catch (error) {
    throw slackHttpError(error, retryable);
  }
  const response = slackRecord(data);
  if (response.ok !== true) { const code = String(response.error ?? "unknown"); throw slackRejectedError(code, retryable, retryAfter); }
  return response;
}
function requireSlackWriteInput(capability: string, input: Record<string, unknown>): void {
  if (capability === "slack.message.post" || capability === "slack.reply.post") {
    required(input, "channel");
    required(input, "text");
    if (capability === "slack.reply.post") required(input, "thread_ts");
  } else if (capability === "slack.message.update") {
    required(input, "channel");
    required(input, "ts");
    required(input, "text");
  } else if (capability === "slack.message.delete") {
    required(input, "channel");
    required(input, "ts");
  } else if (capability === "slack.reaction.add" || capability === "slack.reaction.remove") {
    required(input, "channel");
    required(input, "timestamp");
    required(input, "name");
  }
}
function slackRejectedError(code: string, retryable: boolean, retryAfter?: string): ConnectorError {
  const connectorCode = slackErrorCode(code);
  const seconds = Number(retryAfter);
  const retryAfterMs = retryAfter !== undefined && Number.isFinite(seconds) && seconds >= 0 ? String(seconds * 1000) : undefined;
  return {
    connectorId: "slack",
    code: connectorCode,
    message: `Slack rejected the request (${code}).`,
    retryable: retryable && (connectorCode === "rate-limited" || connectorCode === "provider-unavailable"),
    ...(retryAfterMs !== undefined ? { retryAfter: retryAfterMs } : {})
  };
}
function slackHttpError(error: unknown, retryable: boolean): never {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  if (retryable) throw error;
  const source = error as Partial<ConnectorError>;
  throw {
    connectorId: source.connectorId ?? "slack",
    code: source.code ?? "unknown",
    message: source.message ?? "Slack rejected the request.",
    retryable: false,
    ...(source.retryAfter !== undefined ? { retryAfter: source.retryAfter } : {})
  } satisfies ConnectorError;
}
function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) {
    throw { connectorId: "slack", code: "invalid-request", message: `Slack ${key} is required.`, retryable: false } satisfies ConnectorError;
  }
  return value;
}
function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
function slackRecord(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw { connectorId: "slack", code: "unknown", message: "Slack returned an invalid response.", retryable: false } satisfies ConnectorError;
  }
  return value as JsonObject;
}
function slackErrorCode(code: string): ConnectorErrorCode {
  switch (code) {
    case "missing_scope": case "no_permission": case "access_denied": case "ekm_access_denied":
    case "team_access_not_granted": case "not_allowed_token_type": case "app_access_restricted":
    case "restricted_action": case "restricted_action_read_only_channel": case "restricted_action_thread_locked":
    case "restricted_action_thread_only_channel": case "restricted_action_non_threadable_channel":
      return "permission-denied";
    case "invalid_auth": case "token_revoked": case "token_expired": case "account_inactive": case "not_authed":
      return "expired-auth";
    case "channel_not_found": case "not_in_channel": case "channel_is_limited_access": case "team_not_found":
    case "duplicate_channel_not_found": case "duplicate_message_not_found":
      return "not-found";
    case "ratelimited": case "rate_limited": case "message_limit_exceeded":
      return "rate-limited";
    case "service_unavailable": case "internal_error": case "fatal_error": case "request_timeout":
    case "accesslimited": case "enterprise_is_restricted": case "team_added_to_org": case "org_login_required":
      return "provider-unavailable";
    case "invalid_arguments": case "invalid_arg_name": case "invalid_array_arg": case "invalid_blocks":
    case "invalid_blocks_format": case "invalid_charset": case "invalid_cursor": case "invalid_form_data":
    case "invalid_metadata_filter_keys": case "invalid_metadata_format": case "invalid_metadata_schema":
    case "invalid_post_type": case "invalid_ts_latest": case "invalid_ts_oldest": case "is_archived":
    case "missing_post_type": case "missing_file_data": case "no_text": case "too_many_attachments":
    case "too_many_contact_cards": case "markdown_text_conflict": case "metadata_must_be_sent_from_app":
    case "metadata_too_large": case "msg_blocks_too_long": case "attachment_payload_limit_exceeded":
    case "cannot_reply_to_message": case "messages_tab_disabled": case "deprecated_endpoint": case "method_deprecated":
    case "draft_already_deleted": case "draft_already_sent": case "draft_has_conflict": case "draft_not_found":
      return "invalid-request";
    default:
      return "unknown";
  }
}

/** Resolve Slack workspace identity from auth.test. */
export async function slackIdentity(http: ProviderHttpClient, tokens: ConnectorTokenSet): Promise<ConnectorAccountSummary> {
  const data = await slackApi(http, "auth.test", {}, tokens);
  const id = data.user_id ?? data.bot_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Slack returned an invalid account identity.");
  }
  return {
    id,
    displayName: typeof data.user === "string" ? data.user : "Slack account",
    workspace: typeof data.team === "string" ? data.team : "Slack workspace",
    handle: typeof data.url === "string" ? data.url : ""
  };
}