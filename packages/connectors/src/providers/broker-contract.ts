/**
 * Typed, versioned contract between the Mivlet auth broker and the desktop.
 *
 * The broker is the ONLY place provider client secrets live. The desktop and the
 * broker exchange these exact shapes across the OAuth surface. Both sides import
 * this module so the contract is defined once, type-checked on both sides, and
 * fails closed on a version mismatch.
 *
 * Security invariants enforced by the broker and verified by tests:
 *   - Client secrets and provider tokens never appear in any of these response
 *     shapes, URLs, logs, or audit records. The token set crosses to the desktop
 *     only through the single-use handoff redemption, never through a redirect.
 *   - `state` is single-use and bound to the exact desktop `redirect_uri`; a
 *     reused or substituted callback is rejected before any token exchange.
 *   - The handoff token is short-lived (≤60s) and single-use; redeeming it twice
 *     is rejected, preventing token replay.
 *
 * This module is pure types and constants — no network, no secret access. It is
 * safe to import from the desktop, the connector package, and the broker.
 */

import type {
  ConnectorAccountSummary,
  ConnectorTokenSet
} from "@fable/protocol";

/** Confidential-client providers the broker serves. Google is direct public-client PKCE. */
export const BROKER_PROVIDER_IDS = [
  "github",
  "vercel",
  "linear",
  "notion",
  "slack"
] as const;

export type BrokerProviderId = (typeof BROKER_PROVIDER_IDS)[number];

/** Contract schema version. Bumped on a breaking change to any shape below. */
export const BROKER_CONTRACT_VERSION = 1 as const;

/** Handoff token lifetime in seconds. Short by design: single-use and redeemed over a direct call. */
export const BROKER_HANDOFF_TTL_SECONDS = 60;

/**
 * Request the desktop sends to start authorization. `codeChallenge` is the S256
 * PKCE challenge the desktop generated; the broker carries it to the provider so
 * the confidential exchange stays PKCE-bound even though the broker owns the secret.
 */
export interface BrokerAuthorizeRequest {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  provider: BrokerProviderId;
  /** The desktop's exact loopback (dev) or https redirect URI. */
  redirectUri: string;
  /** Cryptographically random, single-use. Generated and stored by the desktop. */
  state: string;
  /** S256 PKCE challenge (verifier stays in the desktop OS keyring). */
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/** Broker response to an authorize request. */
export interface BrokerAuthorizeResponse {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  /** The provider authorization URL the desktop opens in a browser. */
  authorizationUrl: string;
  /** Echoed so the desktop can bind its stored pending state to the response. */
  state: string;
}

/**
 * The single-use handoff that the broker mints after it completes the
 * confidential exchange with the provider. It crosses to the desktop ONLY through
 * a short-lived redirect query parameter; the desktop then redeems it directly.
 *
 * It intentionally carries NO token data — only an opaque ticket + the desktop
 * `state` it is bound to. Tokens are handed over only at handoff redemption.
 */
export interface BrokerHandoffTicket {
  /** Opaque, single-use, time-boxed. */
  handoff: string;
  /** The desktop state the broker bound this handoff to. Must match on redeem. */
  state: string;
  provider: BrokerProviderId;
}

/** Request the desktop sends to redeem a handoff ticket for the token set. */
export interface BrokerHandoffRedeemRequest {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  provider: BrokerProviderId;
  handoff: string;
  /** Must equal the state the handoff was bound to. */
  state: string;
}

/**
 * The token set + resolved account the desktop receives at redemption. This is
 * the ONLY shape in which provider tokens cross the broker→desktop boundary, and
 * it crosses over a direct (non-browser) call after the handoff is validated.
 */
export interface BrokerHandoffRedeemResponse {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  tokens: ConnectorTokenSet;
  account: ConnectorAccountSummary;
}

/** Request for a refresh-token rotation through the confidential client. */
export interface BrokerRefreshRequest {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  provider: BrokerProviderId;
  refreshToken: string;
}

export interface BrokerRefreshResponse {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  tokens: ConnectorTokenSet;
}

/** Request to revoke a token at the provider during a desktop disconnect. */
export interface BrokerRevokeRequest {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  provider: BrokerProviderId;
  token: string;
  /** Hint so the broker revokes the right token type for the provider. */
  tokenTypeHint?: "access_token" | "refresh_token";
}

export interface BrokerRevokeResponse {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  revoked: boolean;
}

/**
 * Structured, redacted error every broker route emits on failure. `message` is
 * human-safe and never includes a secret, token, or provider diagnostic detail.
 * `detail` is omitted entirely when it could leak (kept for test introspection
 * only and never serialized with a secret).
 */
export interface BrokerErrorResponse {
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  /** Stable, machine-readable error code. */
  error: BrokerErrorCode;
  message: string;
  /** Whether the desktop should retry the same request. */
  retryable: boolean;
}

export type BrokerErrorCode =
  | "configuration-required"
  | "invalid-request"
  | "invalid-state"
  | "expired-handoff"
  | "invalid-handoff"
  | "unknown-provider"
  | "unsupported-version"
  | "needs-auth"
  | "provider-unavailable"
  | "rate-limited";

/** Subset of HTTP status codes the broker returns. */
export const BROKER_HEALTH_OK = "ok" as const;

export interface BrokerHealthResponse {
  status: typeof BROKER_HEALTH_OK;
  contractVersion: typeof BROKER_CONTRACT_VERSION;
  /** Configured provider ids only (never their secrets or connection state). */
  providers: BrokerProviderId[];
  /** Server time, for clock-skew diagnostics. */
  serverTime: string;
}

/**
 * Reject an unsupported contract version uniformly. The desktop and broker are
 * version-pinned to {@link BROKER_CONTRACT_VERSION}; any mismatch fails closed.
 */
export function assertContractVersion(
  version: unknown
): asserts version is typeof BROKER_CONTRACT_VERSION {
  if (version !== BROKER_CONTRACT_VERSION) {
    throw new BrokerContractError("unsupported-version", "Unsupported broker contract version.", false);
  }
}

/** Error class carrying the structured {@link BrokerErrorResponse} shape. */
export class BrokerContractError extends Error {
  readonly contractVersion = BROKER_CONTRACT_VERSION;
  constructor(
    public readonly error: BrokerErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "BrokerContractError";
  }
  toResponse(): BrokerErrorResponse {
    return {
      contractVersion: this.contractVersion,
      error: this.error,
      message: this.message,
      retryable: this.retryable
    };
  }
}

/** Type guard for the broker provider vocabulary. */
export function isBrokerProvider(value: unknown): value is BrokerProviderId {
  return typeof value === "string" && (BROKER_PROVIDER_IDS as readonly string[]).includes(value);
}
