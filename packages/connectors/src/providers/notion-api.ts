import type { ConnectorAccountSummary, ConnectorCapability, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, oauthClient, page, type FetchLike, type JsonObject, type OAuthClientOptions } from "./http";

const API = "https://api.notion.com/v1/";

/**
 * Pinned `Notion-Version` for the unchanged page, block, search and
 * single-data-source database surface. Notion still supports this version and
 * has no published retirement plan, so a newer version is not required; the
 * pinned version preserves the pre-2025 `database` object shape that stored
 * search/page/block references and single-source database queries rely on.
 * See https://developers.notion.com/reference/versioning and
 * https://developers.notion.com/guides/get-started/upgrade-faqs-2025-09-03
 */
const VERSION = "2022-06-28";

/**
 * Minimum `Notion-Version` that exposes the `/v1/data_sources` namespace and
 * the query-by-data-source API. Since 2025-09-03 a database is a container for
 * one or more data sources; when a database holds more than one data source,
 * Notion rejects a database-id query on older versions with a 400
 * `validation_error` (`additional_data.error_type` = `multiple_data_sources_for_database`).
 * Only the explicit data-source query path uses this version, and it stays
 * below 2026-03-11, which renames `archived` to `in_trash` in every response.
 * See https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03
 * and https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11
 */
const DATA_SOURCE_VERSION = "2025-09-03";

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
      const [method, path, body] = writeRoute(request.capability, request.input);
      const { data } = await http.request<JsonObject>({ method, path, body, signal: request.signal, headers: version() }, tokens);
      return writeResult(data, request.capability);
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
    const dataSourceId = optionalId(input, "dataSourceId");
    const databaseId = optionalId(input, "databaseId");
    if (dataSourceId && databaseId) {
      throw new Error("Notion dataSourceId and databaseId are mutually exclusive; query a single source explicitly.");
    }
    if (dataSourceId) {
      // Explicit data-source query (2025-09-03+). Database and data-source IDs
      // are distinct identifiers and are never substituted for each other.
      const { data, headers } = await http.request<unknown>({ method: "POST", path: `data_sources/${dataSourceId}/query`, signal: request.signal, headers: dataSourceVersion(), body: databaseQueryBody(input, request.cursor) }, tokens);
      const result = notionListResponse(data);
      return page(result.results.map(normalizeNotionObject), result.nextCursor, headers);
    }
    if (!databaseId) throw new Error("Notion databaseId or dataSourceId is required.");
    const { data, headers } = await http.request<unknown>({ method: "POST", path: `databases/${databaseId}/query`, signal: request.signal, headers: version(), body: databaseQueryBody(input, request.cursor) }, tokens);
    const result = notionListResponse(data);
    return page(result.results.map(normalizeNotionObject), result.nextCursor, headers);
  }
  throw new Error(`Unsupported Notion read capability: ${request.capability}`);
}

async function call(http: ProviderHttpClient, path: string, tokens: ConnectorTokenSet, request: ConnectorRequest) { return (await http.request<JsonObject>({ path, signal: request.signal, headers: version() }, tokens)).data; }
function version() { return { "notion-version": VERSION }; }
function dataSourceVersion() { return { "notion-version": DATA_SOURCE_VERSION }; }
function required(input: Record<string, unknown>, key: string) { const value = input[key]; if (typeof value !== "string" || !value) throw new Error(`Notion ${key} is required.`); return value; }
function optionalId(input: Record<string, unknown>, key: string) { const value = input[key]; return typeof value === "string" && value ? value : undefined; }
function databaseQueryBody(input: Record<string, unknown>, cursor?: string) {
  return {
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.sorts ? { sorts: input.sorts } : {}),
    ...(cursor ? { start_cursor: cursor } : {}),
    page_size: input.pageSize ?? 100
  };
}

/**
 * Write route selection resolves lazily so only the chosen capability's
 * required identifiers are validated; a `notion.page.create` must not require
 * a `pageId` just because the `notion.page.update` route references one.
 */
function writeRoute(capability: string, input: Record<string, unknown>): [string, string, unknown] {
  switch (capability) {
    case "notion.page.create":
    case "notion.database-entry.create":
      return ["POST", "pages", input];
    case "notion.page.update":
      return ["PATCH", `pages/${required(input, "pageId")}`, input.patch ?? input];
    case "notion.blocks.append":
      return ["PATCH", `blocks/${required(input, "blockId")}/children`, { children: input.children }];
    case "notion.block.update":
      return ["PATCH", `blocks/${required(input, "blockId")}`, input.patch ?? input];
    case "notion.block.delete":
      return ["DELETE", `blocks/${required(input, "blockId")}`, undefined];
    case "notion.comment.create":
      return ["POST", "comments", input];
    default:
      throw new Error(`Unsupported Notion write capability: ${capability}`);
  }
}

/**
 * Write-success validation: a 2xx response must still look like the Notion
 * object the capability created or changed, otherwise the write is not
 * reported as successful. A malformed 200 must never complete an approval.
 */
function writeResult(data: JsonObject, capability: string): JsonObject {
  if (capability === "notion.blocks.append") {
    if (data.object !== "list" || !Array.isArray(data.results)) {
      throw new Error("Notion blocks.append returned an invalid write result.");
    }
    return data;
  }
  const expectedObject = {
    "notion.page.create": "page",
    "notion.database-entry.create": "page",
    "notion.page.update": "page",
    "notion.block.update": "block",
    "notion.block.delete": "block",
    "notion.comment.create": "comment"
  }[capability];
  if (expectedObject === undefined || data.object !== expectedObject || typeof data.id !== "string" || !data.id) {
    throw new Error(`Notion ${capability} returned an invalid write result.`);
  }
  return data;
}
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
  const type = typeof item.type === "string" ? item.type : undefined;
  return {
    id: item.id,
    object: item.object,
    url: item.url,
    archived: item.archived ?? item.in_trash ?? false,
    parent: item.parent,
    properties: item.properties ?? {},
    createdTime: item.created_time,
    lastEditedTime: item.last_edited_time,
    // Block type-specific content (rich text, children, captions) is preserved
    // verbatim as opaque, untrusted data — never parsed or interpreted here.
    ...(type ? { type, hasChildren: item.has_children, content: item[type] } : {})
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
