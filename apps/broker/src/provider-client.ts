/**
 * Confidential OAuth provider client. This module performs the four OAuth
 * operations that REQUIRE the provider client secret: code exchange, refresh,
 * revocation, and identity resolution. The secret is held only here in broker
 * memory and sent only to the provider token/revocation endpoints over TLS.
 *
 * Every operation is pure over an injectable `fetch` so tests exercise the full
 * confidential flow without live provider calls. Errors are normalized to
 * {@link BrokerOAuthError} with human-safe, redacted messages.
 */

import type { BrokerProviderId } from "@fable/connectors";
import type { ConnectorAccountSummary, ConnectorTokenSet } from "@fable/protocol";

import type { BrokerClock } from "./clock.js";
import { base64String } from "./crypto-web.js";
import {
  providerProfile,
  resolveEndpoint,
  type ProviderCredentials,
  type ProviderProfile
} from "./provider-profiles.js";

export type BrokerFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface BrokerProviderClientOptions {
  provider: BrokerProviderId;
  credentials: ProviderCredentials;
  fetch?: BrokerFetch;
  clock?: BrokerClock;
  /**
   * Provider profile, pre-resolved by the broker once per request. Optional so
   * standalone callers still work; when omitted the profile is resolved from the
   * provider id on first use. PROFILES is immutable (`const`), so caching and
   * passing the same reference is behavior-neutral and avoids re-resolving the
   * profile inside each provider-client function on a single request.
   */
  profile?: ProviderProfile;
}

export class BrokerOAuthError extends Error {
  constructor(
    public readonly code:
      | "needs-auth"
      | "provider-unavailable"
      | "rate-limited"
      | "invalid-request",
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "BrokerOAuthError";
  }
}

/** Result of a confidential code exchange. */
export interface ExchangeResult {
  tokens: ConnectorTokenSet;
  /** Identity payload (provider-shaped) the profile normalizes. */
  identityPayload: unknown;
}

/**
 * Exchange a provider authorization code for tokens using the confidential client.
 * PKCE is only attached when the broker generated its own verifier (broker-pkce).
 */
export async function exchangeCode(
  options: BrokerProviderClientOptions,
  params: { code: string; redirectUri: string; verifier?: string }
): Promise<ExchangeResult> {
  const profile = profileOf(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    code: params.code,
    client_id: options.credentials.clientId,
    client_secret: options.credentials.clientSecret,
    redirect_uri: params.redirectUri
  });
  if (profile.tokenRequestStyle !== "form-without-grant-type") {
    body.set("grant_type", "authorization_code");
  }
  if (params.verifier) {
    body.set("code_verifier", params.verifier);
  }
  const json = await postTokenRequest(
    fetcher,
    options.provider,
    profile,
    options.credentials,
    body
  );
  const tokens = tokenSetFrom(json, options.clock ?? systemClockNow);
  return { tokens, identityPayload: json };
}

/** Rotate an expiring access token using the refresh token + confidential client. */
export async function refreshTokens(
  options: BrokerProviderClientOptions,
  refreshToken: string
): Promise<ConnectorTokenSet> {
  const profile = profileOf(options);
  if (!profile.supportsRefresh) {
    throw new BrokerOAuthError(
      "needs-auth",
      `${profile.label} does not support refresh for this OAuth flow.`,
      false
    );
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: options.credentials.clientId,
    client_secret: options.credentials.clientSecret
  });
  const json = await postTokenRequest(
    fetcher,
    options.provider,
    profile,
    options.credentials,
    body
  );
  const refreshed = tokenSetFrom(json, options.clock ?? systemClockNow);
  // Preserve the refresh token when the provider does not rotate it.
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? refreshToken
  };
}

