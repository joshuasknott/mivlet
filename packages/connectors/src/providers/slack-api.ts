import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@mivlet/protocol";
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
 * Slack bot scopes Mivlet requests. `chat:write` covers post, reply, edit, and
 * delete; `reactions:write` covers react-add and react-remove. Both match native
 * write actions and are labeled write.
 */
export const SLACK_OAUTH_SCOPES = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "im:read",
  "mpim:read",
  "users:read",
  "chat:write",
  "reactions:write"
] as const;

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
    scopes: [...SLACK_OAUTH_SCOPES]
  });
  const http = new ProviderHttpClient("slack", options.apiBaseUrl ?? "https://slack.com/api/", options.fetch);
  return {
    id: "slack", capabilities: SLACK_CAPABILITIES, ...auth,
    async read(request, tokens) { return readSlack(http, request, tokens); },
    async write(request, tokens) {
      const methods: Record<string, string> = { "slack.message.post": "chat.postMessage", "slack.reply.post": "chat.postMessage", "slack.message.update": "chat.update", "slack.message.delete": "chat.delete", "slack.reaction.add": "reactions.add", "slack.reaction.remove": "reactions.remove" };
      const method = methods[request.capability]; if (!method) throw new Error(`Unsupported Slack write capability: ${request.capability}`);
      return slackApi(http, method, request.input, tokens, "POST", request.signal);
    }
  };
}

async function readSlack(http: ProviderHttpClient, request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<JsonObject>> {
  const i = request.input; let method: string; let input: Record<string, unknown>;
  if (request.capability === "slack.channels.list") [method, input] = ["conversations.list", { limit: i.limit ?? 200, cursor: request.cursor, types: i.types ?? "public_channel,private_channel" }];
  else if (request.capability === "slack.history.read") [method, input] = ["conversations.history", { channel: required(i, "channel"), limit: i.limit ?? 100, cursor: request.cursor, oldest: i.oldest, latest: i.latest }];
  else if (request.capability === "slack.thread.read") [method, input] = ["conversations.replies", { channel: required(i, "channel"), ts: required(i, "ts"), limit: i.limit ?? 100, cursor: request.cursor }];
  else if (request.capability === "slack.users.list") [method, input] = ["users.list", { limit: i.limit ?? 200, cursor: request.cursor }];
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
  const nextCursor =
    typeof metadata?.next_cursor === "string" && metadata.next_cursor
      ? metadata.next_cursor
      : undefined;
  return page(items.map(slackRecord), nextCursor);
}

async function slackApi(http: ProviderHttpClient, method: string, input: Record<string, unknown>, tokens: ConnectorTokenSet, verb = "GET", signal?: AbortSignal): Promise<JsonObject> {
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const { data } = await http.request<unknown>({ method: verb, path: method, ...(verb === "GET" ? { query: clean as Record<string, string> } : { body: clean }), signal }, tokens);
  const response = slackRecord(data);
  if (response.ok !== true) { const code = String(response.error ?? "unknown"); throw { connectorId: "slack", code: code === "invalid_auth" || code === "token_revoked" ? "expired-auth" : code === "missing_scope" ? "permission-denied" : code.includes("not_in_channel") || code.includes("channel_not_found") ? "not-found" : code === "ratelimited" ? "rate-limited" : "invalid-request", message: `Slack rejected the request (${code}).`, retryable: code === "ratelimited" }; }
  return response;
}
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Slack ${key} is required.`); return value; }
function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
function slackRecord(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Slack returned an invalid response.");
  }
  return value as JsonObject;
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
