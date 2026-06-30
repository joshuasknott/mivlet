import type { ConnectorCapability } from "@fable/protocol";
import type { ConnectorAdapter, ConnectorRequest, ConnectorWriteRequest } from "../sdk";
import { ProviderHttpClient, asObjects, isObject, oauthClient, page, providerError, stringValue, type FetchLike, type JsonObject, type OAuthClientOptions } from "./http";

export const LINEAR_CAPABILITIES = [
  "identity.read", "teams.read", "projects.read", "cycles.read", "issues.read", "issues.search",
  "comments.read", "labels.read", "users.read", "issues.create", "issues.update", "comments.create"
].map((id): ConnectorCapability => {
  const write = id.endsWith(".create") || id.endsWith(".update");
  return { id, kind: write ? "write" : "read", consequential: write, description: `Linear ${id.replaceAll(".", " ")}` };
});

export interface LinearAdapterOptions extends Omit<OAuthClientOptions, "connectorId" | "authorizationEndpoint" | "tokenEndpoint" | "identityEndpoint" | "revocationEndpoint" | "scopes"> {
  authBaseUrl: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

export function createLinearAdapter(options: LinearAdapterOptions): ConnectorAdapter<JsonObject, JsonObject> {
  const broker = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options, connectorId: "linear",
    authorizationEndpoint: new URL("oauth/linear/authorize", broker).toString(),
    handoffEndpoint: new URL("oauth/linear/handoff", broker).toString(),
    refreshEndpoint: new URL("oauth/linear/refresh", broker).toString(),
    revocationEndpoint: new URL("oauth/linear/revoke", broker).toString(),
    scopes: ["read", "write", "issues:create", "comments:create"]
  });
  const http = new ProviderHttpClient("linear", options.apiUrl ?? "https://api.linear.app/", options.fetch);
  return {
    id: "linear", capabilities: LINEAR_CAPABILITIES, ...auth,
    async read(request, tokens) {
      const { query, variables, root, connectionPath } = linearReadQuery(request);
      const { data, response } = await http.request<JsonObject>({ method: "POST", path: "/graphql", body: { query, variables }, signal: request.signal }, tokens);
      const payload = unwrapGraphql(data);
      const result = payload[root];
      // Most reads select a top-level Relay connection (`payload[root]`), but
      // comments.read nests it under the issue (`payload[issue].comments`).
      const connection = resolveConnection(result, connectionPath);
      const items = connection && Array.isArray(connection.nodes) ? asObjects(connection.nodes) : result && isObject(result) ? [result] : [];
      const pageInfo = connection && isObject(connection.pageInfo) ? connection.pageInfo : undefined;
      return page(items, response, pageInfo && pageInfo.hasNextPage === true ? stringValue(pageInfo, "endCursor") : undefined);
    },
    async write(request, tokens) {
      const { query, variables, root } = linearWriteQuery(request);
      const { data } = await http.request<JsonObject>({ method: "POST", path: "/graphql", body: { query, variables }, signal: request.signal }, tokens);
      const payload = unwrapGraphql(data);
      const result = payload[root];
      if (!isObject(result) || result.success !== true) throw new Error("Linear mutation did not succeed.");
      return result;
    }
  };
}

