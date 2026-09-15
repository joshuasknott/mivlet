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
import {
  BROKER_CONTRACT_VERSION,
  BROKER_PKCE_CHALLENGE_METHOD,
  assertBrokerPkceChallenge,
  assertBrokerPkceVerifier
} from "./broker-contract";

export type JsonObject = Record<string, unknown>;
export type ProviderFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type FetchLike = ProviderFetch;

export interface OAuthClientOptions {
  connectorId: ConnectorId;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint?: string;
  identityEndpoint?: string;
  handoffEndpoint?: string;
  refreshEndpoint?: string;
  revocationEndpoint?: string;
  scopes: readonly string[];
  redirectUri: string;
  fetch?: FetchLike;
}

export interface ProviderRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type ProviderHttpRequest = ProviderRequest;

export class ProviderHttpClient {
  constructor(
    private readonly connectorId: ConnectorId,
    private readonly baseUrl: string,
    private readonly fetcher: ProviderFetch = fetch
  ) {}

  async request<T>(
    request: ProviderRequest,
    tokens: ConnectorTokenSet
  ): Promise<{ data: T; response: Response; headers: Headers }> {
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
      if (request.signal?.aborted) throw error;
      throw providerError(this.connectorId, 0, undefined, undefined);
    }
    if (!response.ok) {
      const body = await optionalJson(response);
      const code = stringValue(body, "code") ??
        stringValue(body, "error") ??
        stringValue(body, "error_description") ??
        nestedString(body, "error", "code");
      throw providerError(
        this.connectorId,
        response.status,
        code,
        response.headers.get("retry-after") ?? undefined
      );
    }
    const data = (response.status === 204 ? {} : await safeJson(response)) as T;
    return { data, response, headers: response.headers };
  }
}

export function page<T>(
  items: T[],
  responseOrNextCursor?: Response | string,
  nextCursorOrHeaders?: string | Headers
): ConnectorPage<T> {
  const response = responseOrNextCursor instanceof Response ? responseOrNextCursor : undefined;
  const headers = response?.headers ??
    (nextCursorOrHeaders instanceof Headers ? nextCursorOrHeaders : undefined);
  const nextCursor = typeof responseOrNextCursor === "string"
    ? responseOrNextCursor
    : typeof nextCursorOrHeaders === "string"
      ? nextCursorOrHeaders
      : undefined;
  const remaining = numberHeader(headers, "x-ratelimit-remaining") ??
    numberHeader(headers, "x-ratelimit-requests-remaining");
  const reset = numberHeader(headers, "x-ratelimit-reset") ??
    numberHeader(headers, "x-ratelimit-requests-reset");
  const retrySeconds = numberHeader(headers, "retry-after");
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
  const brokerEndpoint = (segment: "handoff" | "refresh" | "revoke") => {
    const explicit = segment === "handoff"
      ? options.handoffEndpoint
      : segment === "refresh"
        ? options.refreshEndpoint
        : options.revocationEndpoint;
    if (explicit) return explicit;

    const url = new URL(options.tokenEndpoint ?? options.authorizationEndpoint);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts.at(-1);
    if (last !== "token" && last !== "authorize") {
      throw providerError(options.connectorId, 500, "broker_configuration");
    }
    parts[parts.length - 1] = segment;
    url.pathname = `/${parts.join("/")}`;
    return url.toString();
  };
  return {
    async startAuth(context: ConnectorAuthContext): Promise<ConnectorAuthStart> {
      assertBrokerPkceChallenge(context.codeChallenge, BROKER_PKCE_CHALLENGE_METHOD);
      const url = new URL(options.authorizationEndpoint);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", context.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", options.scopes.join(" "));
      url.searchParams.set("state", context.state);
      url.searchParams.set("code_challenge", context.codeChallenge);
      url.searchParams.set("code_challenge_method", BROKER_PKCE_CHALLENGE_METHOD);
      return { authorizationUrl: url.toString(), state: context.state };
    },
    async completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult> {
      const callbackUrl = new URL(callback.callbackUrl);
      if (callbackUrl.searchParams.get("state") !== callback.expectedState) {
        throw providerError(options.connectorId, 400, "state_mismatch");
      }
      const handoff = callbackUrl.searchParams.get("handoff");
      if (!handoff) throw providerError(options.connectorId, 400, "missing_handoff");
      assertBrokerPkceVerifier(callback.codeVerifier);
      const response = await fetcher(brokerEndpoint("handoff"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: BROKER_CONTRACT_VERSION,
          provider: options.connectorId,
          handoff,
          state: callback.expectedState,
          codeVerifier: callback.codeVerifier
        })
      });
      if (!response.ok) throw await brokerError(options.connectorId, "handoff", response);
      const body = await safeJson(response);
      if (!isObject(body) || !isObject(body.tokens) || !isObject(body.account)) {
        throw providerError(options.connectorId, 502, "malformed_handoff");
      }
      return { tokens: connectorTokenSet(body.tokens), account: accountSummary(body.account) };
    },
    async refresh(tokens: ConnectorTokenSet): Promise<ConnectorTokenSet> {
      if (!tokens.refreshToken) throw providerError(options.connectorId, 401, "expired_token");
      const response = await fetcher(brokerEndpoint("refresh"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ contractVersion: BROKER_CONTRACT_VERSION, provider: options.connectorId, refreshToken: tokens.refreshToken })
      });
      if (!response.ok) throw await brokerError(options.connectorId, "refresh", response);
      const body = await safeJson(response);
      if (!isObject(body) || !isObject(body.tokens)) throw providerError(options.connectorId, 502, "malformed_refresh");
      const refreshed = connectorTokenSet(body.tokens);
      return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
    },
    async revoke(tokens: ConnectorTokenSet): Promise<void> {
      if (!options.revocationEndpoint) return;
      const response = await fetcher(brokerEndpoint("revoke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contractVersion: BROKER_CONTRACT_VERSION, provider: options.connectorId, token: tokens.refreshToken ?? tokens.accessToken, tokenTypeHint: tokens.refreshToken ? "refresh_token" : "access_token" })
      });
      if (!response.ok && response.status !== 404) {
        throw await brokerError(options.connectorId, "revoke", response);
      }
    }
  };
}

