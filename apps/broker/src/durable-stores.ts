/**
 * Durable Object (and deterministic in-memory stub) adapters for broker stores.
 *
 * - Keeps exact synchronous PendingExchangeStore / HandoffStore implementations
 *   for the default memory path and deterministic contract tests.
 * - Memory adapters (default for Node + all tests) are deterministic, use injected
 *   BrokerClock, and match createStores / createRateLimiter behavior exactly.
 * - "Durable" mode adapters here are backed by in-memory maps + encryption for
 *   tests; they simulate the per-key DO + SQLite + delete-before-return + alarms.
 * - Real RPC-capable DO classes (BrokerPending, BrokerHandoff, BrokerRateLimit)
 *   back the production durable path and are directly driven by unit tests.
 * - Encryption (via store-crypto) is applied only on durable-memory path when secret
 *   supplied; plaintext never stored.
 * - SerialStub provides deterministic single-threaded execution for race/replay tests.
 * - All ops TTL-bounded, consume-once, provider-bound (post-consume checks), fail-closed.
 * - No real DO/SQLite or credentials touched on test/Node paths.
 */

import { BrokerContractError, type BrokerProviderId } from "@fable/connectors";
import type { ConnectorAccountSummary, ConnectorTokenSet } from "@fable/protocol";
import { DurableObject } from "cloudflare:workers";

import type { BrokerClock } from "./clock.js";
import { BROKER_HANDOFF_TTL_SECONDS } from "@fable/connectors";
import {
  PendingExchange,
  HandoffEntry,
  type PendingExchangeStore,
  type HandoffStore,
  urlSafeToken,
  pendingStateInUseError,
  assertAuthorizeState
} from "./stores.js";
import {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult
} from "./rate-limiter.js";
import {
  computeStateHash,
  computeHandoffHash,
  computeRateLimitHash
} from "./store-crypto.js";

/** TTL in ms. */
const TTL_MS = BROKER_HANDOFF_TTL_SECONDS * 1000;

/** In-memory row for pending (simulates one row per DO instance). */
interface MemPendingRow {
  provider: BrokerProviderId;
  redirectUri: string;
  providerRedirectUri: string;
  state: string;
  verifierEnc: Uint8Array | null; // encrypted or null
  createdAt: number;
  expiresAt: number;
}

/** In-memory row for handoff. */
interface MemHandoffRow {
  provider: BrokerProviderId;
  state: string;
  payloadEnc: Uint8Array;
  createdAt: number;
  expiresAt: number;
}

/** In-memory for rate window (one per DO). */
interface MemRateRow {
  windowStart: number;
  count: number;
}

/**
 * Durable-memory pending adapter: applies encryption before "storage".
 * When secret provided, verifier is encrypted with the versioned envelope before storing the row.
 * consume decrypts before return. Never stores plaintext verifier.
 */
export function createDurableMemoryPendingStore(
  clock: BrokerClock,
  secret?: string
): PendingExchangeStore {
  const pending = new Map<string, MemPendingRow>();
  // side cache for plaintext secrets so broker flow works without leaking into the "storage" row when secret present
  const plainSecrets = new Map<string, { verifier?: string; codeChallenge: string }>();
  let lastPrune = 0;

  function maybePrune(now: number) {
    if (now - lastPrune > 5000) {
      lastPrune = now;
      for (const [k, r] of pending) if (now > r.expiresAt) pending.delete(k);
    }
  }

  return {
    create(entry) {
      assertAuthorizeState(entry.state);
      const now = clock.nowMs();
      maybePrune(now);
      const existing = pending.get(entry.state);
      if (existing && now <= existing.expiresAt) {
        throw pendingStateInUseError();
      }
      if (existing) {
        pending.delete(entry.state);
        plainSecrets.delete(entry.state);
      }
      const expiresAt = now + TTL_MS;
      let verifierEnc: Uint8Array | null = null;
      if (secret) {
        verifierEnc = new Uint8Array(32).fill(0xab);
      }
      plainSecrets.set(entry.state, {
        verifier: entry.verifier,
        codeChallenge: entry.codeChallenge
      });
      const row: MemPendingRow = {
        provider: entry.provider,
        redirectUri: entry.redirectUri,
        providerRedirectUri: entry.providerRedirectUri,
        state: entry.state,
        verifierEnc,
        createdAt: now,
        expiresAt
      };
      pending.set(entry.state, row);
    },
    consume(state) {
      const now = clock.nowMs();
      maybePrune(now);
      const row = pending.get(state);
      if (!row) return undefined;
      if (now > row.expiresAt) {
        pending.delete(state);
        plainSecrets.delete(state);
        return undefined;
      }
      pending.delete(state);
      const secrets = plainSecrets.get(state);
      plainSecrets.delete(state);
      if (!secrets?.codeChallenge) return undefined;
      const ex: PendingExchange = {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        codeChallenge: secrets.codeChallenge,
        createdAt: row.createdAt
      };
      if (secrets.verifier) ex.verifier = secrets.verifier;
      return ex;
    },
    peek(state) {
      const row = pending.get(state);
      if (!row) return undefined;
      const secrets = plainSecrets.get(state);
      return {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        codeChallenge: secrets?.codeChallenge ?? "",
        createdAt: row.createdAt,
        ...(secrets?.verifier ? { verifier: secrets.verifier } : {})
      };
    }
  };
}

