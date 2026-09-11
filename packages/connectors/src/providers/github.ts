import type { ConnectorCapability, ConnectorPage, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest } from "../sdk";
import {
  ProviderHttpClient,
  asObjects,
  isObject,
  oauthClient,
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

export interface GitHubPayload {
  id: string | number;
  kind: "repository" | "branch" | "issue" | "pull-request" | "file";
  name: string;
  repository: string;
  description?: string;
  content?: string;
  url?: string;
  updatedAt?: string;
  state?: string;
}

export function normalizeGitHubItem(payload: GitHubPayload): ConnectorSearchItem {
  return {
    id: String(payload.id),
    connectorId: "github",
    title: payload.name,
    kind: payload.kind,
    summary: payload.description ?? `${payload.kind} in ${payload.repository}`,
    provenance: `GitHub · ${payload.repository}`,
    freshness: payload.updatedAt ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.content ? { contentPreview: payload.content } : {}),
    providerMetadata: {
      repository: payload.repository,
      ...(payload.state ? { state: payload.state } : {})
    }
  };
}

export function shapeGitHubSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("github", query, limit);
}

export function prepareGitHubDraftPullRequest(payload: {
  repository: string;
  head: string;
  base: string;
  title: string;
}) {
  return prepareConnectorAction(
    "github",
    "GitHub",
    "github.draft-pull-request",
    { ...payload, targetId: payload.repository },
    "medium",
    "Creates a draft pull request after Mivlet approval."
  );
}

export function prepareGitHubComment(payload: {
  repository: string;
  targetId: string;
  body: string;
}) {
  return prepareConnectorAction(
    "github",
    "GitHub",
    "github.comment",
    payload,
    "medium",
    "Publishes a comment to the selected GitHub item after Mivlet approval."
  );
}

export function mapGitHubError(error: ProviderErrorLike) {
  return classifyConnectorError("github", error);
}

export const GITHUB_CAPABILITIES = [
  "identity.read", "organizations.read", "repositories.list", "repositories.search",
  "branches.read", "commits.read", "files.read", "issues.read", "pull-requests.read",
  "comments.read", "reviews.read", "checks.read", "actions.read"
].map((id): ConnectorCapability => ({
  id,
  kind: "read",
  consequential: false,
  description: `GitHub ${id.replaceAll(".", " ")}`
}));

export interface GitHubAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

/** Real GitHub REST adapter. The GitHub OAuth App exchange stays at the configured auth broker. */
export function createGitHubAdapter(options: GitHubAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const authBase = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options,
    connectorId: "github",
    authorizationEndpoint: new URL("oauth/github/authorize", authBase).toString(),
    handoffEndpoint: new URL("oauth/github/handoff", authBase).toString(),
    refreshEndpoint: new URL("oauth/github/refresh", authBase).toString(),
    revocationEndpoint: new URL("oauth/github/revoke", authBase).toString(),
    scopes: ["read:user", "read:org", "repo"]
  });
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com/";
  const http = new ProviderHttpClient("github", apiBaseUrl, options.fetch);
  return {
    id: "github", capabilities: GITHUB_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      const currentPage = githubCursorPage(request.cursor);
      const mapped = githubReadRequest(request, currentPage);
      const { data, response } = await http.request<unknown>(mapped, tokens);
      const rawItems = Array.isArray(data)
        ? asObjects(data)
        : isObject(data) && Array.isArray(data.items) ? asObjects(data.items)
        : [data].filter(isObject);
      return page(rawItems.map(redactGitHubObject), response, githubNextCursor(response, currentPage, apiBaseUrl));
    },
    async write(request, tokens) {
      void request;
      void tokens;
      throw new Error("GitHub live writes are not enabled by this adapter.");
    }
  };
}

function githubReadRequest(request: ConnectorRequest, currentPage: number): ProviderRequest {
  const input = request.input;
  const number = input.number === undefined ? undefined : String(input.number);
  const limit = bounded(input.limit);
  const common = { signal: request.signal, query: { per_page: limit, page: request.cursor === undefined ? undefined : currentPage } };
  switch (request.capability) {
    case "identity.read": return { path: "/user", signal: request.signal };
    case "organizations.read": return { path: "/user/orgs", ...common };
    case "repositories.list": return { path: "/user/repos", ...common, query: { ...common.query, affiliation: "owner,collaborator,organization_member", sort: "updated" } };
    case "repositories.search": return { path: "/search/repositories", ...common, query: { ...common.query, q: required(input, "query") } };
    case "branches.read": return { path: `/repos/${githubRepository(input)}/branches`, ...common };
    case "commits.read": return { path: `/repos/${githubRepository(input)}/commits`, ...common, query: { ...common.query, sha: optional(input, "ref") } };
    case "files.read": return { path: `/repos/${githubRepository(input)}/contents/${encodePath(required(input, "path"))}`, signal: request.signal, query: { ref: optional(input, "ref") } };
    case "issues.read": return { path: number ? `/repos/${githubRepository(input)}/issues/${number}` : `/repos/${githubRepository(input)}/issues`, ...common, query: { ...common.query, state: optional(input, "state") ?? "all" } };
    case "pull-requests.read": return { path: number ? `/repos/${githubRepository(input)}/pulls/${number}` : `/repos/${githubRepository(input)}/pulls`, ...common, query: { ...common.query, state: optional(input, "state") ?? "all" } };
    case "comments.read": return { path: `/repos/${githubRepository(input)}/issues/${required(input, "number")}/comments`, ...common };
    case "reviews.read": return { path: `/repos/${githubRepository(input)}/pulls/${required(input, "number")}/reviews`, ...common };
    case "checks.read": return { path: `/repos/${githubRepository(input)}/commits/${required(input, "ref")}/check-runs`, ...common, headers: { accept: "application/vnd.github+json" } };
    case "actions.read": return { path: `/repos/${githubRepository(input)}/actions/${optional(input, "resource") ?? "runs"}`, ...common };
    default: throw new Error(`Unsupported GitHub read capability: ${request.capability}`);
  }
}

function redactGitHubObject(value: JsonObject): JsonObject {
  const copy = { ...value };
  for (const key of ["token", "authorization", "email"]) delete copy[key];
  return copy;
}
function githubCursorPage(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("GitHub cursor must be a positive page number.");
  }
  return page;
}
function githubNextCursor(response: Response, currentPage: number, apiBaseUrl: string): string | undefined {
  const apiOrigin = new URL(apiBaseUrl).origin;
  let nextPage: number | undefined;
  for (const link of (response.headers.get("link") ?? "").split(",")) {
    const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (!match || match[2] !== "next") continue;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      continue;
    }
    if (url.origin !== apiOrigin) continue;
    const raw = url.searchParams.get("page");
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) continue;
    nextPage = parsed;
    break;
  }
  return nextPage !== undefined && nextPage > currentPage ? String(nextPage) : undefined;
}
function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") throw new Error(`GitHub capability requires ${key}.`);
  return String(value);
}
function optional(input: Record<string, unknown>, key: string) { const v = input[key]; return typeof v === "string" && v ? v : undefined; }
function bounded(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 30; }
function encodePath(path: string) { return path.split("/").map(encodeURIComponent).join("/"); }
function githubRepository(input: Record<string, unknown>) {
  const repository = required(input, "repository");
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) throw new Error("GitHub repository must be in owner/name form.");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