/**
 * Public-PKCE OAuth client for providers that live outside the auth broker.
 *
 * Google (Drive/Gmail/Calendar) is explicitly excluded from the broker's
 * confidential-client set — the desktop performs the authorization-code +
 * PKCE exchange directly against Google's OAuth2 endpoints, refreshes with a
 * refresh token grant, and revokes via Google's revocation endpoint. The
 * return shape matches `oauthClient()` so adapters can spread it in the same
 * way, but there is no `handoff` ticket and no contract version.
 */
export function googleOAuthClient(options: OAuthClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const tokenEndpoint = () => {
    if (!options.tokenEndpoint) throw providerError(options.connectorId, 500, "provider_configuration");
    return options.tokenEndpoint;
  };
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
      // Offline access keeps refresh tokens recoverable across reconnects.
      // Google does not support incremental authorization for installed apps,
      // so the active token response is the only scope truth we persist.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return { authorizationUrl: url.toString(), state: context.state };
    },
    async completeAuth(callback: ConnectorAuthCallback): Promise<ConnectorAuthResult> {
      const callbackUrl = new URL(callback.callbackUrl);
      const expectedRedirect = new URL(options.redirectUri);
      if (
        callbackUrl.protocol !== expectedRedirect.protocol ||
        callbackUrl.hostname !== expectedRedirect.hostname ||
        callbackUrl.port !== expectedRedirect.port ||
        callbackUrl.pathname !== expectedRedirect.pathname
      ) {
        throw providerError(options.connectorId, 400, "redirect_mismatch");
      }
      const states = callbackUrl.searchParams.getAll("state");
      if (states.length !== 1 || states[0] !== callback.expectedState) {
        throw providerError(options.connectorId, 400, "state_mismatch");
      }
      const codes = callbackUrl.searchParams.getAll("code");
      if (codes.length !== 1 || !codes[0]) throw providerError(options.connectorId, 400, "missing_code");
      const code = codes[0];
      const response = await fetcher(tokenEndpoint(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          code_verifier: callback.codeVerifier
        }).toString()
      });
      if (!response.ok) throw providerError(options.connectorId, response.status, "token_exchange");
      const tokenBody = await safeJson(response);
      const tokens = tokenSet(tokenBody);
      const account = await googleIdentity(tokens.accessToken);
      return { tokens, account };
    },
    async refresh(tokens: ConnectorTokenSet): Promise<ConnectorTokenSet> {
      if (!tokens.refreshToken) throw providerError(options.connectorId, 401, "expired_token");
      const response = await fetcher(tokenEndpoint(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken
        }).toString()
      });
      if (!response.ok) throw providerError(options.connectorId, response.status, "refresh_failed");
      const refreshed = tokenSet(await safeJson(response));
      // Google does not always re-issue a refresh token; keep the prior one.
      return {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
        scopes: refreshed.scopes
      };
    },
    async revoke(tokens: ConnectorTokenSet): Promise<void> {
      if (!options.revocationEndpoint) return;
      const response = await fetcher(options.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refreshToken ?? tokens.accessToken,
          token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token"
        }).toString()
      });
      // Google returns 200 on success; a 404 means the token is already gone.
      if (!response.ok && response.status !== 404) {
        throw providerError(options.connectorId, response.status, "revocation_failed");
      }
    }
  };

  async function googleIdentity(accessToken: string): Promise<ConnectorAccountSummary> {
    if (!options.identityEndpoint) {
      // Without an identity endpoint we can't enrich the account; surface a
      // minimal summary so the runtime still has a stable account id.
      return { id: "google-account", displayName: "Google account" };
    }
    const response = await fetcher(options.identityEndpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw providerError(options.connectorId, response.status, "identity_failed");
    const payload = await safeJson(response);
    if (isObject(payload) && typeof payload.picture === "string") {
      return accountSummary({ ...payload, avatarUrl: payload.picture });
    }
    return accountSummary(payload);
  }
}

