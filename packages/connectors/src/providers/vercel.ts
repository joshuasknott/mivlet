import type { ConnectorCapability, ConnectorSearchItem } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, asObjects, isObject, oauthClient, page, type FetchLike, type JsonObject, type OAuthClientOptions, type ProviderRequest } from "./http";
import {
  classifyConnectorError,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./shared";

export interface VercelPayload {
  id: string;
  kind: "project" | "deployment";
  name: string;
  team: string;
  state?: string;
  environment?: "preview" | "production";
  url?: string;
  updatedAt?: string;
}

export function normalizeVercelItem(payload: VercelPayload): ConnectorSearchItem {
  return {
    id: payload.id,
    connectorId: "vercel",
    title: payload.name,
    kind: payload.kind,
    summary: payload.state
      ? `${payload.environment ?? "deployment"} · ${payload.state}`
      : `Project in ${payload.team}`,
    provenance: `Vercel · ${payload.team}`,
    freshness: payload.updatedAt ?? "Provider freshness unavailable",
    trust: "untrusted",
    ...(payload.url ? { url: payload.url } : {}),
    providerMetadata: {
      team: payload.team,
      ...(payload.state ? { state: payload.state } : {}),
      ...(payload.environment ? { environment: payload.environment } : {})
    }
  };
}

export function shapeVercelSearch(query: string, limit?: number) {
  return shapeConnectorSearchRequest("vercel", query, limit);
}

export function prepareVercelPromotion(deploymentId: string) {
  return prepareConnectorAction(
    "vercel",
    "Vercel",
    "vercel.promote",
    { targetId: deploymentId },
    "high",
    "Promotes the selected deployment to production."
  );
}

export function prepareVercelRollback(deploymentId: string) {
  return prepareConnectorAction(
    "vercel",
    "Vercel",
    "vercel.rollback",
    { targetId: deploymentId },
    "high",
    "Rolls production back to the selected deployment."
  );
}

export function mapVercelError(error: ProviderErrorLike) {
  return classifyConnectorError("vercel", error);
}

export const VERCEL_CAPABILITIES = [
  "identity.read", "teams.read", "projects.read", "deployments.read", "domains.read",
  "logs.read", "environment-metadata.read", "deployments.create", "deployments.cancel",
  "deployments.promote", "deployments.rollback", "projects.update", "domains.create", "domains.update", "domains.delete"
].map((id): ConnectorCapability => {
  const write = /\.(create|cancel|promote|rollback|update|delete)$/.test(id);
  return { id, kind: write ? "write" : "read", consequential: write, description: `Vercel ${id.replaceAll(".", " ")}` };
});

export interface VercelAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}

/**
 * Vercel OAuth scopes Mivlet requests. `deployment:write` is kept because native
 * Vercel actions promote, roll back, create, and cancel deployments, and change
 * projects and domains, after exact approval. It is labeled write, not read.
 */
export const VERCEL_OAUTH_SCOPES = [
  "user:read",
  "team:read",
  "project:read",
  "deployment:read",
  "deployment:write"
] as const;

export function createVercelAdapter(options: VercelAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const broker = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options, connectorId: "vercel",
    authorizationEndpoint: new URL("oauth/vercel/authorize", broker).toString(),
    handoffEndpoint: new URL("oauth/vercel/handoff", broker).toString(),
    refreshEndpoint: new URL("oauth/vercel/refresh", broker).toString(),
    revocationEndpoint: new URL("oauth/vercel/revoke", broker).toString(),
    scopes: [...VERCEL_OAUTH_SCOPES]
  });
  const http = new ProviderHttpClient("vercel", options.apiBaseUrl ?? "https://api.vercel.com/", options.fetch);
  return {
    id: "vercel", capabilities: VERCEL_CAPABILITIES, ...auth,
    async read(request, tokens) {
      const { data, response } = await http.request<unknown>(vercelReadRequest(request), tokens);
      const container = isObject(data) ? data : {};
      const raw = Array.isArray(data) ? asObjects(data)
        : ["teams", "projects", "deployments", "domains", "events", "envs"]
            .map((key) => container[key]).find(Array.isArray);
      const items = raw ? asObjects(raw).map(redactVercelObject) : [redactVercelObject(container)];
      const pagination = isObject(container.pagination) ? container.pagination : undefined;
      const next = pagination && typeof pagination.next === "number" ? String(pagination.next) : undefined;
      return page(items, response, next);
    },
    async write(request, tokens) {
      const { data } = await http.request<unknown>(vercelWriteRequest(request), tokens);
      if (!isObject(data)) throw new Error("Vercel returned a malformed write response.");
      return redactVercelObject(data);
    }
  };
}

