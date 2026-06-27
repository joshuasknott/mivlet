import type {
  ConnectorAccountSummary,
  ConnectorError,
  ConnectorId,
  ConnectorPage,
  ConnectorTokenSet
} from "@fable/protocol";
import type {
  ConnectorAuthCallback,
  ConnectorAuthContext,
  ConnectorAuthResult,
  ConnectorAuthStart
} from "../sdk";

export type JsonObject = Record<string, unknown>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OAuthClientOptions {
  connectorId: ConnectorId;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  identityEndpoint: string;
  revocationEndpoint?: string;
  scopes: readonly string[];
  redirectUri: string;
  fetch?: FetchLike;
}

export interface ProviderRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ProviderHttpClient {
  constructor(
    private readonly connectorId: ConnectorId,
    private readonly baseUrl: string,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async request<T>(request: ProviderRequest, tokens: ConnectorTokenSet): Promise<{
    data: T;
    response: Response;
  }> {
    const url = new URL(request.path, this.baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: request.method ?? "GET",
        signal: request.signal,
        headers: {
          accept: "application/json",
          authorization: `${tokens.tokenType || "Bearer"} ${tokens.accessToken}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw providerError(this.connectorId, 0, undefined, undefined);
    }
    if (!response.ok) {
      const body = await safeJson(response);
      const code = stringValue(body, "code") ?? nestedString(body, "error", "code");
      throw providerError(
        this.connectorId,
        response.status,
        code,
        response.headers.get("retry-after") ?? undefined
      );
    }
    const data = (response.status === 204 ? {} : await safeJson(response)) as T;
    return { data, response };
  }
}

export function page<T>(items: T[], response: Response, nextCursor?: string): ConnectorPage<T> {
  const remaining = numberHeader(response, "x-ratelimit-remaining") ??
    numberHeader(response, "x-ratelimit-requests-remaining");
  const reset = numberHeader(response, "x-ratelimit-reset") ??
    numberHeader(response, "x-ratelimit-requests-reset");
  const retrySeconds = numberHeader(response, "retry-after");
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    ...((remaining !== undefined || reset !== undefined || retrySeconds !== undefined)
      ? {
          rateLimit: {
            ...(remaining !== undefined ? { remaining } : {}),
            ...(reset !== undefined
              ? { resetAt: new Date(reset < 10_000_000_000 ? reset * 1000 : reset).toISOString() }
              : {}),
            ...(retrySeconds !== undefined ? { retryAfterMs: retrySeconds * 1000 } : {})
          }
        }
      : {})
  };
}

export function oauthClient(options: OAuthClientOptions) {
  const fetcher = options.fetch ?? fetch;
  return {
    async startAuth(context: ConnectorAuthContext): Promise<ConnectorAuthStart> {
      const url = new URL(options.authorizationEndpoint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", context.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", options.scopes.join(" "));
      url.searchParams.set("state", context.state);
      url.searchParams.set("code_challenge", context.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.toString(), state: context.state };
    },
    async completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult> {
      const callbackUrl = new URL(callback.callbackUrl);
      if (callbackUrl.searchParams.get("state") !== callback.expectedState) {
        throw providerError(options.connectorId, 400, "state_mismatch");
      }
      const code = callbackUrl.searchParams.get("code");
      if (!code) throw providerError(options.connectorId, 400, "missing_code");
      const response = await fetcher(options.tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          code_verifier: callback.codeVerifier
        })
      });
      if (!response.ok) throw providerError(options.connectorId, response.status, "token_exchange");
      const tokens = tokenSet(await safeJson(response));
      const identity = await fetcher(options.identityEndpoint, {
        headers: { accept: "application/json", authorization: `${tokens.tokenType} ${tokens.accessToken}` }
      });
      if (!identity.ok) throw providerError(options.connectorId, identity.status, "identity");
      return { tokens, account: accountSummary(await safeJson(identity)) };
    },
    async refresh(tokens: ConnectorTokenSet): Promise<ConnectorTokenSet> {
      if (!tokens.refreshToken) throw providerError(options.connectorId, 401, "expired_token");
      const response = await fetcher(options.tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: options.clientId
        })
      });
      if (!response.ok) throw providerError(options.connectorId, response.status, "refresh_failed");
      const refreshed = tokenSet(await safeJson(response));
      return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
    },
    async revoke(tokens: ConnectorTokenSet): Promise<void> {
      if (!options.revocationEndpoint) return;
      const response = await fetcher(options.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken })
      });
      if (!response.ok && response.status !== 404) {
        throw providerError(options.connectorId, response.status, "revocation_failed");
      }
    }
  };
}

export function providerError(
  connectorId: ConnectorId,
  status: number,
  providerCode?: string,
  retryAfter?: string
): ConnectorError {
  const code = status === 401
    ? (providerCode?.includes("expired") || providerCode?.includes("refresh") ? "expired-auth" : "needs-auth")
    : status === 403 ? "permission-denied"
    : status === 404 ? "not-found"
    : status === 429 || providerCode?.toLowerCase().includes("ratelimit") ? "rate-limited"
    : status === 400 || status === 422 ? "invalid-request"
    : status === 0 || status >= 500 ? "provider-unavailable"
    : "unknown";
  return {
    connectorId,
    code,
    message: code === "permission-denied" ? "The provider denied the required scope or permission."
      : code === "expired-auth" ? "The provider authorization expired; reconnect the account."
      : code === "needs-auth" ? "Connect the provider account before trying again."
      : code === "rate-limited" ? "The provider rate limit was reached."
      : code === "not-found" ? "The requested provider resource was not found."
      : code === "invalid-request" ? "The provider rejected the request."
      : code === "provider-unavailable" ? "The provider is temporarily unavailable."
      : "The connector request failed.",
    retryable: code === "rate-limited" || code === "provider-unavailable",
    ...(retryAfter ? { retryAfter: String(Number(retryAfter) * 1000) } : {})
  };
}

export function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function stringValue(value: unknown, key: string): string | undefined {
  return isObject(value) && typeof value[key] === "string" ? value[key] : undefined;
}
export function numberValue(value: unknown, key: string): number | undefined {
  return isObject(value) && typeof value[key] === "number" ? value[key] : undefined;
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw providerError("connector", 502, "malformed_response"); }
}
function tokenSet(value: unknown): ConnectorTokenSet {
  if (!isObject(value) || typeof value.access_token !== "string") {
    throw providerError("connector", 502, "malformed_token");
  }
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : undefined;
  const scope = typeof value.scope === "string" ? value.scope.split(/[ ,]+/).filter(Boolean) : [];
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    scopes: scope
  };
}
function accountSummary(value: unknown): ConnectorAccountSummary {
  if (!isObject(value)) throw providerError("connector", 502, "malformed_identity");
  const id = ["id", "sub", "user_id", "team_id", "organizationId"]
    .map((key) => value[key]).find((candidate) => typeof candidate === "string" || typeof candidate === "number");
  if (id === undefined) throw providerError("connector", 502, "malformed_identity");
  const displayName = ["name", "login", "username", "email"]
    .map((key) => value[key]).find((candidate): candidate is string => typeof candidate === "string") ?? String(id);
  return {
    id: String(id), displayName,
    ...(typeof value.login === "string" ? { handle: value.login } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    ...(typeof value.avatar_url === "string" ? { avatarUrl: value.avatar_url } : {})
  };
}
function nestedString(value: unknown, outer: string, inner: string) {
  return isObject(value) ? stringValue(value[outer], inner) : undefined;
}
function numberHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