function connectorTokenSet(value: JsonObject): ConnectorTokenSet {
  if (typeof value.accessToken !== "string") throw providerError("connector", 502, "malformed_token");
  return {
    accessToken: value.accessToken,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    tokenType: typeof value.tokenType === "string" ? value.tokenType : "Bearer",
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : []
  };
}

export function providerError(
  connectorId: ConnectorId,
  status: number,
  providerCode?: string,
  retryAfter?: string
): ConnectorError {
  const lowerCode = providerCode?.toLowerCase() ?? "";
  const code = status === 503 || lowerCode.includes("configuration") || lowerCode.includes("broker")
    ? "configuration-required"
    : status === 401
    ? "expired-auth"
    : status === 403 ? "permission-denied"
    : status === 404 ? "not-found"
    : status === 429 || lowerCode.includes("ratelimit") ? "rate-limited"
    : status === 400 || status === 422 ? "invalid-request"
    : status === 0 || status >= 500 ? "provider-unavailable"
    : "unknown";
  const missingScope = lowerCode.includes("missing_scope")
    ? " The installed app is missing a required scope."
    : "";
  return {
    connectorId,
    code,
    message: (code === "configuration-required" ? "This connector needs provider configuration before it can run."
      : code === "permission-denied" ? "The provider denied the required scope or permission."
      : code === "expired-auth" ? "The provider authorization expired; reconnect the account."
      : code === "rate-limited" ? "The provider rate limit was reached."
      : code === "not-found" ? "The requested provider resource was not found."
      : code === "invalid-request" ? "The provider rejected the request."
      : code === "provider-unavailable" ? (status === 0 ? "The provider network request failed." : "The provider is temporarily unavailable.")
      : "The connector request failed.") + missingScope,
    retryable: code === "rate-limited" || code === "provider-unavailable",
    ...(retryAfter ? { retryAfter: String(Number(retryAfter) * 1000) } : {})
  };
}

async function brokerError(
  connectorId: ConnectorId,
  operation: "handoff" | "refresh" | "revoke",
  response: Response
): Promise<ConnectorError> {
  const body = await optionalJson(response);
  const brokerCode = stringValue(body, "error");
  const message = stringValue(body, "message") ?? `The Mivlet auth broker ${operation} was unsuccessful.`;
  const retryable = isObject(body) && typeof body.retryable === "boolean" ? body.retryable : undefined;
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  if (brokerCode === "configuration-required") {
    return { connectorId, code: "configuration-required", message, retryable: false };
  }
  if (brokerCode === "rate-limited") {
    return { connectorId, code: "rate-limited", message, retryable: true, ...(retryAfter ? { retryAfter: String(Number(retryAfter) * 1000) } : {}) };
  }
  if (brokerCode === "provider-unavailable") {
    return { connectorId, code: "provider-unavailable", message, retryable: retryable ?? true };
  }
  if (
    brokerCode === "needs-auth" ||
    brokerCode === "invalid-state" ||
    brokerCode === "invalid-handoff" ||
    brokerCode === "expired-handoff" ||
    brokerCode === "unsupported-version" ||
    brokerCode === "invalid-request" ||
    brokerCode === "unknown-provider"
  ) {
    return {
      connectorId,
      code: operation === "refresh" ? "expired-auth" : "needs-auth",
      message,
      retryable: false
    };
  }
  if (retryable === true) {
    return { connectorId, code: "provider-unavailable", message, retryable: true };
  }
  return providerError(connectorId, response.status, brokerCode, retryAfter);
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
  try {
    return await response.json();
  } catch {
    throw providerError("connector", 502, "malformed_response");
  }
}
async function optionalJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return {};
  }
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
  const displayName = ["displayName", "name", "login", "username", "email"]
    .map((key) => value[key]).find((candidate): candidate is string => typeof candidate === "string") ?? String(id);
  return {
    id: String(id), displayName,
    ...(typeof value.handle === "string" ? { handle: value.handle } : typeof value.login === "string" ? { handle: value.login } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
    ...(typeof value.avatarUrl === "string" ? { avatarUrl: value.avatarUrl } : typeof value.avatar_url === "string" ? { avatarUrl: value.avatar_url } : {})
  };
}
function nestedString(value: unknown, outer: string, inner: string) {
  return isObject(value) ? stringValue(value[outer], inner) : undefined;
}
function numberHeader(headers: Headers | undefined, name: string) {
  const value = headers?.get(name);
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