function linearReadQuery(request: ConnectorRequest): { query: string; variables: JsonObject; root: string; connectionPath?: readonly string[] } {
  const first = Math.max(1, Math.min(50, typeof request.input.limit === "number" ? Math.floor(request.input.limit) : 30));
  const variables: JsonObject = { first, after: request.cursor ?? null };
  const pageInfo = "pageInfo { hasNextPage endCursor }";
  switch (request.capability) {
    case "identity.read": return { root: "viewer", variables: {}, query: `query { viewer { id name email avatarUrl organization { id name urlKey } } }` };
    case "teams.read": return { root: "teams", variables, query: `query($first:Int!,$after:String){ teams(first:$first,after:$after){ nodes { id key name description } ${pageInfo} } }` };
    case "projects.read": return { root: "projects", variables, query: `query($first:Int!,$after:String){ projects(first:$first,after:$after){ nodes { id name description state progress url updatedAt teams { nodes { id key name } } } ${pageInfo} } }` };
    case "cycles.read": return { root: "cycles", variables: { ...variables, teamId: required(request.input, "teamId") }, query: `query($first:Int!,$after:String,$teamId:ID!){ cycles(first:$first,after:$after,filter:{team:{id:{eq:$teamId}}}){ nodes { id number name startsAt endsAt progress } ${pageInfo} } }` };
    case "issues.read": {
      const id = optional(request.input, "issueId");
      return id
        ? { root: "issue", variables: { id }, query: `query($id:String!){ issue(id:$id){ id identifier title description priority url state { id name type } assignee { id name } team { id key name } project { id name } cycle { id name } labels { nodes { id name color } } updatedAt } }` }
        : { root: "issues", variables, query: `query($first:Int!,$after:String){ issues(first:$first,after:$after,orderBy:updatedAt){ nodes { id identifier title description priority url state { id name type } assignee { id name } team { id key name } updatedAt } ${pageInfo} } }` };
    }
    case "issues.search": return { root: "searchIssues", variables: { ...variables, query: required(request.input, "query") }, query: `query($query:String!,$first:Int!,$after:String){ searchIssues(term:$query,first:$first,after:$after){ nodes { id identifier title description url state { id name type } team { id key name } updatedAt } ${pageInfo} } }` };
    case "comments.read": return { root: "issue", connectionPath: ["comments"], variables: { id: required(request.input, "issueId"), first, after: request.cursor ?? null }, query: `query($id:String!,$first:Int!,$after:String){ issue(id:$id){ comments(first:$first,after:$after){ nodes { id body createdAt updatedAt user { id name } } ${pageInfo} } } }` };
    case "labels.read": return { root: "issueLabels", variables, query: `query($first:Int!,$after:String){ issueLabels(first:$first,after:$after){ nodes { id name description color } ${pageInfo} } }` };
    case "users.read": return { root: "users", variables, query: `query($first:Int!,$after:String){ users(first:$first,after:$after){ nodes { id name displayName email active } ${pageInfo} } }` };
    default: throw new Error(`Unsupported Linear read capability: ${request.capability}`);
  }
}

/** Walks a Relay connection out of a GraphQL result, honoring a nested path. */
function resolveConnection(value: unknown, path?: readonly string[]): JsonObject | undefined {
  let cursor = value;
  for (const key of path ?? []) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return isObject(cursor) ? cursor : undefined;
}

function linearWriteQuery(request: ConnectorWriteRequest): { query: string; variables: JsonObject; root: string } {
  const input = { ...request.input }; delete input.issueId;
  switch (request.capability) {
    case "issues.create": return { root: "issueCreate", variables: { input }, query: `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id identifier title url } } }` };
    case "issues.update": return { root: "issueUpdate", variables: { id: required(request.input, "issueId"), input }, query: `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success issue { id identifier title url state { id name } } } }` };
    case "comments.create": return { root: "commentCreate", variables: { input: { issueId: required(request.input, "issueId"), body: required(request.input, "body") } }, query: `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment { id body createdAt } } }` };
    default: throw new Error(`Unsupported Linear write capability: ${request.capability}`);
  }
}

function unwrapGraphql(response: JsonObject): JsonObject {
  if (Array.isArray(response.errors) && response.errors.length) {
    const first = response.errors[0];
    const code = isObject(first) && isObject(first.extensions) ? stringValue(first.extensions, "code") : undefined;
    throw providerError("linear", code === "RATELIMITED" ? 429 : code === "AUTHENTICATION_ERROR" ? 401 : code === "FORBIDDEN" ? 403 : 400, code);
  }
  if (!isObject(response.data)) throw new Error("Linear returned a malformed GraphQL response.");
  return response.data;
}
function required(input: Record<string, unknown>, key: string) { const value=input[key]; if(typeof value!=="string"||!value) throw new Error(`Linear capability requires ${key}.`); return value; }
function optional(input: Record<string, unknown>, key: string) { const value=input[key]; return typeof value==="string"&&value ? value : undefined; }
