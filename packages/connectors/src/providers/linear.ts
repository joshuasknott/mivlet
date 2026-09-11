import type { ConnectorCapability, ConnectorError } from "@fable/protocol";
import type {
  ConnectorAdapter,
  ConnectorRequest,
  ConnectorWriteRequest,
} from "../sdk";
import {
  ProviderHttpClient,
  asObjects,
  isObject,
  oauthClient,
  page,
  providerError,
  stringValue,
  type FetchLike,
  type JsonObject,
  type OAuthClientOptions,
} from "./http";

export const LINEAR_CAPABILITIES = [
  "identity.read",
  "teams.read",
  "projects.read",
  "cycles.read",
  "issues.read",
  "issues.search",
  "comments.read",
  "labels.read",
  "users.read",
  "issues.create",
  "issues.update",
  "comments.create",
].map((id): ConnectorCapability => {
  const write = id.endsWith(".create") || id.endsWith(".update");
  return {
    id,
    kind: write ? "write" : "read",
    consequential: write,
    description: `Linear ${id.replaceAll(".", " ")}`,
  };
});

export interface LinearAdapterOptions extends Omit<
  OAuthClientOptions,
  | "connectorId"
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "identityEndpoint"
  | "revocationEndpoint"
  | "scopes"
> {
  authBaseUrl: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

/**
 * GraphQL read shapes the adapter understands.
 *
 * - `entity`: the root is a single object (`viewer`, `issue(id)`); a null root
 *   means the resource is absent for this account, never an empty page.
 * - `connection`: the root is a Relay connection (`teams`, `issues`, ...).
 * - `connection` with `path`: the root is a parent entity and the connection is
 *   nested underneath it (`issue.comments` for `comments.read`).
 */
type LinearReadShape =
  { kind: "entity" } | { kind: "connection"; path?: readonly string[] };

/**
 * Request metadata/routing keys that must never be forwarded into a Linear
 * mutation input. `issueId` is consumed as the routing `id` variable; the rest
 * are account/target/preview context the GraphQL schema does not accept.
 */
const LINEAR_ROUTING_INPUT_KEYS = [
  "issueId",
  "targetId",
  "workspace",
  "team",
  "accountId",
  "connectionId",
  "connection_id",
  "workspaceId",
  "preview",
  "runId",
  "idempotencyKey",
];

export function createLinearAdapter(
  options: LinearAdapterOptions,
): ConnectorAdapter<JsonObject, JsonObject> {
  const broker = new URL(options.authBaseUrl);
  const auth = oauthClient({
    ...options,
    connectorId: "linear",
    authorizationEndpoint: new URL("oauth/linear/authorize", broker).toString(),
    handoffEndpoint: new URL("oauth/linear/handoff", broker).toString(),
    refreshEndpoint: new URL("oauth/linear/refresh", broker).toString(),
    revocationEndpoint: new URL("oauth/linear/revoke", broker).toString(),
    scopes: ["read", "write", "issues:create", "comments:create"],
  });
  const http = new ProviderHttpClient(
    "linear",
    options.apiUrl ?? "https://api.linear.app/",
    options.fetch,
  );
  return {
    id: "linear",
    capabilities: LINEAR_CAPABILITIES,
    ...auth,
    async read(request, tokens) {
      const { query, variables, root, shape } = linearReadQuery(request);
      const { data, response } = await http.request<JsonObject>(
        {
          method: "POST",
          path: "/graphql",
          body: { query, variables },
          signal: request.signal,
        },
        tokens,
      );
      const payload = unwrapGraphql(data);
      const selection = linearReadResult(payload[root], shape, request.cursor);
      return page(selection.items, response, selection.nextCursor);
    },
    async write(request, tokens) {
      const { query, variables, root } = linearWriteQuery(request);
      const { data } = await http.request<JsonObject>(
        {
          method: "POST",
          path: "/graphql",
          body: { query, variables },
          signal: request.signal,
        },
        tokens,
      );
      const payload = unwrapGraphql(data);
      const result = payload[root];
      if (!isObject(result) || result.success !== true)
        throw linearMutationFailed();
      return result;
    },
  };
}

function linearReadQuery(request: ConnectorRequest): {
  query: string;
  variables: JsonObject;
  root: string;
  shape: LinearReadShape;
} {
  const first = Math.max(
    1,
    Math.min(
      50,
      typeof request.input.limit === "number"
        ? Math.floor(request.input.limit)
        : 30,
    ),
  );
  const variables: JsonObject = { first, after: request.cursor ?? null };
  const pageInfo = "pageInfo { hasNextPage endCursor }";
  switch (request.capability) {
    case "identity.read":
      return {
        root: "viewer",
        shape: { kind: "entity" },
        variables: {},
        query: `query { viewer { id name email avatarUrl organization { id name urlKey } } }`,
      };
    case "teams.read":
      return {
        root: "teams",
        shape: { kind: "connection" },
        variables,
        query: `query($first:Int!,$after:String){ teams(first:$first,after:$after){ nodes { id key name description } ${pageInfo} } }`,
      };
    case "projects.read":
      return {
        root: "projects",
        shape: { kind: "connection" },
        variables,
        query: `query($first:Int!,$after:String){ projects(first:$first,after:$after){ nodes { id name description state progress url updatedAt teams { nodes { id key name } } } ${pageInfo} } }`,
      };
    case "cycles.read":
      return {
        root: "cycles",
        shape: { kind: "connection" },
        variables: { ...variables, teamId: required(request.input, "teamId") },
        query: `query($first:Int!,$after:String,$teamId:ID!){ cycles(first:$first,after:$after,filter:{team:{id:{eq:$teamId}}}){ nodes { id number name startsAt endsAt progress } ${pageInfo} } }`,
      };
    case "issues.read": {
      const id = optional(request.input, "issueId");
      return id
        ? {
            root: "issue",
            shape: { kind: "entity" },
            variables: { id },
            query: `query($id:String!){ issue(id:$id){ id identifier title description priority url state { id name type } assignee { id name } team { id key name } project { id name } cycle { id name } labels { nodes { id name color } } updatedAt } }`,
          }
        : {
            root: "issues",
            shape: { kind: "connection" },
            variables,
            query: `query($first:Int!,$after:String){ issues(first:$first,after:$after,orderBy:updatedAt){ nodes { id identifier title description priority url state { id name type } assignee { id name } team { id key name } updatedAt } ${pageInfo} } }`,
          };
    }
    case "issues.search":
      return {
        root: "searchIssues",
        shape: { kind: "connection" },
        variables: { ...variables, query: required(request.input, "query") },
        query: `query($query:String!,$first:Int!,$after:String){ searchIssues(term:$query,first:$first,after:$after){ nodes { id identifier title description url state { id name type } team { id key name } updatedAt } ${pageInfo} } }`,
      };
    case "comments.read":
      return {
        root: "issue",
        shape: { kind: "connection", path: ["comments"] },
        variables: {
          id: required(request.input, "issueId"),
          first,
          after: request.cursor ?? null,
        },
        query: `query($id:String!,$first:Int!,$after:String){ issue(id:$id){ comments(first:$first,after:$after){ nodes { id body createdAt updatedAt user { id name } } ${pageInfo} } } }`,
      };
    case "labels.read":
      return {
        root: "issueLabels",
        shape: { kind: "connection" },
        variables,
        query: `query($first:Int!,$after:String){ issueLabels(first:$first,after:$after){ nodes { id name description color } ${pageInfo} } }`,
      };
    case "users.read":
      return {
        root: "users",
        shape: { kind: "connection" },
        variables,
        query: `query($first:Int!,$after:String){ users(first:$first,after:$after){ nodes { id name displayName email active } ${pageInfo} } }`,
      };
    default:
      throw new Error(
        `Unsupported Linear read capability: ${request.capability}`,
      );
  }
}

/**
 * Walks a Relay connection out of a GraphQL result, honoring a nested path.
 */
function resolveConnection(
  value: unknown,
  path: readonly string[],
): JsonObject | undefined {
  let cursor = value;
  for (const key of path) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return isObject(cursor) ? cursor : undefined;
}

/**
 * Validates a read result before it is surfaced. A 200 with `errors`, an absent
 * root, a malformed connection, or a bad pagination cursor fails closed instead
 * of becoming a false empty page or a silent truncation.
 */
function linearReadResult(
  result: unknown,
  shape: LinearReadShape,
  cursor: string | undefined,
): { items: JsonObject[]; nextCursor?: string } {
  if (shape.kind === "entity") {
    if (!isObject(result))
      throw linearError(
        404,
        "ENTITY_NOT_FOUND",
        "The requested Linear resource was not found.",
      );
    return { items: [result] };
  }
  const connection = shape.path
    ? isObject(result)
      ? resolveConnection(result, shape.path)
      : undefined
    : isObject(result)
      ? result
      : undefined;
  if (!isObject(connection)) {
    // A null parent entity (comments.read) is a missing resource; a null or
    // absent connection root is a malformed payload.
    if (shape.path)
      throw linearError(
        404,
        "ENTITY_NOT_FOUND",
        "The requested Linear resource was not found.",
      );
    throw linearMalformed();
  }
  if (!Array.isArray(connection.nodes)) throw linearMalformed();
  const pageInfo = connection.pageInfo;
  if (!isObject(pageInfo) || typeof pageInfo.hasNextPage !== "boolean")
    throw linearMalformed();
  if (pageInfo.hasNextPage) {
    const endCursor = stringValue(pageInfo, "endCursor");
    if (!endCursor)
      throw linearError(
        502,
        "MALFORMED_CURSOR",
        "Linear returned a malformed pagination cursor.",
        false,
      );
    if (cursor !== undefined && endCursor === cursor) {
      throw linearError(
        502,
        "REPEATED_CURSOR",
        "Linear returned a repeated pagination cursor.",
        false,
      );
    }
    return { items: asObjects(connection.nodes), nextCursor: endCursor };
  }
  return { items: asObjects(connection.nodes) };
}

function linearWriteQuery(request: ConnectorWriteRequest): {
  query: string;
  variables: JsonObject;
  root: string;
} {
  switch (request.capability) {
    case "issues.create":
      return {
        root: "issueCreate",
        variables: { input: linearWriteInput(request.input) },
        query: `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id identifier title url } } }`,
      };
    case "issues.update":
      return {
        root: "issueUpdate",
        variables: {
          id: required(request.input, "issueId"),
          input: linearWriteInput(request.input),
        },
        query: `mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success issue { id identifier title url state { id name } } } }`,
      };
    case "comments.create":
      return {
        root: "commentCreate",
        variables: {
          input: {
            issueId: required(request.input, "issueId"),
            body: required(request.input, "body"),
          },
        },
        query: `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment { id body createdAt } } }`,
      };
    default:
      throw new Error(
        `Unsupported Linear write capability: ${request.capability}`,
      );
  }
}

/** Drops routing/metadata keys so they are never forwarded into a mutation input. */
function linearWriteInput(input: Record<string, unknown>): JsonObject {
  const cleaned: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LINEAR_ROUTING_INPUT_KEYS.includes(key)) cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Fails closed on any GraphQL `errors` entry. A 200 may carry partial data
 * alongside errors; partial data is never surfaced as a completed result.
 */
function unwrapGraphql(response: JsonObject): JsonObject {
  if (Array.isArray(response.errors) && response.errors.length) {
    throw linearGraphqlError(response.errors[0]);
  }
  if (!isObject(response.data)) throw linearMalformed();
  return response.data;
}

function linearGraphqlError(first: unknown): ConnectorError {
  const code = isObject(first) ? graphqlErrorCode(first) : undefined;
  const status =
    code === "RATELIMITED" || code === "ratelimited"
      ? 429
      : code === "AUTHENTICATION_ERROR" ||
          code === "AUTHENTICATION_REQUIRED" ||
          code === "authentication_error"
        ? 401
        : code === "FORBIDDEN" || code === "forbidden"
          ? 403
          : code === "ENTITY_NOT_FOUND" ||
              code === "NOT_FOUND" ||
              code === "not_found"
            ? 404
            : 400;
  return providerError("linear", status, code);
}

function graphqlErrorCode(error: JsonObject): string | undefined {
  if (isObject(error.extensions)) {
    const code =
      stringValue(error.extensions, "code") ??
      stringValue(error.extensions, "type");
    if (code) return code;
  }
  return stringValue(error, "code") ?? stringValue(error, "type");
}

function linearError(
  status: number,
  code: string,
  message: string,
  retryable?: boolean,
): ConnectorError {
  const base = providerError("linear", status, code);
  return {
    ...base,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function linearMalformed(): ConnectorError {
  return linearError(
    502,
    "MALFORMED_RESPONSE",
    "Linear returned a malformed GraphQL response.",
  );
}

/** A rejected mutation (`success: false`) is deterministic; never auto-retried. */
function linearMutationFailed(): ConnectorError {
  return linearError(
    400,
    "MUTATION_FAILED",
    "Linear mutation did not succeed.",
    false,
  );
}

function required(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Linear capability requires ${key}.`);
  return value;
}
function optional(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}
