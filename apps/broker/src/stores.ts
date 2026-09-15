/**
 * Single-use, time-boxed state stores for the broker OAuth flow.
 *
 * Two stores back the broker:
 *   - {@link PendingExchangeStore}: holds the desktop's `redirect_uri`, `state`,
 *     and (for broker-pkce providers) the broker-generated verifier, between the
 *     authorize request and the provider callback. Created if-absent only — a
 *     second write for a live `state` is `invalid-state`, so an observer cannot
 *     replace the bound desktop redirect before callback. Consumed exactly once
 *     on callback — a replayed callback finds no pending exchange and is rejected.
 *   - {@link HandoffStore}: holds the redeemed token set + account behind a
 *     short-lived opaque ticket. Consumed exactly once when the desktop redeems
 *     it; a second redemption is rejected, preventing token replay.
 *
 * Both stores prune expired entries on access. They are in-process by design: the
 * broker is stateless across restarts, and an in-flight OAuth flow simply restarts.
 */

import { BROKER_HANDOFF_TTL_SECONDS, BrokerContractError, type BrokerProviderId } from "@fable/connectors";
import type { ConnectorAccountSummary, ConnectorTokenSet } from "@fable/protocol";

import type { BrokerClock } from "./clock.js";
import { base64url, randomBytes } from "./crypto-web.js";

/**
 * Minimum unreserved length so a base64url `state` can encode 128 bits.
 * Desktop mints 32 random bytes (~43 chars); this floor rejects guessable values
 * on every authorize backend without requiring a live CSPRNG at the broker.
 */
export const BROKER_AUTHORIZE_STATE_MIN_LENGTH = 22;
const BROKER_AUTHORIZE_STATE_MAX_LENGTH = 256;
const BROKER_AUTHORIZE_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Reject a reused live pending `state`. First write is immutable until consume or TTL. */
export function pendingStateInUseError(): BrokerContractError {
  return new BrokerContractError(
    "invalid-state",
    "Authorization state is already in use.",
    false
  );
}

/**
 * Authorize is public; `state` is the only unguessable binding between the
 * desktop redirect and the provider callback. Enforce the entropy floor on
 * every backend before a pending row is created.
 */
export function assertAuthorizeState(state: string): void {
  if (
    typeof state !== "string"
    || state.length < BROKER_AUTHORIZE_STATE_MIN_LENGTH
    || state.length > BROKER_AUTHORIZE_STATE_MAX_LENGTH
    || !BROKER_AUTHORIZE_STATE_PATTERN.test(state)
  ) {
    throw new BrokerContractError("invalid-state", "Authorization state is invalid.", false);
  }
}

export interface PendingExchange {
  provider: BrokerProviderId;
  /** The desktop's exact redirect URI the provider callback must return to. */
  redirectUri: string;
  /** Broker callback registered with the provider; reused for token exchange. */
  providerRedirectUri: string;
  /** Desktop-supplied single-use state. */
  state: string;
  /** Broker-generated PKCE verifier (broker-pkce providers only). */
  verifier?: string;
  createdAt: number;
}

export interface HandoffEntry {
  provider: BrokerProviderId;
  tokens: ConnectorTokenSet;
  account: ConnectorAccountSummary;
  /** Desktop state the handoff is bound to; must match on redeem. */
  state: string;
  createdAt: number;
}

export interface PendingExchangeStore {
  /**
   * Create-if-absent. A second create for a live `state` must throw
   * `invalid-state` so an observer cannot replace the bound desktop redirect.
   */
  create(entry: Omit<PendingExchange, "createdAt">): void;
  consume(state: string): PendingExchange | undefined;
  /** Test-only: peek without consuming. */
  peek(state: string): PendingExchange | undefined;
}

export interface HandoffStore {
  issue(entry: Omit<HandoffEntry, "createdAt">): string;
  redeem(handoff: string, state: string): HandoffEntry | undefined;
}

/** Minimum interval between full prune sweeps. The inline expiry check in each
 * store method (consume/redeem) guarantees TTL is still enforced locally on every
 * access, so the sweep only needs to reclaim idle/stranded entries. */
const PRUNE_INTERVAL_MS = 5000;

/** Create the in-process stores with an injectable clock (tests) + TTL. */
export function createStores(clock: BrokerClock): {
  pending: PendingExchangeStore;
  handoff: HandoffStore;
} {
  const pending = new Map<string, PendingExchange>();
  const handoffs = new Map<string, HandoffEntry>();

  const ttlMs = BROKER_HANDOFF_TTL_SECONDS * 1000;
  let lastPruneMs = 0;

  /** Full sweep of a single map, deleting every entry past its TTL. */
  function prune(map: Map<string, { createdAt: number }>) {
    const now = clock.nowMs();
    for (const [key, entry] of map) {
      if (now - entry.createdAt > ttlMs) map.delete(key);
    }
  }

  /**
   * Lazy/throttled prune: only run the full sweep when more than
   * {@link PRUNE_INTERVAL_MS} has elapsed since the last sweep. This is safe because
   * each store method also performs an inline expiry check on the entry it touches,
   * so TTL is enforced locally on every access regardless of when the sweep last ran.
   */
  function maybePrune(map: Map<string, { createdAt: number }>) {
    const now = clock.nowMs();
    if (now - lastPruneMs > PRUNE_INTERVAL_MS) {
      lastPruneMs = now;
      prune(map);
    }
  }

  /** Inline (local) TTL check on a fetched entry: if expired, delete and signal miss. */
  function isExpired(entry: { createdAt: number }, now: number): boolean {
    return now - entry.createdAt > ttlMs;
  }

  return {
    pending: {
      create(entry) {
        assertAuthorizeState(entry.state);
        maybePrune(pending);
        const existing = pending.get(entry.state);
        if (existing && !isExpired(existing, clock.nowMs())) {
          throw pendingStateInUseError();
        }
        pending.set(entry.state, { ...entry, createdAt: clock.nowMs() });
      },
      consume(state) {
        maybePrune(pending);
        const entry = pending.get(state);
        if (!entry) return undefined;
        // Inline TTL check: if the fetched entry has expired, treat it as gone.
        if (isExpired(entry, clock.nowMs())) {
          pending.delete(state);
          return undefined;
        }
        // Single-use: remove before returning so a concurrent/replayed callback
        // cannot trigger a second token exchange.
        pending.delete(state);
        return entry;
      },
      peek(state) {
        return pending.get(state);
      }
    },
    handoff: {
      issue(entry) {
        maybePrune(handoffs);
        const ticket = urlSafeToken(32);
        handoffs.set(ticket, { ...entry, createdAt: clock.nowMs() });
        return ticket;
      },
      redeem(handoff, state) {
        maybePrune(handoffs);
        const entry = handoffs.get(handoff);
        if (!entry) return undefined;
        // Single-use: delete before returning. A second redeem finds nothing.
        // For an expired entry this also reclaims it (fail-closed).
        handoffs.delete(handoff);
        if (isExpired(entry, clock.nowMs())) return undefined;
        if (entry.state !== state) return undefined;
        return entry;
      }
    }
  };
}

/** Generate a URL-safe opaque token of the requested byte length. */
export function urlSafeToken(bytes: number): string {
  return base64url(randomBytes(bytes));
}