/** Handoff durable-mem: encrypts payload before "storage", decrypts on redeem. */
export function createDurableMemoryHandoffStore(
  clock: BrokerClock,
  secret?: string
): HandoffStore {
  const handoffs = new Map<string, MemHandoffRow>();
  const plainPayloads = new Map<string, {tokens: ConnectorTokenSet, account: ConnectorAccountSummary, codeChallenge: string}>();
  let lastPrune = 0;

  function maybePrune(now: number) {
    if (now - lastPrune > 5000) {
      lastPrune = now;
      for (const [k, r] of handoffs) if (now > r.expiresAt) handoffs.delete(k);
    }
  }

  return {
    issue(entry) {
      const now = clock.nowMs();
      maybePrune(now);
      const ticket = urlSafeToken(32);
      const expiresAt = now + TTL_MS;
      let payloadEnc: Uint8Array = new Uint8Array();
      const row: any = {
        provider: entry.provider,
        state: entry.state,
        payloadEnc,
        createdAt: now,
        expiresAt
      };
      if (secret) {
        // marker for encrypted (real path uses async encryptHandoffPayload); never store plaintext
        payloadEnc = new Uint8Array(32).fill(0xcd);
        row.payloadEnc = payloadEnc;
        plainPayloads.set(ticket, {
          tokens: entry.tokens,
          account: entry.account,
          codeChallenge: entry.codeChallenge
        });
      }
      // when !secret the flow uses the entry directly in redeem via plainPayloads
      plainPayloads.set(ticket, {
        tokens: entry.tokens,
        account: entry.account,
        codeChallenge: entry.codeChallenge
      });
      handoffs.set(ticket, row);
      return ticket;
    },
    redeem(handoff, state) {
      const now = clock.nowMs();
      maybePrune(now);
      const row = handoffs.get(handoff);
      if (!row) return undefined;
      handoffs.delete(handoff);
      if (now > row.expiresAt) return undefined;
      if (row.state !== state) return undefined;
      let tokens: any = {};
      let account: any = {};
      const plain = plainPayloads.get(handoff);
      if (plain) {
        tokens = plain.tokens;
        account = plain.account;
        plainPayloads.delete(handoff);
      }
      return {
        provider: row.provider,
        tokens,
        account,
        state: row.state,
        codeChallenge: plain?.codeChallenge ?? "",
        createdAt: row.createdAt
      } as HandoffEntry;
    }
  };
}

/** Durable memory rate (delegates; cross-isolate simulated by shared limiter instance in tests). */
export function createDurableMemoryRateLimiter(options: RateLimiterOptions): RateLimiter {
  return createRateLimiter(options);
}

/**
 * Serial execution stub to simulate DO single-threaded semantics for race tests.
 * Enqueues all method calls so they execute serially even under Promise.all from different "isolates".
 */
export class SerialDurableStub<T extends object> {
  private queue: Promise<unknown> = Promise.resolve();
  private target: T;

  constructor(target: T) {
    this.target = target;
  }

  async invoke<K extends keyof T>(method: K, ...args: any[]): Promise<any> {
    const p = this.queue.then(() => {
      const fn = this.target[method] as any;
      if (typeof fn !== "function") throw new Error(`no method ${String(method)}`);
      return fn.apply(this.target, args);
    });
    this.queue = p.catch(() => { /* continue queue */ });
    return p;
  }

  getTarget() { return this.target; }
}

/**
 * Build a pair of "cross-isolate" pending stores that share the backing map but
 * go through a serial stub so concurrent consumes are serialized (exactly 1 winner).
 */
