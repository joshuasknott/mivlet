import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, oauthClient, page, type FetchLike, type JsonObject, type OAuthClientOptions } from "./http";

const API = "https://api.notion.com/v1/";
const VERSION = "2022-06-28";

const notionCapabilities: Array<[string, "read" | "write", boolean]> = [
  ["notion.search", "read", false], ["notion.page.read", "read", false], ["notion.blocks.read", "read", false],
  ["notion.database.query", "read", false], ["notion.page.create", "write", true], ["notion.page.update", "write", true],
  ["notion.blocks.append", "write", true], ["notion.block.update", "write", true], ["notion.block.delete", "write", true],
  ["notion.comment.create", "write", true], ["notion.database-entry.create", "write", true]
];
export const NOTION_CAPABILITIES: ConnectorCapability[] = notionCapabilities.map(([id, kind, consequential]) => ({ id, kind, consequential, description: id.replaceAll(".", " ") }));

export interface NotionAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

/**
 * Real Notion REST adapter. The confidential client exchange + identity stays at
 * the configured auth broker; this adapter only performs direct Notion API reads
 * and writes with a token resolved by the desktop credential boundary. Integration
 * sharing is honored by Notion's own sharing model — only pages/databases the
 * integration was explicitly given produce search results or readable blocks.
 */
export function createNotionAdapter(options: NotionAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const broker = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options, connectorId: "notion",
    authorizationEndpoint: new URL("oauth/notion/authorize", broker).toString(),
    handoffEndpoint: new URL("oauth/notion/handoff", broker).toString(),
    refreshEndpoint: new URL("oauth/notion/refresh", broker).toString(),
    revocationEndpoint: new URL("oauth/notion/revoke", broker).toString(),
    scopes: []
  });
  const http = new ProviderHttpClient("notion", options.apiBaseUrl ?? API, options.fetch);
  return {
    id: "notion", capabilities: NOTION_CAPABILITIES, ...auth,
    async read(request, tokens) { return readNotion(http, request, tokens); },
    async write(request, tokens) {
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
      const { data } = await http.request<JsonObject>({ method: route[0], path: route[1], body: route[2], signal: request.signal, headers: version() }, tokens);
      return data;
    }
  };
}

async function readNotion(http: ProviderHttpClient, request: ConnectorRequest, tokens: ConnectorTokenSet): Promise<ConnectorPage<JsonObject>> {
  const input = request.input;
  if (request.capability === "notion.search") {
    const { data, headers } = await http.request<unknown>({ method: "POST", path: "search", signal: request.signal, headers: version(), body: { query: input.query ?? "", page_size: input.pageSize ?? 50, ...(request.cursor ? { start_cursor: request.cursor } : {}), ...(input.object ? { filter: { property: "object", value: input.object } } : {}) } }, tokens);
    const result = notionListResponse(data);
    return page(result.results.map(normalizeNotionObject), result.nextCursor, headers);
  }
  if (request.capability === "notion.page.read") return one(await call(http, `pages/${required(input, "pageId")}`, tokens, request));
  if (request.capability === "notion.blocks.read") {
    const { data, headers } = await http.request<unknown>({ path: `blocks/${required(input, "blockId")}/children`, signal: request.signal, headers: version(), query: { page_size: Number(input.pageSize ?? 100), start_cursor: request.cursor } }, tokens);
    const result = notionListResponse(data);
    return page(result.results.map(normalizeNotionObject), result.nextCursor, headers);
  }
  if (request.capability === "notion.database.query") {
    const { data, headers } = await http.request<unknown>({ method: "POST", path: `databases/${required(input, "databaseId")}/query`, signal: request.signal, headers: version(), body: { ...(input.filter ? { filter: input.filter } : {}), ...(input.sorts ? { sorts: input.sorts } : {}), ...(request.cursor ? { start_cursor: request.cursor } : {}), page_size: input.pageSize ?? 100 } }, tokens);
    const result = notionListResponse(data);
    return page(result.results.map(normalizeNotionObject), result.nextCursor, headers);
  }
  throw new Error(`Unsupported Notion read capability: ${request.capability}`);
}

async function call(http: ProviderHttpClient, path: string, tokens: ConnectorTokenSet, request: ConnectorRequest) { return (await http.request<JsonObject>({ path, signal: request.signal, headers: version() }, tokens)).data; }
function version() { return { "notion-version": VERSION }; }
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Notion ${key} is required.`); return value; }
function one(value: JsonObject): ConnectorPage<JsonObject> { return { items: [value] }; }
function record(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Notion returned an invalid ${label}.`);
  }
  return value as JsonObject;
}

function notionListResponse(value: unknown) {
  const response = record(value, "list response");
  const results = Array.isArray(response.results) ? response.results : [];
  const nextCursor =
    response.has_more === true && typeof response.next_cursor === "string"
      ? response.next_cursor
      : undefined;
  return { results, nextCursor };
}

export function normalizeNotionObject(value: unknown): JsonObject {
  const item = record(value, "object");
  return {
    id: item.id,
    object: item.object,
    url: item.url,
    archived: item.archived ?? false,
    parent: item.parent,
    properties: item.properties ?? {},
    createdTime: item.created_time,
    lastEditedTime: item.last_edited_time
  };
}

/** Resolve Notion workspace identity from the provider users/me endpoint. */
export async function notionIdentity(http: ProviderHttpClient, tokens: ConnectorTokenSet): Promise<ConnectorAccountSummary> {
  const { data } = await http.request<unknown>({ path: "users/me", headers: version() }, tokens);
  const identity = record(data, "identity response");
  const bot = typeof identity.bot === "object" && identity.bot !== null
    ? identity.bot as JsonObject
    : {};
  const owner = typeof bot.owner === "object" && bot.owner !== null
    ? bot.owner as JsonObject
    : {};
  const workspace = typeof bot.workspace_name === "string" ? bot.workspace_name : undefined;
  const ownerWorkspace =
    typeof owner.workspace_name === "string" ? owner.workspace_name : undefined;
  if (typeof identity.id !== "string" || identity.id.length === 0) {
    throw new Error("Notion returned an invalid identity.");
  }
  return {
    id: identity.id,
    displayName: ownerWorkspace ?? workspace ?? "Notion workspace",
    workspace
  };
}
