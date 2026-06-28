import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, oauthClient, page, type FetchLike, type JsonObject, type OAuthClientOptions } from "./http";

const slackCapabilities: Array<[string, "read" | "write", boolean]> = [
  ["slack.channels.list", "read", false], ["slack.messages.search", "read", false], ["slack.history.read", "read", false],
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
    tokenEndpoint: new URL("oauth/slack/token", broker).toString(),
    identityEndpoint: new URL("oauth/slack/identity", broker).toString(),
    revocationEndpoint: new URL("oauth/slack/revoke", broker).toString(),
    scopes: [
      "channels:read", "groups:read", "im:read", "mpim:read",
      "users:read", "search:read", "chat:write", "reactions:write"
    ]
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
  else if (request.capability === "slack.messages.search") [method, input] = ["search.messages", { query: required(i, "query"), count: i.limit ?? 100, page: i.page ?? 1 }];
  else if (request.capability === "slack.history.read") [method, input] = ["conversations.history", { channel: required(i, "channel"), limit: i.limit ?? 100, cursor: request.cursor, oldest: i.oldest, latest: i.latest }];
  else if (request.capability === "slack.thread.read") [method, input] = ["conversations.replies", { channel: required(i, "channel"), ts: required(i, "ts"), limit: i.limit ?? 100, cursor: request.cursor }];
  else if (request.capability === "slack.users.list") [method, input] = ["users.list", { limit: i.limit ?? 200, cursor: request.cursor }];
  else throw new Error(`Unsupported Slack read capability: ${request.capability}`);
  const data = await slackApi(http, method, input, tokens, "GET", request.signal);
  const items = data.channels ?? data.messages?.matches ?? data.messages ?? data.members ?? [];
  return page(items, data.response_metadata?.next_cursor || undefined);
}

async function slackApi(http: ProviderHttpClient, method: string, input: Record<string, unknown>, tokens: ConnectorTokenSet, verb = "GET", signal?: AbortSignal): Promise<any> {
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const { data } = await http.request<any>({ method: verb, path: method, ...(verb === "GET" ? { query: clean as Record<string, string> } : { body: clean }), signal }, tokens);
  if (!data.ok) { const code = String(data.error ?? "unknown"); throw { connectorId: "slack", code: code === "invalid_auth" || code === "token_revoked" ? "expired-auth" : code === "missing_scope" ? "permission-denied" : code.includes("not_in_channel") || code.includes("channel_not_found") ? "not-found" : code === "ratelimited" ? "rate-limited" : "invalid-request", message: `Slack rejected the request (${code}).`, retryable: code === "ratelimited" }; }
  return data;
}
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Slack ${key} is required.`); return value; }

/** Resolve Slack workspace identity from auth.test. */
export async function slackIdentity(http: ProviderHttpClient, tokens: ConnectorTokenSet): Promise<ConnectorAccountSummary> {
  const data = await slackApi(http, "auth.test", {}, tokens);
  return { id: String(data.user_id ?? data.bot_id), displayName: String(data.user ?? "Slack account"), workspace: String(data.team ?? "Slack workspace"), handle: String(data.url ?? "") };
}