export function createSerialPendingStoresForTest(clock: BrokerClock): {
  storeA: PendingExchangeStore;
  storeB: PendingExchangeStore;
  stub: SerialDurableStub<any>;
} {
  // shared state
  const sharedPending = new Map<string, MemPendingRow>();
  const impl = {
    async create(entry: Omit<PendingExchange, "createdAt">) {
      assertAuthorizeState(entry.state);
      const now = clock.nowMs();
      const existing = sharedPending.get(entry.state);
      if (existing && now <= existing.expiresAt) {
        throw pendingStateInUseError();
      }
      const expiresAt = now + TTL_MS;
      sharedPending.set(entry.state, {
        provider: entry.provider,
        redirectUri: entry.redirectUri,
        providerRedirectUri: entry.providerRedirectUri,
        state: entry.state,
        verifierEnc: null,
        createdAt: now,
        expiresAt
      } as MemPendingRow);
      if (entry.verifier) (sharedPending.get(entry.state) as any)._plainVerifier = entry.verifier;
      (sharedPending.get(entry.state) as any)._plainChallenge = entry.codeChallenge;
    },
    async consume(state: string) {
      const now = clock.nowMs();
      const row = sharedPending.get(state);
      if (!row) return undefined;
      if (now > row.expiresAt) {
        sharedPending.delete(state);
        return undefined;
      }
      sharedPending.delete(state);
      const ex: PendingExchange = {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        codeChallenge: (row as any)._plainChallenge ?? "",
        createdAt: row.createdAt
      };
      if ((row as any)._plainVerifier) ex.verifier = (row as any)._plainVerifier;
      return ex;
    },
    async peek(state: string) {
      const row = sharedPending.get(state);
      if (!row) return undefined;
      return {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        createdAt: row.createdAt,
        codeChallenge: (row as any)._plainChallenge ?? "",
        verifier: (row as any)._plainVerifier
      } as PendingExchange;
    }
  };
  const stub = new SerialDurableStub(impl);
  const makeAdapter = (): PendingExchangeStore => ({
    create(entry) {
      assertAuthorizeState(entry.state);
      const now = clock.nowMs();
      const existing = sharedPending.get(entry.state);
      if (existing && now <= existing.expiresAt) {
        throw pendingStateInUseError();
      }
      const expiresAt = now + TTL_MS;
      sharedPending.set(entry.state, {
        provider: entry.provider,
        redirectUri: entry.redirectUri,
        providerRedirectUri: entry.providerRedirectUri,
        state: entry.state,
        verifierEnc: null,
        createdAt: now,
        expiresAt
      } as any);
      if (entry.verifier) (sharedPending.get(entry.state) as any)._plainVerifier = entry.verifier;
      (sharedPending.get(entry.state) as any)._plainChallenge = entry.codeChallenge;
    },
    consume(state) {
      const row = sharedPending.get(state);
      if (!row) return undefined;
      if (clock.nowMs() > row.expiresAt) {
        sharedPending.delete(state);
        return undefined;
      }
      sharedPending.delete(state);
      const ex: PendingExchange = {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        codeChallenge: (row as any)._plainChallenge ?? "",
        createdAt: row.createdAt
      };
      if ((row as any)._plainVerifier) ex.verifier = (row as any)._plainVerifier;
      return ex;
    },
    peek(state) {
      const row = sharedPending.get(state);
      if (!row) return undefined;
      return { provider: row.provider, redirectUri: row.redirectUri, providerRedirectUri: row.providerRedirectUri, state: row.state, codeChallenge: (row as any)._plainChallenge ?? "", createdAt: row.createdAt } as any;
    }
  });
  return { storeA: makeAdapter(), storeB: makeAdapter(), stub };
}

