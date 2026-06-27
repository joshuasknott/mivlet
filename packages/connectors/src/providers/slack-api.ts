import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorAuthCallback, ConnectorAuthContext, ConnectorAuthResult, ConnectorAuthStart, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, page, type ProviderFetch } from "./http";

const slackCapabilities: Array<[string, "read" | "write", boolean]> = [
  ["slack.channels.list", "read", false], ["slack.messages.search", "read", false], ["slack.history.read", "read", false],
  ["slack.thread.read", "read", false], ["slack.users.list", "read", false], ["slack.message.post", "write", true],
  ["slack.reply.post", "write", true], ["slack.message.update", "write", true], ["slack.message.delete", "write", true],
  ["slack.reaction.add", "write", true], ["slack.reaction.remove", "write", true]
];
export const SLACK_CAPABILITIES: ConnectorCapability[] = slackCapabilities.map(([id, kind, consequential]) => ({ id, kind, consequential, description: id.replaceAll(".", " ") }));

export class SlackAdapter implements ConnectorAdapter<Record<string, unknown>, Record<string, unknown>> {
  readonly id = "slack";
  readonly capabilities = SLACK_CAPABILITIES;
  private readonly http: ProviderHttpClient;
  constructor(fetcher?: ProviderFetch, private readonly brokerUrl = "https://auth.fable.app/") { this.http = new ProviderHttpClient(this.id, "https://slack.com/api/", fetcher); }
  async startAuth(context: ConnectorAuthContext): Promise<ConnectorAuthStart> { const url = new URL("oauth/slack/authorize", this.brokerUrl); url.search = new URLSearchParams({ redirect_uri: context.redirectUri, state: context.state, code_challenge: context.codeChallenge, code_challenge_method: "S256" }).toString(); return { authorizationUrl: url.toString(), state: context.state }; }
  async completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult> { const response = await fetch(new URL("oauth/slack/token", this.brokerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(callback) }); if (!response.ok) throw new Error("Slack OAuth token exchange was rejected."); return response.json() as Promise<ConnectorAuthResult>; }
  async refresh(tokens: ConnectorTokenSet) { return tokens; }
  async revoke(tokens: ConnectorTokenSet) { await this.api("auth.revoke", {}, tokens, "POST"); }
  async identity(tokens: ConnectorTokenSet): Promise<ConnectorAccountSummary> { const data = await this.api("auth.test", {}, tokens); return { id: String(data.user_id ?? data.bot_id), displayName: String(data.user ?? "Slack account"), workspace: String(data.team ?? "Slack workspace"), handle: String(data.url ?? "") }; }
  async read(request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<Record<string, unknown>>> {
    const i = request.input; let method: string; let input: Record<string, unknown>;
    if (request.capability === "slack.channels.list") [method, input] = ["conversations.list", { limit: i.limit ?? 200, cursor: request.cursor, types: i.types ?? "public_channel,private_channel" }];
    else if (request.capability === "slack.messages.search") [method, input] = ["search.messages", { query: required(i, "query"), count: i.limit ?? 100, page: i.page ?? 1 }];
    else if (request.capability === "slack.history.read") [method, input] = ["conversations.history", { channel: required(i, "channel"), limit: i.limit ?? 100, cursor: request.cursor, oldest: i.oldest, latest: i.latest }];
    else if (request.capability === "slack.thread.read") [method, input] = ["conversations.replies", { channel: required(i, "channel"), ts: required(i, "ts"), limit: i.limit ?? 100, cursor: request.cursor }];
    else if (request.capability === "slack.users.list") [method, input] = ["users.list", { limit: i.limit ?? 200, cursor: request.cursor }];
    else throw new Error(`Unsupported Slack read capability: ${request.capability}`);
    const data = await this.api(method, input, tokens, "GET", request.signal);
    const items = data.channels ?? data.messages?.matches ?? data.messages ?? data.members ?? [];
    return page(items, data.response_metadata?.next_cursor || undefined);
  }
  async write(request: ConnectorWriteRequest, tokens: ConnectorTokenSet): Promise<Record<string, unknown>> {
    const methods: Record<string, string> = { "slack.message.post": "chat.postMessage", "slack.reply.post": "chat.postMessage", "slack.message.update": "chat.update", "slack.message.delete": "chat.delete", "slack.reaction.add": "reactions.add", "slack.reaction.remove": "reactions.remove" };
    const method = methods[request.capability]; if (!method) throw new Error(`Unsupported Slack write capability: ${request.capability}`);
    return this.api(method, request.input, tokens, "POST", request.signal);
  }
  private async api(method: string, input: Record<string, unknown>, tokens: ConnectorTokenSet, verb = "GET", signal?: AbortSignal): Promise<any> {
    const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    const { data } = await this.http.request<any>({ method: verb, path: method, ...(verb === "GET" ? { query: clean as Record<string, string> } : { body: clean }), signal }, tokens);
    if (!data.ok) { const code = String(data.error ?? "unknown"); throw { connectorId: "slack", code: code === "invalid_auth" || code === "token_revoked" ? "expired-auth" : code === "missing_scope" ? "permission-denied" : code.includes("not_in_channel") || code.includes("channel_not_found") ? "not-found" : code === "ratelimited" ? "rate-limited" : "invalid-request", message: `Slack rejected the request (${code}).`, retryable: code === "ratelimited" }; }
    return data;
  }
}
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Slack ${key} is required.`); return value; }
