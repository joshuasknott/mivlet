import type { ConnectorCapability, ConnectorPage, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
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
    "Creates a draft pull request after Fable approval."
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
    "Publishes a comment to the selected GitHub item after Fable approval."
  );
}

export function mapGitHubError(error: ProviderErrorLike) {
  return classifyConnectorError("github", error);
}

export const GITHUB_CAPABILITIES = [
  "identity.read", "organizations.read", "repositories.list", "repositories.search",
  "branches.read", "commits.read", "files.read", "issues.read", "pull-requests.read",
  "comments.read", "reviews.read", "checks.read", "actions.read",
  "issues.create", "issues.update", "comments.create", "reviews.create",
  "pull-requests.create", "files.update", "branches.create", "actions.dispatch"
].map((id): ConnectorCapability => ({
  id,
  kind: id.endsWith(".create") || id.endsWith(".update") || id.endsWith(".dispatch") ? "write" : "read",
  consequential: id.endsWith(".create") || id.endsWith(".update") || id.endsWith(".dispatch"),
  description: `GitHub ${id.replaceAll(".", " ")}`
}));

export interface GitHubAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

/** Real GitHub REST adapter. Confidential GitHub App exchange stays at the configured auth broker. */
export function createGitHubAdapter(options: GitHubAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const authBase = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options,
    connectorId: "github",
    authorizationEndpoint: new URL("oauth/github/authorize", authBase).toString(),
    tokenEndpoint: new URL("oauth/github/token", authBase).toString(),
    identityEndpoint: new URL("oauth/github/identity", authBase).toString(),
    revocationEndpoint: new URL("oauth/github/revoke", authBase).toString(),
    scopes: ["read:user", "read:org", "repo", "workflow"]
  });
  const http = new ProviderHttpClient("github", options.apiBaseUrl ?? "https://api.github.com/", options.fetch);
  return {
    id: "github", capabilities: GITHUB_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      const mapped = githubReadRequest(request);
      const { data, response } = await http.request<unknown>(mapped, tokens);
      const rawItems = Array.isArray(data)
        ? asObjects(data)
        : isObject(data) && Array.isArray(data.items) ? asObjects(data.items)
        : [data].filter(isObject);
      return page(rawItems.map(redactGitHubObject), response, githubNextCursor(response));
    },
    async write(request, tokens) {
      const { data } = await http.request<unknown>(githubWriteRequest(request), tokens);
      if (!isObject(data)) throw new Error("GitHub returned a malformed write response.");
      return redactGitHubObject(data);
    }
  };
}

function githubReadRequest(request: ConnectorRequest): ProviderRequest {
  const input = request.input;
  const number = input.number === undefined ? undefined : String(input.number);
  const limit = bounded(input.limit);
  const common = { signal: request.signal, query: { per_page: limit, page: request.cursor ? Number(request.cursor) : undefined } };
  switch (request.capability) {
    case "identity.read": return { path: "/user", signal: request.signal };
    case "organizations.read": return { path: "/user/orgs", ...common };
    case "repositories.list": return { path: "/user/repos", ...common, query: { ...common.query, affiliation: "owner,collaborator,organization_member", sort: "updated" } };
    case "repositories.search": return { path: "/search/repositories", ...common, query: { ...common.query, q: required(input, "query") } };
    case "branches.read": return { path: `/repos/${required(input,"repository")}/branches`, ...common };
    case "commits.read": return { path: `/repos/${required(input,"repository")}/commits`, ...common, query: { ...common.query, sha: optional(input, "ref") } };
    case "files.read": return { path: `/repos/${required(input,"repository")}/contents/${encodePath(required(input, "path"))}`, signal: request.signal, query: { ref: optional(input, "ref") } };
    case "issues.read": return { path: number ? `/repos/${required(input,"repository")}/issues/${number}` : `/repos/${required(input,"repository")}/issues`, ...common, query: { ...common.query, state: optional(input, "state") ?? "all" } };
    case "pull-requests.read": return { path: number ? `/repos/${required(input,"repository")}/pulls/${number}` : `/repos/${required(input,"repository")}/pulls`, ...common, query: { ...common.query, state: optional(input, "state") ?? "all" } };
    case "comments.read": return { path: `/repos/${required(input,"repository")}/issues/${required(input, "number")}/comments`, ...common };
    case "reviews.read": return { path: `/repos/${required(input,"repository")}/pulls/${required(input, "number")}/reviews`, ...common };
    case "checks.read": return { path: `/repos/${required(input,"repository")}/commits/${required(input, "ref")}/check-runs`, ...common, headers: { accept: "application/vnd.github+json" } };
    case "actions.read": return { path: `/repos/${required(input,"repository")}/actions/${optional(input, "resource") ?? "runs"}`, ...common };
    default: throw new Error(`Unsupported GitHub read capability: ${request.capability}`);
  }
}

function githubWriteRequest(request: ConnectorWriteRequest): ProviderRequest {
  const i = request.input;
  const repo = required(i, "repository");
  const body = { ...i }; delete body.repository;
  switch (request.capability) {
    case "issues.create": return { method: "POST", path: `/repos/${repo}/issues`, body, signal: request.signal };
    case "issues.update": return { method: "PATCH", path: `/repos/${repo}/issues/${required(i, "number")}`, body: without(body, "number"), signal: request.signal };
    case "comments.create": return { method: "POST", path: `/repos/${repo}/issues/${required(i, "number")}/comments`, body: { body: required(i, "body") }, signal: request.signal };
    case "reviews.create": return { method: "POST", path: `/repos/${repo}/pulls/${required(i, "number")}/reviews`, body: without(body, "number"), signal: request.signal };
    case "pull-requests.create": return { method: "POST", path: `/repos/${repo}/pulls`, body, signal: request.signal };
    case "files.update": return { method: "PUT", path: `/repos/${repo}/contents/${encodePath(required(i, "path"))}`, body: without(body, "path"), signal: request.signal };
    case "branches.create": return { method: "POST", path: `/repos/${repo}/git/refs`, body: { ref: `refs/heads/${required(i, "branch")}`, sha: required(i, "sha") }, signal: request.signal };
    case "actions.dispatch": return { method: "POST", path: `/repos/${repo}/actions/workflows/${required(i, "workflow")}/dispatches`, body: { ref: required(i, "ref"), ...(isObject(i.inputs) ? { inputs: i.inputs } : {}) }, signal: request.signal };
    default: throw new Error(`Unsupported GitHub write capability: ${request.capability}`);
  }
}

function redactGitHubObject(value: JsonObject): JsonObject {
  const copy = { ...value };
  for (const key of ["token", "authorization", "email"]) delete copy[key];
  return copy;
}
function githubNextCursor(response: Response) {
  const link = response.headers.get("link");
  const match = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="next"/);
  return match?.[1];
}
function required(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") throw new Error(`GitHub capability requires ${key}.`);
  return String(value);
}
function optional(input: Record<string, unknown>, key: string) { const v = input[key]; return typeof v === "string" && v ? v : undefined; }
function bounded(value: unknown) { return typeof value === "number" ? Math.max(1, Math.min(100, Math.floor(value))) : 30; }
function encodePath(path: string) { return path.split("/").map(encodeURIComponent).join("/"); }
function without(value: Record<string, unknown>, key: string) { const copy = { ...value }; delete copy[key]; return copy; }