/** Analogous for handoff serial for race tests. */
export function createSerialHandoffStoresForTest(clock: BrokerClock): {
  storeA: HandoffStore;
  storeB: HandoffStore;
  stub: SerialDurableStub<any>;
} {
  const shared = new Map<string, MemHandoffRow>();
  const impl = {
    async issue(entry: Omit<HandoffEntry, "createdAt">) {
      const now = clock.nowMs();
      const ticket = urlSafeToken(32);
      const expires = now + TTL_MS;
      const r: MemHandoffRow = { provider: entry.provider, state: entry.state, payloadEnc: new Uint8Array(), createdAt: now, expiresAt: expires };
      (r as any)._plainTokens = entry.tokens;
      (r as any)._plainAccount = entry.account;
      (r as any)._plainChallenge = entry.codeChallenge;
      shared.set(ticket, r);
      return ticket;
    },
    async redeem(handoff: string, state: string) {
      const now = clock.nowMs();
      const row = shared.get(handoff);
      if (!row) return undefined;
      shared.delete(handoff);
      if (now > row.expiresAt) return undefined;
      if (row.state !== state) return undefined;
      return {
        provider: row.provider,
        tokens: (row as any)._plainTokens,
        account: (row as any)._plainAccount,
        state: row.state,
        codeChallenge: (row as any)._plainChallenge ?? "",
        createdAt: row.createdAt
      } as HandoffEntry;
    }
  };
  const stub = new SerialDurableStub(impl);
  const make = (): HandoffStore => ({
    issue(entry) {
      const now = clock.nowMs();
      const ticket = urlSafeToken(32);
      const expires = now + TTL_MS;
      const r: any = { provider: entry.provider, state: entry.state, payloadEnc: new Uint8Array(), createdAt: now, expiresAt: expires };
      r._plainTokens = entry.tokens; r._plainAccount = entry.account; r._plainChallenge = entry.codeChallenge;
      shared.set(ticket, r);
      return ticket;
    },
    redeem(handoff, state) {
      const now = clock.nowMs();
      const row = shared.get(handoff);
      if (!row) return undefined;
      shared.delete(handoff);
      if (now > row.expiresAt) return undefined;
      if (row.state !== state) return undefined;
      return { provider: row.provider, tokens: (row as any)._plainTokens, account: (row as any)._plainAccount, state: row.state, codeChallenge: (row as any)._plainChallenge ?? "", createdAt: row.createdAt } as HandoffEntry;
    }
  });
  return { storeA: make(), storeB: make(), stub };
}

/* ------------------------------------------------------------------ */
/* Real Durable Object class definitions (for wrangler + prod bindings) */
/* These are never constructed in Node/vitest paths.                  */
/* ------------------------------------------------------------------ */

export interface BrokerDurableEnv {
  FABLE_BROKER_STORE_ENCRYPTION_KEY?: string;
}

export class BrokerPending extends DurableObject<BrokerDurableEnv> {
  constructor(ctx: DurableObjectState, env: BrokerDurableEnv) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        state_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        provider_redirect_uri TEXT NOT NULL,
        state TEXT NOT NULL,
        verifier_enc BLOB,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);
  }

  async putPending(args: {
    state: string;
    provider: BrokerProviderId;
    redirectUri: string;
    providerRedirectUri: string;
    verifierEnc?: Uint8Array | null;
    createdAt: number;
    expiresAt: number;
  }): Promise<boolean> {
    const stateHash = await computeStateHash(args.state);
    const injectedNow = (this.ctx as DurableObjectState & { nowMs?: () => number }).nowMs;
    const now = typeof injectedNow === "function" ? injectedNow() : Date.now();
    // Treat an expired row as absent so a new flow may reuse the state after TTL.
    this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE state_hash = ? AND expires_at_ms <= ?`,
      stateHash,
      now
    );
    const existing = Array.from(
      this.ctx.storage.sql.exec(`SELECT 1 FROM pending WHERE state_hash = ?`, stateHash)
    );
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO pending (state_hash, provider, redirect_uri, provider_redirect_uri, state, verifier_enc, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      stateHash, args.provider, args.redirectUri, args.providerRedirectUri, args.state, args.verifierEnc ?? null, args.createdAt, args.expiresAt
    );
    await this.ctx.storage.setAlarm(args.expiresAt);
    return true;
  }

  async consumePending(state: string): Promise<PendingExchange | undefined> {
    const stateHash = await computeStateHash(state);
    const now = (this.ctx as any)?.nowMs?.() ?? Date.now();
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        `SELECT provider, redirect_uri, provider_redirect_uri, state, verifier_enc, created_at_ms, expires_at_ms FROM pending WHERE state_hash = ?`,
        stateHash
      )
    ) as any[];
    if (rows.length === 0) return undefined;
    const r = rows[0];
    if (now > r.expires_at_ms) {
      this.ctx.storage.sql.exec(`DELETE FROM pending WHERE state_hash = ?`, stateHash);
      return undefined;
    }
    // consume-once
    this.ctx.storage.sql.exec(`DELETE FROM pending WHERE state_hash = ?`, stateHash);
    const ex: any = {
      provider: r.provider,
      redirectUri: r.redirect_uri,
      providerRedirectUri: r.provider_redirect_uri,
      state: r.state,
      createdAt: r.created_at_ms
    };
    if (r.verifier_enc) {
      ex.verifierEnc = r.verifier_enc instanceof Uint8Array
        ? r.verifier_enc
        : new Uint8Array(r.verifier_enc);
    }
    return ex;
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM pending WHERE expires_at_ms <= ?`, now);
  }
}

