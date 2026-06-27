import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorAuthCallback, ConnectorAuthContext, ConnectorAuthResult, ConnectorAuthStart, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, page, type ProviderFetch } from "./http";

const API = "https://api.notion.com/v1/";
const VERSION = "2022-06-28";

const notionCapabilities: Array<[string, "read" | "write", boolean]> = [
  ["notion.search", "read", false], ["notion.page.read", "read", false], ["notion.blocks.read", "read", false],
  ["notion.database.query", "read", false], ["notion.page.create", "write", true], ["notion.page.update", "write", true],
  ["notion.blocks.append", "write", true], ["notion.block.update", "write", true], ["notion.block.delete", "write", true],
  ["notion.comment.create", "write", true], ["notion.database-entry.create", "write", true]
];
export const NOTION_CAPABILITIES: ConnectorCapability[] = notionCapabilities.map(([id, kind, consequential]) => ({ id, kind, consequential, description: id.replaceAll(".", " ") }));

export class NotionAdapter implements ConnectorAdapter<Record<string, unknown>, Record<string, unknown>> {
  readonly id = "notion";
  readonly capabilities = NOTION_CAPABILITIES;
  private readonly http: ProviderHttpClient;
  constructor(fetcher?: ProviderFetch, private readonly brokerUrl = "https://auth.fable.app/") {
    this.http = new ProviderHttpClient(this.id, API, fetcher);
  }
  async startAuth(context: ConnectorAuthContext): Promise<ConnectorAuthStart> {
    const url = new URL("oauth/notion/authorize", this.brokerUrl);
    url.search = new URLSearchParams({ redirect_uri: context.redirectUri, state: context.state, code_challenge: context.codeChallenge, code_challenge_method: "S256" }).toString();
    return { authorizationUrl: url.toString(), state: context.state };
  }
  async completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult> {
    const response = await fetch(new URL("oauth/notion/token", this.brokerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(callback) });
    if (!response.ok) throw new Error("Notion OAuth token exchange was rejected.");
    return response.json() as Promise<ConnectorAuthResult>;
  }
  async refresh(tokens: ConnectorTokenSet) { return tokens; }
  async revoke(tokens: ConnectorTokenSet) {
    await fetch(new URL("oauth/notion/revoke", this.brokerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: tokens.accessToken }) });
  }
  async identity(tokens: ConnectorTokenSet): Promise<ConnectorAccountSummary> {
    const { data } = await this.http.request<Record<string, any>>({ path: "users/me", headers: version() }, tokens);
    return { id: String(data.id), displayName: data.name ?? data.bot?.owner?.workspace ?? "Notion workspace", workspace: data.bot?.workspace_name };
  }
  async read(request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<Record<string, unknown>>> {
    const input = request.input;
    if (request.capability === "notion.search") {
      const { data, headers } = await this.http.request<any>({ method: "POST", path: "search", signal: request.signal, headers: version(), body: { query: input.query ?? "", page_size: input.pageSize ?? 50, ...(request.cursor ? { start_cursor: request.cursor } : {}), ...(input.object ? { filter: { property: "object", value: input.object } } : {}) } }, tokens);
      return page((data.results ?? []).map(normalizeNotionObject), data.has_more ? data.next_cursor : undefined, headers);
    }
    if (request.capability === "notion.page.read") return one(await this.call(`pages/${required(input, "pageId")}`, tokens, request));
    if (request.capability === "notion.blocks.read") {
      const { data, headers } = await this.http.request<any>({ path: `blocks/${required(input, "blockId")}/children`, signal: request.signal, headers: version(), query: { page_size: Number(input.pageSize ?? 100), start_cursor: request.cursor } }, tokens);
      return page(data.results ?? [], data.has_more ? data.next_cursor : undefined, headers);
    }
    if (request.capability === "notion.database.query") {
      const { data, headers } = await this.http.request<any>({ method: "POST", path: `databases/${required(input, "databaseId")}/query`, signal: request.signal, headers: version(), body: { ...(input.filter ? { filter: input.filter } : {}), ...(input.sorts ? { sorts: input.sorts } : {}), ...(request.cursor ? { start_cursor: request.cursor } : {}), page_size: input.pageSize ?? 100 } }, tokens);
      return page((data.results ?? []).map(normalizeNotionObject), data.has_more ? data.next_cursor : undefined, headers);
    }
    throw new Error(`Unsupported Notion read capability: ${request.capability}`);
  }
  async write(request: ConnectorWriteRequest, tokens: ConnectorTokenSet): Promise<Record<string, unknown>> {
    const i = request.input;
    const routes: Record<string, [string, string, unknown]> = {
      "notion.page.create": ["POST", "pages", i], "notion.database-entry.create": ["POST", "pages", i],
      "notion.page.update": ["PATCH", `pages/${required(i, "pageId")}`, i.patch ?? i],
      "notion.blocks.append": ["PATCH", `blocks/${required(i, "blockId")}/children`, { children: i.children }],
      "notion.block.update": ["PATCH", `blocks/${required(i, "blockId")}`, i.patch ?? i],
      "notion.block.delete": ["DELETE", `blocks/${required(i, "blockId")}`, undefined],
      "notion.comment.create": ["POST", "comments", i]
    };
    const route = routes[request.capability]; if (!route) throw new Error(`Unsupported Notion write capability: ${request.capability}`);
    const { data } = await this.http.request<Record<string, unknown>>({ method: route[0], path: route[1], body: route[2], signal: request.signal, headers: version() }, tokens);
    return data;
  }
  private async call(path: string, tokens: ConnectorTokenSet, request: ConnectorRequest) { return (await this.http.request<Record<string, unknown>>({ path, signal: request.signal, headers: version() }, tokens)).data; }
}

function version() { return { "notion-version": VERSION }; }
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Notion ${key} is required.`); return value; }
function one(value: Record<string, unknown>): ConnectorPage<Record<string, unknown>> { return { items: [value] }; }
export function normalizeNotionObject(value: any): Record<string, unknown> { return { id: value.id, object: value.object, url: value.url, archived: value.archived ?? false, parent: value.parent, properties: value.properties ?? {}, createdTime: value.created_time, lastEditedTime: value.last_edited_time }; }
