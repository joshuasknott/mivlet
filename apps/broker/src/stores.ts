/**
 * Single-use, time-boxed state stores for the broker OAuth flow.
 *
 * Two stores back the broker:
 *   - {@link PendingExchangeStore}: holds the desktop's `redirect_uri`, `state`,
 *     and (for broker-pkce providers) the broker-generated verifier, between the
 *     authorize request and the provider callback. Consumed exactly once on
 *     callback — a replayed callback finds no pending exchange and is rejected.
 *   - {@link HandoffStore}: holds the redeemed token set + account behind a
 *     short-lived opaque ticket. Consumed exactly once when the desktop redeems
 *     it; a second redemption is rejected, preventing token replay.
 *
 * Both stores prune expired entries on access. They are in-process by design: the
 * broker is stateless across restarts, and an in-flight OAuth flow simply restarts.
 */

import { randomBytes } from "node:crypto";

import { BROKER_HANDOFF_TTL_SECONDS, type BrokerProviderId } from "@fable/connectors";
import type { ConnectorAccountSummary, ConnectorTokenSet } from "@fable/protocol";

import type { BrokerClock } from "./clock.js";

interface PendingExchange {
  provider: BrokerProviderId;
  /** The desktop's exact redirect URI the provider callback must return to. */
  redirectUri: string;
  /** Desktop-supplied single-use state. */
  state: string;
  /** Broker-generated PKCE verifier (broker-pkce providers only). */
  verifier?: string;
  createdAt: number;
}

interface HandoffEntry {
  provider: BrokerProviderId;
  tokens: ConnectorTokenSet;
  account: ConnectorAccountSummary;
  /** Desktop state the handoff is bound to; must match on redeem. */
  state: string;
  createdAt: number;
  /** Becomes true after the first successful redemption. */
  consumed: boolean;
}

export interface PendingExchangeStore {
  create(entry: Omit<PendingExchange, "createdAt">): void;
  consume(state: string): PendingExchange | undefined;
  /** Test-only: peek without consuming. */
  peek(state: string): PendingExchange | undefined;
}

export interface HandoffStore {
  issue(entry: Omit<HandoffEntry, "createdAt" | "consumed">): string;
  redeem(handoff: string, state: string): HandoffEntry | undefined;
}

/** Create the in-process stores with an injectable clock (tests) + TTL. */
export function createStores(clock: BrokerClock): {
  pending: PendingExchangeStore;
  handoff: HandoffStore;
} {
  const pending = new Map<string, PendingExchange>();
  const handoffs = new Map<string, HandoffEntry>();

  const ttlMs = BROKER_HANDOFF_TTL_SECONDS * 1000;

  function prune(map: Map<string, { createdAt: number }>) {
    const now = clock.nowMs();
    for (const [key, entry] of map) {
      if (now - entry.createdAt > ttlMs) map.delete(key);
    }
  }

  return {
    pending: {
      create(entry) {
        prune(pending);
        pending.set(entry.state, { ...entry, createdAt: clock.nowMs() });
      },
      consume(state) {
        prune(pending);
        const entry = pending.get(state);
        if (!entry) return undefined;
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
        prune(handoffs);
        const ticket = urlSafeToken(32);
        handoffs.set(ticket, { ...entry, createdAt: clock.nowMs(), consumed: false });
        return ticket;
      },
      redeem(handoff, state) {
        prune(handoffs);
        const entry = handoffs.get(handoff);
        if (!entry) return undefined;
        // Single-use: mark consumed and remove. A second redeem finds nothing.
        handoffs.delete(handoff);
        if (entry.state !== state) return undefined;
        return entry;
      }
    }
  };
}

/** Generate a URL-safe opaque token of the requested byte length. */
export function urlSafeToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