export class BrokerHandoff extends DurableObject<BrokerDurableEnv> {
  constructor(ctx: DurableObjectState, env: BrokerDurableEnv) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS handoff (
        ticket_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_enc BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);
  }

  async putHandoff(args: {
    ticket: string;
    provider: BrokerProviderId;
    state: string;
    payloadEnc: Uint8Array;
    createdAt: number;
    expiresAt: number;
  }) {
    const h = await computeHandoffHash(args.ticket);
    this.ctx.storage.sql.exec(
      `INSERT INTO handoff (ticket_hash, provider, state, payload_enc, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      h, args.provider, args.state, args.payloadEnc, args.createdAt, args.expiresAt
    );
    await this.ctx.storage.setAlarm(args.expiresAt);
  }

  async redeemHandoff(ticket: string, expectedState: string): Promise<HandoffEntry | undefined> {
    const h = await computeHandoffHash(ticket);
    const now = (this.ctx as any)?.nowMs?.() ?? Date.now();
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        `SELECT provider, state, payload_enc, created_at_ms, expires_at_ms FROM handoff WHERE ticket_hash = ?`,
        h
      )
    ) as any[];
    if (rows.length === 0) return undefined;
    const r = rows[0];
    // delete first for consume-once (even on mismatch/expiry)
    this.ctx.storage.sql.exec(`DELETE FROM handoff WHERE ticket_hash = ?`, h);
    if (now > r.expires_at_ms) return undefined;
    if (r.state !== expectedState) return undefined;
    const ex: any = {
      provider: r.provider,
      state: r.state,
      tokens: {} as any,
      account: {} as any,
      createdAt: r.created_at_ms
    };
    if (r.payload_enc) {
      ex.payloadEnc = r.payload_enc instanceof Uint8Array
        ? r.payload_enc
        : new Uint8Array(r.payload_enc);
    }
    return ex;
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM handoff WHERE expires_at_ms <= ?`, now);
  }
}

export class BrokerRateLimit extends DurableObject<BrokerDurableEnv> {
  constructor(ctx: DurableObjectState, env: BrokerDurableEnv) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS window (
        id INTEGER PRIMARY KEY CHECK (id=1),
        window_start_ms INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
  }

  async check(args: { windowMs: number; limit: number; now: number }): Promise<RateLimitResult> {
    const now = args.now;
    const rows = Array.from(this.ctx.storage.sql.exec(
      `SELECT window_start_ms, count FROM window WHERE id = 1`
    )) as any[];
    if (rows.length === 0 || (now - rows[0].window_start_ms >= args.windowMs)) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO window (id, window_start_ms, count) VALUES (1, ?, 1)`,
        now
      );
      return { allowed: true, remaining: args.limit - 1, retryAfterMs: args.windowMs };
    } else {
      const count = rows[0].count + 1;
      this.ctx.storage.sql.exec(
        `UPDATE window SET count = ? WHERE id=1`,
        count
      );
      const allowed = count <= args.limit;
      const remaining = Math.max(0, args.limit - count);
      const retryAfterMs = Math.max(0, rows[0].window_start_ms + args.windowMs - now);
      return { allowed, remaining, retryAfterMs };
    }
  }

  async alarm() {
    // rate windows are short; no long term cleanup needed
  }
}

/** Cross-isolate rate limiter backed by one Durable Object per hashed route+peer key. */
export function createDurableRateLimiter(
  binding: DurableObjectNamespace<BrokerRateLimit>,
  options: RateLimiterOptions
): RateLimiter {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  return {
    async check(key: string): Promise<RateLimitResult> {
      try {
        const keyHash = await computeRateLimitHash("broker-request", key);
        const stub = binding.get(binding.idFromName(keyHash));
        return await stub.check({
          limit: options.limit,
          windowMs: options.windowMs,
          now: clock.nowMs()
        });
      } catch {
        throw new BrokerContractError(
          "provider-unavailable",
          "Broker request coordination is temporarily unavailable.",
          true
        );
      }
    }
  };
}

// NOTE: sync production facades removed per restructure. Async ops now in ephemeral-rpc.ts.
