/**
 * The broker service: ties provider profiles, single-use stores, the confidential
 * provider client, and the versioned contract together into the operations the
 * HTTP routes call.
 *
 * The two flows:
 *
 * 1. Authorization + handoff issuance:
 *    - desktop calls authorize(redirect, state, desktopChallenge)
 *    - broker builds the provider authorization URL with its confidential client_id
 *      and (for broker-pkce providers) its OWN verifier, stores a pending exchange
 *      keyed by the desktop state, returns the URL
 *    - the provider calls the broker callback with code+state
 *    - broker consumes the single-use pending exchange, validates state, performs
 *      the confidential exchange with the provider secret + its verifier, resolves
 *      identity, issues a single-use short-lived handoff ticket bound to the state,
 *      and 302-redirects the browser to the desktop's exact redirect_uri with the
 *      handoff + state as query params
 *
 * 2. Handoff redemption, refresh, revocation: direct (non-browser) POSTs from the
 *    desktop. The token set crosses ONLY at handoff redemption, after the single-use
 *    ticket + bound state are validated.
 */

import {
  BROKER_CONTRACT_VERSION,
  BrokerContractError,
  type BrokerAuthorizeRequest,
  type BrokerAuthorizeResponse,
  type BrokerHandoffRedeemRequest,
  type BrokerHandoffRedeemResponse,
  type BrokerHandoffTicket,
  type BrokerHealthResponse,
  type BrokerProviderId,
  type BrokerRefreshRequest,
  type BrokerRefreshResponse,
  type BrokerRevokeRequest,
  type BrokerRevokeResponse,
  assertContractVersion,
  isBrokerProvider
} from "@fable/connectors";
import type { ConnectorTokenSet } from "@fable/protocol";

import type { BrokerClock } from "./clock.js";
import { generatePkcePair } from "./pkce.js";
import {
  normalizeAccount,
  exchangeCode,
  refreshTokens,
  resolveIdentity,
  revokeToken,
  BrokerOAuthError,
  type BrokerFetch,
  type ExchangeResult
} from "./provider-client.js";
import {
  providerProfile,
  resolveCredentials,
  configuredProviders
} from "./provider-profiles.js";
import { createStores, type HandoffStore, type PendingExchangeStore } from "./stores.js";

export interface BrokerOptions {
  env: BrokerEnvironment;
  /** Public HTTPS (or loopback development) base URL registered with providers. */
  publicBaseUrl?: string;
  /** Worker deployments must provide an explicit registered callback base URL. */
  requirePublicBaseUrl?: boolean;
  clock?: BrokerClock;
  fetch?: BrokerFetch;
  pending?: PendingExchangeStore;
  handoff?: HandoffStore;
}

export type BrokerEnvironment = Record<string, string | undefined>;

export interface BrokerAuthorizeOutput {
  response: BrokerAuthorizeResponse;
}

export interface BrokerCallbackOutput {
  /** The desktop redirect the browser should be sent to. */
  redirect: URL;
}

export class FableBroker {
  private readonly clock: BrokerClock;
  private readonly fetcher?: BrokerFetch;
  private readonly pending: PendingExchangeStore;
  private readonly handoff: HandoffStore;
  private readonly env: BrokerEnvironment;
  private readonly publicBaseUrl?: URL;
  private readonly requirePublicBaseUrl: boolean;

  constructor(options: BrokerOptions) {
    this.env = options.env;
    this.requirePublicBaseUrl = options.requirePublicBaseUrl ?? false;
    try {
      this.publicBaseUrl = options.publicBaseUrl ? new URL(options.publicBaseUrl) : undefined;
    } catch {
      this.publicBaseUrl = undefined;
    }
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.fetcher = options.fetch;
    const stores = createStores(this.clock);
    this.pending = options.pending ?? stores.pending;
    this.handoff = options.handoff ?? stores.handoff;
  }

  /** GET /healthz */
  health(): BrokerHealthResponse {
    return {
      status: "ok",
      contractVersion: BROKER_CONTRACT_VERSION,
      providers: configuredProviders(this.env),
      serverTime: new Date(this.clock.nowMs()).toISOString()
    };
  }