function vercelReadRequest(request: ConnectorRequest): ProviderRequest {
  const i = request.input;
  const teamId = optional(i, "teamId");
  const query = { teamId, limit: bounded(i.limit), until: request.cursor ? Number(request.cursor) : undefined };
  switch (request.capability) {
    case "identity.read": return { path: "/v2/user", signal: request.signal };
    case "teams.read": return { path: "/v2/teams", query, signal: request.signal };
    case "projects.read": return { path: optional(i, "project") ? `/v9/projects/${required(i, "project")}` : "/v9/projects", query, signal: request.signal };
    case "deployments.read": return { path: optional(i, "deploymentId") ? `/v13/deployments/${required(i, "deploymentId")}` : "/v6/deployments", query: { ...query, projectId: optional(i, "projectId"), state: optional(i, "state") }, signal: request.signal };
    case "domains.read": return { path: optional(i, "project") ? `/v9/projects/${required(i, "project")}/domains` : "/v5/domains", query, signal: request.signal };
    case "logs.read": return { path: `/v3/deployments/${required(i, "deploymentId")}/events`, query: { teamId, limit: bounded(i.limit), follow: 0 }, signal: request.signal };
    case "environment-metadata.read": return { path: `/v9/projects/${required(i, "project")}/env`, query, signal: request.signal };
    default: throw new Error(`Unsupported Vercel read capability: ${request.capability}`);
  }
}

function vercelWriteRequest(request: ConnectorWriteRequest): ProviderRequest {
  const i = request.input; const teamId = optional(i, "teamId"); const query = { teamId };
  switch (request.capability) {
    case "deployments.create": return { method: "POST", path: "/v13/deployments", query, body: without(i, ["teamId"]), signal: request.signal };
    case "deployments.cancel": return { method: "PATCH", path: `/v12/deployments/${required(i, "deploymentId")}/cancel`, query, signal: request.signal };
    case "deployments.promote": return { method: "POST", path: `/v10/projects/${required(i, "project")}/promote/${required(i, "deploymentId")}`, query, signal: request.signal };
    case "deployments.rollback": return { method: "POST", path: `/v10/projects/${required(i, "project")}/rollback/${required(i, "deploymentId")}`, query, signal: request.signal };
    case "projects.update": return { method: "PATCH", path: `/v9/projects/${required(i, "project")}`, query, body: without(i, ["teamId", "project"]), signal: request.signal };
    case "domains.create": return { method: "POST", path: `/v10/projects/${required(i, "project")}/domains`, query, body: { name: required(i, "domain") }, signal: request.signal };
    case "domains.update": return { method: "PATCH", path: `/v9/projects/${required(i, "project")}/domains/${required(i, "domain")}`, query, body: without(i, ["teamId", "project", "domain"]), signal: request.signal };
    case "domains.delete": return { method: "DELETE", path: `/v9/projects/${required(i, "project")}/domains/${required(i, "domain")}`, query, signal: request.signal };
    default: throw new Error(`Unsupported Vercel write capability: ${request.capability}`);
  }
}

/** Environment variable values are deliberately removed at the adapter boundary. */
function redactVercelObject(value: JsonObject): JsonObject {
  const copy = { ...value };
  for (const key of ["value", "decryptedValue", "token", "secret", "password"]) delete copy[key];
  if (isObject(copy.env)) copy.env = Object.fromEntries(Object.keys(copy.env).map((key) => [key, "[redacted]"]));
  return copy;
}
function required(i: Record<string, unknown>, key: string) { const v=i[key]; if ((typeof v!=="string"&&typeof v!=="number")||!String(v)) throw new Error(`Vercel capability requires ${key}.`); return String(v); }
function optional(i: Record<string, unknown>, key: string) { const v=i[key]; return typeof v==="string"&&v ? v : undefined; }
function bounded(v: unknown) { return typeof v==="number" ? Math.max(1,Math.min(100,Math.floor(v))) : 30; }
function without(value: Record<string, unknown>, keys: string[]) { const copy={...value}; for(const key of keys) delete copy[key]; return copy; }