/** Revoke a token at the provider. 404/unknown tokens are treated as success. */
export async function revokeToken(
  options: BrokerProviderClientOptions,
  token: string,
  hint?: "access_token" | "refresh_token"
): Promise<void> {
  const profile = profileOf(options);
  if (profile.revocationStyle === "none") {
    return;
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const endpoint = resolveEndpoint(profile.revocationEndpoint, options.credentials);
  if (profile.revocationStyle === "github-oauth-app") {
    const response = await fetcher(endpoint, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.github+json",
        authorization: basicAuth(options.credentials) ?? ""
      },
      body: JSON.stringify({ access_token: token })
    });
    if (!response.ok && response.status !== 404) {
      throw await errorFromResponse(options.provider, response, "revocation");
    }
    return;
  }
  const body = new URLSearchParams({ token });
  if (hint) body.set("token_type_hint", hint);
  // Linear uses Basic auth for revocation; Slack wants the token in-body.
  // We send both the body and
  // basic auth — providers ignore what they don't use, and the secret is only
  // sent to the provider revocation endpoint over TLS.
  const auth = options.provider === "slack" ? undefined : basicAuth(options.credentials);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(auth ? { authorization: auth } : {})
    },
    body: body.toString()
  });
  if (!response.ok && response.status !== 404) {
    throw await errorFromResponse(options.provider, response, "revocation");
  }
  // Slack returns 200 with { ok: false, error }; treat non-ok bodies as failure.
  if (options.provider === "slack") {
    await ensureSlackOk(options.provider, response);
  }
}

/** Resolve connected account identity from the provider. */
export async function resolveIdentity(
  options: BrokerProviderClientOptions,
  tokens: ConnectorTokenSet
): Promise<unknown> {
  const profile = profileOf(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (options.provider === "linear") {
    // Linear identity is a GraphQL query.
    const response = await fetcher(profile.identityEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `${authorizationScheme(options.provider, tokens.tokenType)} ${tokens.accessToken}`
      },
      body: JSON.stringify({
        query: "query { viewer { id name email avatarUrl organization { id name urlKey } } }"
      })
    });
    if (!response.ok) {
      throw await errorFromResponse(options.provider, response, "identity");
    }
    return await response.json();
  }
  const response = await fetcher(profile.identityEndpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `${authorizationScheme(options.provider, tokens.tokenType)} ${tokens.accessToken}`,
      ...(options.provider === "notion" ? { "notion-version": NOTION_VERSION } : {})
    }
  });
  if (!response.ok) {
    throw await errorFromResponse(options.provider, response, "identity");
  }
  return await response.json();
}

/** Normalize a provider identity payload via its profile. */
export function normalizeAccount(
  provider: BrokerProviderId,
  payload: unknown,
  profile?: ProviderProfile
): ConnectorAccountSummary {
  const resolved: ProviderProfile = profile ?? providerProfile(provider);
  return resolved.normalizeIdentity(payload);
}

// ---------------------------------------------------------------------------

/**
 * Resolve the profile for an options bundle, preferring the broker's
 * pre-resolved reference (one lookup per request) and falling back to a lookup
 * from the provider id for standalone callers. PROFILES is immutable, so the
 * cached reference is safe to reuse without copying.
 */
function profileOf(options: BrokerProviderClientOptions): ProviderProfile {
  return options.profile ?? providerProfile(options.provider);
}

async function postTokenRequest(
  fetcher: BrokerFetch,
  provider: BrokerProviderId,
  profile: ProviderProfile,
  credentials: ProviderCredentials,
  body: URLSearchParams
): Promise<Record<string, unknown>> {
  const init = tokenRequestInit(profile, credentials, body);
  const response = await fetcher(profile.tokenEndpoint, {
    ...init,
    method: "POST"
  });
  if (!response.ok) {
    throw await errorFromResponse(provider, response, "token exchange");
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new BrokerOAuthError(
      "provider-unavailable",
      `${profileLabel(provider)} token response was malformed.`,
      true
    );
  }
  if (provider === "slack") {
    await ensureSlackOk(provider, response, json);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new BrokerOAuthError(
      "provider-unavailable",
      `${profileLabel(provider)} token response was malformed.`,
      true
    );
  }
  return json as Record<string, unknown>;
}

function tokenRequestInit(
  profile: ProviderProfile,
  credentials: ProviderCredentials,
  body: URLSearchParams
): RequestInit {
  if (profile.tokenRequestStyle === "json-basic") {
    const payload: Record<string, string> = {};
    for (const [key, value] of body.entries()) {
      if (key !== "client_id" && key !== "client_secret" && key !== "code_verifier") {
        payload[key] = value;
      }
    }
    return {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: basicAuth(credentials) ?? "",
        "notion-version": NOTION_VERSION
      },
      body: JSON.stringify(payload)
    };
  }
  return {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: body.toString()
  };
}