  /** GET /oauth/{provider}/authorize — begin the confidential flow. */
  async authorize(request: BrokerAuthorizeRequest): Promise<BrokerAuthorizeOutput> {
    assertContractVersion(request.contractVersion);
    this.requireProvider(request.provider);
    this.requireConfigured(request.provider);
    const profile = providerProfile(request.provider);
    const credentials = resolveCredentials(request.provider, this.env);
    validateDesktopRedirect(request.redirectUri, this.env);
    const providerRedirectUri = new URL(`oauth/${request.provider}/callback`, this.publicBaseUrlOrDefault()).toString();

    const url = new URL(profile.authorizationEndpoint);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", providerRedirectUri);
    url.searchParams.set("response_type", "code");
    if (profile.scopes.length) {
      url.searchParams.set("scope", profile.scopes.join(profile === providerProfile("slack") ? " " : " "));
    }
    url.searchParams.set("state", request.state);

    let verifier: string | undefined;
    if (profile.pkce === "broker-pkce") {
      const pair = await generatePkcePair();
      verifier = pair.verifier;
      url.searchParams.set("code_challenge", pair.challenge);
      url.searchParams.set("code_challenge_method", "S256");
    } else {
      // Provider does PKCE against the desktop-supplied challenge.
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", request.codeChallengeMethod);
    }

    // Store the single-use pending exchange keyed by the desktop state.
    this.pending.create({
      provider: request.provider,
      redirectUri: request.redirectUri,
      providerRedirectUri,
      state: request.state,
      verifier
    });

    return {
      response: {
        contractVersion: BROKER_CONTRACT_VERSION,
        authorizationUrl: url.toString(),
        state: request.state
      }
    };
  }

  /**
   * GET /oauth/{provider}/callback — the provider's registered callback. Performs
   * the confidential exchange and issues a single-use handoff, then redirects the
   * browser to the desktop's exact redirect_uri.
   */
  async callback(
    provider: BrokerProviderId,
    query: URLSearchParams
  ): Promise<BrokerCallbackOutput> {
    this.requireProvider(provider);
    this.requireConfigured(provider);

    const error = query.get("error");
    if (error) {
      throw new BrokerContractError("needs-auth", `Provider reported an authorization error.`, false);
    }
    const code = query.get("code");
    const state = query.get("state");
    if (!code) {
      throw new BrokerContractError("invalid-request", "Authorization callback is missing a code.", false);
    }
    if (!state) {
      throw new BrokerContractError("invalid-state", "Authorization callback is missing state.", false);
    }

    // Single-use: consume the pending exchange. A replayed or unknown callback
    // finds nothing here and is rejected before any token exchange.
    const pending = this.pending.consume(state);
    if (!pending) {
      throw new BrokerContractError("invalid-state", "Authorization state is unknown, expired, or already used.", false);
    }
    if (pending.provider !== provider) {
      throw new BrokerContractError("invalid-state", "Authorization state did not match the provider.", false);
    }

    const credentials = resolveCredentials(provider, this.env);
    let exchange: ExchangeResult;
    try {
      exchange = await exchangeCode(
        { provider, credentials, fetch: this.fetcher, clock: this.clock },
        { code, redirectUri: pending.providerRedirectUri, verifier: pending.verifier }
      );
    } catch (error) {
      throw brokerErrorFrom(error);
    }

    let identityPayload = exchange.identityPayload;
    if (!exchange.identityInline) {
      try {
        identityPayload = await resolveIdentity(
          { provider, credentials, fetch: this.fetcher, clock: this.clock },
          exchange.tokens
        );
      } catch (error) {
        throw brokerErrorFrom(error);
      }
    }
    const account = normalizeAccount(provider, identityPayload);

    // Issue a single-use, short-lived handoff bound to the desktop state.
    const ticket = this.handoff.issue({
      provider,
      tokens: exchange.tokens,
      account,
      state
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("handoff", ticket);
    redirect.searchParams.set("state", state);
    return { redirect };
  }

  /** POST /oauth/{provider}/handoff — desktop redeems the single-use ticket. */
  async redeem(request: BrokerHandoffRedeemRequest): Promise<BrokerHandoffRedeemResponse> {
    assertContractVersion(request.contractVersion);
    this.requireProvider(request.provider);
    const entry = this.handoff.redeem(request.handoff, request.state);
    if (!entry) {
      throw new BrokerContractError(
        "invalid-handoff",
        "The handoff token is unknown, expired, already used, or did not match the state.",
        false
      );
    }
    if (entry.provider !== request.provider) {
      throw new BrokerContractError("invalid-handoff", "The handoff token did not match the provider.", false);
    }
    return {
      contractVersion: BROKER_CONTRACT_VERSION,
      tokens: transportTokens(entry.tokens, this.clock.nowMs()),
      account: entry.account
    };
  }

  /** POST /oauth/{provider}/refresh — rotate an expiring token. */
  async refresh(request: BrokerRefreshRequest): Promise<BrokerRefreshResponse> {
    assertContractVersion(request.contractVersion);
    this.requireProvider(request.provider);
    this.requireConfigured(request.provider);
    const credentials = resolveCredentials(request.provider, this.env);
    try {
      const tokens = await refreshTokens(
        { provider: request.provider, credentials, fetch: this.fetcher, clock: this.clock },
        request.refreshToken
      );
      return { contractVersion: BROKER_CONTRACT_VERSION, tokens: transportTokens(tokens, this.clock.nowMs()) };
    } catch (error) {
      throw brokerErrorFrom(error);
    }
  }

  /** POST /oauth/{provider}/revoke — revoke at the provider during disconnect. */
  async revoke(request: BrokerRevokeRequest): Promise<BrokerRevokeResponse> {
    assertContractVersion(request.contractVersion);
    this.requireProvider(request.provider);
    this.requireConfigured(request.provider);
    const credentials = resolveCredentials(request.provider, this.env);
    try {
      await revokeToken(
        { provider: request.provider, credentials, fetch: this.fetcher, clock: this.clock },
        request.token,
        request.tokenTypeHint
      );
      return { contractVersion: BROKER_CONTRACT_VERSION, revoked: true };
    } catch (error) {
      throw brokerErrorFrom(error);
    }
  }

  /** Tokens held by the broker are never persisted; this is a test hook. */
  protected _handoffStore(): HandoffStore {
    return this.handoff;
  }

  private requireProvider(provider: unknown): asserts provider is BrokerProviderId {
    if (!isBrokerProvider(provider)) {
      throw new BrokerContractError("unknown-provider", "Unknown broker provider.", false);
    }
  }

  private requireConfigured(provider: BrokerProviderId): void {
    const profile = providerProfile(provider);
    if (!this.env[profile.clientIdEnv] || !this.env[profile.clientSecretEnv]) {
      throw new BrokerContractError(
        "configuration-required",
        `${profile.label} is not configured on this broker.`,
        false
      );
    }
  }

  private publicBaseUrlOrDefault(): URL {
    if (this.publicBaseUrl) return this.publicBaseUrl;
    if (this.requirePublicBaseUrl) {
      throw new BrokerContractError(
        "configuration-required",
        "The broker public URL is not configured.",
        false
      );
    }
    return new URL("http://127.0.0.1:8788/");
  }
}

/**
 * Allow only the desktop loopback callback shape, or an exact HTTPS callback
 * explicitly listed for managed desktop schemes. Loopback ports are ephemeral,
 * but host and path are fixed and query/fragment/userinfo are forbidden.
 */
function validateDesktopRedirect(value: string, env: BrokerEnvironment): void {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new BrokerContractError("invalid-request", "Desktop redirect URI is invalid.", false);
  }
  const loopback = redirect.protocol === "http:"
    && (redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]")
    && redirect.pathname === "/callback";
  const exact = (env.FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean)
    .some((entry) => entry === redirect.toString());
  if ((!loopback && !exact) || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new BrokerContractError("invalid-request", "Desktop redirect URI is not allowed.", false);
  }
}

/** Add wire-compatible relative expiry/scope fields for the native desktop. */
function transportTokens(tokens: ConnectorTokenSet, nowMs: number): ConnectorTokenSet {
  const expiresIn = tokens.expiresAt
    ? Math.max(0, Math.floor((Date.parse(tokens.expiresAt) - nowMs) / 1000))
    : undefined;
  return Object.assign({}, tokens, {
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    scope: tokens.scopes.join(" ")
  });
}

/** Convert a provider-client error into a structured broker error. */
function brokerErrorFrom(error: unknown): BrokerContractError {
  if (error instanceof BrokerContractError) return error;
  if (error instanceof BrokerOAuthError) {
    switch (error.code) {
      case "needs-auth":
        return new BrokerContractError("needs-auth", error.message, false);
      case "rate-limited":
        return new BrokerContractError("rate-limited", error.message, true);
      case "provider-unavailable":
        return new BrokerContractError("provider-unavailable", error.message, true);
      default:
        return new BrokerContractError("invalid-request", error.message, false);
    }
  }
  return new BrokerContractError(
    "provider-unavailable",
    "An unexpected error occurred while contacting the provider.",
    true
  );
}

/** Re-export for the desktop-side contract helper (tokens type only). */
export type { ConnectorTokenSet, BrokerHandoffTicket };