async function ensureSlackOk(
  provider: BrokerProviderId,
  response: Response,
  parsed?: unknown
): Promise<void> {
  const body = parsed ?? (await safeJson(response));
  if (body && typeof body === "object" && (body as Record<string, unknown>).ok === false) {
    const code = String((body as Record<string, unknown>).error ?? "unknown");
    throw new BrokerOAuthError(
      slackCode(code),
      `${profileLabel(provider)} rejected the request (${redactCode(code)}).`,
      code === "ratelimited"
    );
  }
}

function slackCode(code: string): BrokerOAuthError["code"] {
  if (code === "ratelimited") return "rate-limited";
  if (code === "invalid_auth" || code === "token_revoked") return "needs-auth";
  if (code === "missing_scope") return "invalid-request";
  return "invalid-request";
}

async function errorFromResponse(
  provider: BrokerProviderId,
  response: Response,
  operation: string
): Promise<BrokerOAuthError> {
  if (response.status === 401) {
    return new BrokerOAuthError(
      "needs-auth",
      `${profileLabel(provider)} ${operation} was rejected.`,
      false
    );
  }
  if (response.status === 429) {
    return new BrokerOAuthError(
      "rate-limited",
      `${profileLabel(provider)} rate limit was reached during ${operation}.`,
      true
    );
  }
  if (response.status >= 500 || response.status === 0) {
    return new BrokerOAuthError(
      "provider-unavailable",
      `${profileLabel(provider)} was unavailable during ${operation}.`,
      true
    );
  }
  return new BrokerOAuthError(
    "invalid-request",
    `${profileLabel(provider)} ${operation} was rejected.`,
    false
  );
}

function tokenSetFrom(
  json: Record<string, unknown>,
  clock: { nowMs(): number }
): ConnectorTokenSet {
  const accessToken = stringOr(json, "access_token");
  if (!accessToken) {
    throw new BrokerOAuthError(
      "provider-unavailable",
      "Provider did not return an access token.",
      false
    );
  }
  const expiresIn = numberOr(json, "expires_in");
  const scopeRaw = stringOr(json, "scope");
  const scopeArray = arrayOfStrings(json, "scope");
  // Slack nests tokens under authed_user / access_token at top level; handle both.
  const refreshToken =
    stringOr(json, "refresh_token") ??
    stringOr(asObject(json, "authed_user"), "refresh_token");
  return {
    accessToken,
    refreshToken,
    tokenType: authorizationSchemeFromTokenType(stringOr(json, "token_type")),
    expiresAt: expiresIn
      ? new Date(clock.nowMs() + expiresIn * 1000).toISOString()
      : undefined,
    scopes: scopeArray ?? (scopeRaw ? scopeRaw.split(/[\s,]+/).filter(Boolean) : [])
  };
}

function basicAuth(credentials: ProviderCredentials): string | undefined {
  if (!credentials.clientId || !credentials.clientSecret) return undefined;
  return `Basic ${base64String(`${credentials.clientId}:${credentials.clientSecret}`)}`;
}

function authorizationScheme(provider: BrokerProviderId, tokenType: string): string {
  return provider === "slack" ? "Bearer" : authorizationSchemeFromTokenType(tokenType);
}

function authorizationSchemeFromTokenType(tokenType: string | undefined): string {
  return tokenType && tokenType.toLowerCase() !== "bot" ? tokenType : "Bearer";
}

function profileLabel(provider: BrokerProviderId): string {
  return providerProfile(provider).label;
}

function redactCode(code: string): string {
  // Provider error codes are not secrets, but keep them short and lowercase.
  return code.slice(0, 64);
}

const systemClockNow = { nowMs: () => Date.now() };

function asObject(value: unknown, key: string): Record<string, unknown> {
  const target = (value as Record<string, unknown>)?.[key];
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return target as Record<string, unknown>;
  }
  return {};
}
function stringOr(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}
function numberOr(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
}
function arrayOfStrings(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  if (!Array.isArray(candidate)) return undefined;
  const strings = candidate.filter((item): item is string => typeof item === "string" && Boolean(item));
  return strings.length ? strings : undefined;
}
async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const NOTION_VERSION = "2026-03-11";
