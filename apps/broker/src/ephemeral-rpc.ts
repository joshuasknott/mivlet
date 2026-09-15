/**
 * Pure async RPC layer for Durable Object broker ephemeral storage.
 *
 * - Encrypts sensitive fields using store-crypto before any DO write.
 * - Routes by idFromName(sha256(key)).
 * - Calls async DO methods (putX/consumeX/redeemX).
 * - Decrypts on read, returns full PendingExchange / HandoffEntry.
 * - Deterministic in-memory versions for tests use SerialDurableStub + in-memory DO instances (real enc/dec).
 *
 * This is the production path for durable; sync store contracts remain untouched for memory/default.
 */

import type { BrokerProviderId } from "@mivlet/connectors";
import type { ConnectorAccountSummary, ConnectorTokenSet } from "@mivlet/protocol";

import type { BrokerClock } from "./clock.js";
import { BROKER_HANDOFF_TTL_SECONDS } from "@mivlet/connectors";
import { pendingStateInUseError, assertAuthorizeState, type PendingExchange, type HandoffEntry } from "./stores.js";
import {
  computeStateHash,
  computeHandoffHash,
  encryptPendingSecrets,
  decryptPendingSecrets,
  encryptHandoffPayload,
  decryptHandoffPayload,
  assertStoreEncryptionKey,
} from "./store-crypto.js";

const TTL_MS = BROKER_HANDOFF_TTL_SECONDS * 1000;

export interface EphemeralOps {
  createPending(entry: Omit<PendingExchange, "createdAt">): Promise<void>;
  consumePending(state: string): Promise<PendingExchange | undefined>;
  issueHandoff(entry: Omit<HandoffEntry, "createdAt">): Promise<string>;
  redeemHandoff(handoff: string, state: string): Promise<HandoffEntry | undefined>;
}

/**
 * Create async ops wired to real DO bindings (production durable path).
 * Callers must provide the bindings from env.
 */
export function createEphemeralOps(
  bindings: { BROKER_PENDING?: any; BROKER_HANDOFF?: any },
  secret: string,
  clock: BrokerClock = { nowMs: () => Date.now() }
): EphemeralOps {
  assertStoreEncryptionKey(secret);
  const pendingNS = bindings.BROKER_PENDING;
  const handoffNS = bindings.BROKER_HANDOFF;

  return {
    async createPending(entry) {
      if (!pendingNS) throw new Error("BROKER_PENDING binding required");
      assertAuthorizeState(entry.state);
      const stateHash = await computeStateHash(entry.state);
      const id = pendingNS.idFromName(stateHash);
      const stub = pendingNS.get(id);
      const verifierEnc = await encryptPendingSecrets(secret, entry.state, entry.provider, {
        verifier: entry.verifier,
        codeChallenge: entry.codeChallenge
      });
      const now = clock.nowMs();
      const expiresAt = now + TTL_MS;
      const created = await stub.putPending({
        state: entry.state,
        provider: entry.provider,
        redirectUri: entry.redirectUri,
        providerRedirectUri: entry.providerRedirectUri,
        verifierEnc,
        createdAt: now,
        expiresAt,
      });
      if (created === false) throw pendingStateInUseError();
    },

    async consumePending(state) {
      if (!pendingNS) throw new Error("BROKER_PENDING binding required");
      const stateHash = await computeStateHash(state);
      const id = pendingNS.idFromName(stateHash);
      const stub = pendingNS.get(id);
      const row: any = await stub.consumePending(state);
      if (!row) return undefined;
      let verifier: string | undefined;
      let codeChallenge = "";
      if (row.verifierEnc && secret) {
        try {
          const secrets = await decryptPendingSecrets(secret, stateHash, row.provider, row.verifierEnc);
          verifier = secrets.verifier;
          codeChallenge = secrets.codeChallenge;
        } catch {
          return undefined; // corruption -> miss
        }
      }
      if (!codeChallenge) return undefined;
      return {
        provider: row.provider,
        redirectUri: row.redirectUri,
        providerRedirectUri: row.providerRedirectUri,
        state: row.state,
        verifier,
        codeChallenge,
        createdAt: row.createdAt ?? row.created_at_ms,
      } as PendingExchange;
    },

    async issueHandoff(entry) {
      if (!handoffNS) throw new Error("BROKER_HANDOFF binding required");
      const ticket = urlSafeTokenForRpc(32);
      const now = clock.nowMs();
      const expiresAt = now + TTL_MS;
      const payloadEnc = await encryptHandoffPayload(secret, ticket, entry.provider, entry.state, {
        tokens: entry.tokens,
        account: entry.account,
        codeChallenge: entry.codeChallenge
      });
      const ticketHash = await computeHandoffHash(ticket);
      const id = handoffNS.idFromName(ticketHash);
      const stub = handoffNS.get(id);
      await stub.putHandoff({
        ticket,
        provider: entry.provider,
        state: entry.state,
        payloadEnc,
        createdAt: now,
        expiresAt,
      });
      return ticket;
    },

    async redeemHandoff(handoff, state) {
      if (!handoffNS) throw new Error("BROKER_HANDOFF binding required");
      const ticketHash = await computeHandoffHash(handoff);
      const id = handoffNS.idFromName(ticketHash);
      const stub = handoffNS.get(id);
      const row: any = await stub.redeemHandoff(handoff, state);
      if (!row) return undefined;
      let tokens: ConnectorTokenSet = {} as ConnectorTokenSet;
      let account: ConnectorAccountSummary = {} as ConnectorAccountSummary;
      let codeChallenge = "";
      if (row.payloadEnc && secret) {
        try {
          const p = await decryptHandoffPayload(secret, ticketHash, row.provider, row.state ?? state, row.payloadEnc);
          tokens = p.tokens as ConnectorTokenSet;
          account = p.account as ConnectorAccountSummary;
          codeChallenge = p.codeChallenge;
        } catch {
          return undefined;
        }
      }
      if (!codeChallenge) return undefined;
      return {
        provider: row.provider,
        tokens,
        account,
        state: row.state,
        codeChallenge,
        createdAt: row.createdAt ?? row.created_at_ms,
      } as HandoffEntry;
    },
  };
}

/** Small helper (dupe of stores one to avoid cycle for now). */
function urlSafeTokenForRpc(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Create deterministic async ops for tests using SerialDurableStub + real DO class instances.
 * Uses real encrypt/decrypt, in-memory "storage" via mock ctx, serial execution for races.
 * The returned ops can be passed as ephemeralOps to MivletBroker for durable-path E2E tests.
 */
export async function createSerialInMemoryEphemeralOps(
  clock: BrokerClock,
  secret?: string
): Promise<{ ops: EphemeralOps; pendingInst: any; handoffInst: any; pendingStub: any; handoffStub: any }> {
  // Minimal mock sql that supports our exact queries (one row per "DO" instance)
  function createMockSql(tableName: string, rows: any[]) {
    return {
      exec(query: string, ...bindings: any[]) {
        const q = query.toLowerCase();
        if (q.includes("insert")) {
          const hash = bindings[0];
          const row: any = {};
          if (tableName === "pending") {
            // bindings order matches DO putPending schema
            row.state_hash = hash; row.stateHash = hash;
            row.provider = bindings[1];
            row.redirect_uri = bindings[2]; row.redirectUri = bindings[2];
            row.provider_redirect_uri = bindings[3]; row.providerRedirectUri = bindings[3];
            row.state = bindings[4];
            row.verifier_enc = bindings[5]; row.verifierEnc = bindings[5];
            row.created_at_ms = bindings[6]; row.createdAt = bindings[6];
            row.expires_at_ms = bindings[7]; row.expiresAt = bindings[7];
          } else {
            row.ticket_hash = hash; row.ticketHash = hash;
            row.provider = bindings[1];
            row.state = bindings[2];
            row.payload_enc = bindings[3]; row.payloadEnc = bindings[3];
            row.created_at_ms = bindings[4]; row.createdAt = bindings[4];
            row.expires_at_ms = bindings[5]; row.expiresAt = bindings[5];
          }
          const idx = rows.findIndex((r: any) => (tableName === "pending" ? r.state_hash === hash : r.ticket_hash === hash));
          if (idx >= 0) throw new Error("UNIQUE constraint failed");
          rows.push(row);
          return [];
        }
        if (q.includes("select")) {
          const hash = bindings[0];
          const match = rows.find((r: any) => (tableName === "pending" ? r.state_hash === hash : r.ticket_hash === hash));
          return match ? [match] : [];
        }
        if (q.includes("delete")) {
          const hash = bindings[0];
          const idx = rows.findIndex((r: any) => (tableName === "pending" ? r.state_hash === hash : r.ticket_hash === hash));
          if (idx < 0) return [];
          if (q.includes("expires_at_ms") && bindings.length >= 2) {
            const expiresAt = rows[idx].expires_at_ms ?? rows[idx].expiresAt;
            if (expiresAt <= bindings[1]) rows.splice(idx, 1);
            return [];
          }
          rows.splice(idx, 1);
          return [];
        }
        return [];
      },
    };
  }

  const pendingRows: any[] = [];
  const handoffRows: any[] = [];

  const pendingCtx: any = { storage: { sql: createMockSql("pending", pendingRows), setAlarm() {} }, nowMs: () => clock.nowMs() };
  const handoffCtx: any = { storage: { sql: createMockSql("handoff", handoffRows), setAlarm() {} }, nowMs: () => clock.nowMs() };

  // instantiate the real DO classes with mock ctx (they will use our sql sim)
  // Use dynamic import for ESM compatibility (vitest / tsx)
  const ds = await import("./durable-stores.js");
  const { BrokerPending, BrokerHandoff, SerialDurableStub } = ds;

  const pendingInst: any = new BrokerPending(pendingCtx, {});
  const handoffInst: any = new BrokerHandoff(handoffCtx, {});

  // attach for test snapshots (no _plain, real rows have enc only)
  pendingInst._rowsForTest = pendingRows;
  handoffInst._rowsForTest = handoffRows;

  // Serial stubs for race determinism
  const pendingStub = new SerialDurableStub(pendingInst);
  const handoffStub = new SerialDurableStub(handoffInst);

  // Now build ops that go through the stubs (for serial) + real enc
  const ops: EphemeralOps = {
    async createPending(entry) {
      assertAuthorizeState(entry.state);
      let verifierEnc: Uint8Array | null = null;
      if (secret) {
        verifierEnc = await encryptPendingSecrets(secret, entry.state, entry.provider, {
          verifier: entry.verifier,
          codeChallenge: entry.codeChallenge
        });
      }
      const now = clock.nowMs();
      const expiresAt = now + TTL_MS;
      const created = await pendingStub.invoke("putPending", {
        state: entry.state,
        provider: entry.provider,
        redirectUri: entry.redirectUri,
        providerRedirectUri: entry.providerRedirectUri,
        verifierEnc,
        createdAt: now,
        expiresAt,
      });
      if (created === false) throw pendingStateInUseError();
    },

    async consumePending(state) {
      const row: any = await pendingStub.invoke("consumePending", state);
      if (!row) return undefined;
      let verifier: string | undefined;
      let codeChallenge = "";
      if (row.verifierEnc && secret) {
        const h = await computeStateHash(state);
        try {
          const secrets = await decryptPendingSecrets(secret, h, row.provider, row.verifierEnc);
          verifier = secrets.verifier;
          codeChallenge = secrets.codeChallenge;
        } catch {
          return undefined;
        }
      }
      if (!codeChallenge) return undefined;
      return {
        provider: row.provider,
        redirectUri: row.redirectUri || row.redirect_uri,
        providerRedirectUri: row.providerRedirectUri || row.provider_redirect_uri,
        state: row.state,
        verifier,
        codeChallenge,
        createdAt: row.createdAt || row.created_at_ms,
      } as PendingExchange;
    },

    async issueHandoff(entry) {
      const ticket = urlSafeTokenForRpc(32);
      let payloadEnc: Uint8Array = new Uint8Array();
      if (secret) {
        payloadEnc = await encryptHandoffPayload(secret, ticket, entry.provider, entry.state, {
          tokens: entry.tokens,
          account: entry.account,
          codeChallenge: entry.codeChallenge
        });
      }
      const now = clock.nowMs();
      const expiresAt = now + TTL_MS;
      await handoffStub.invoke("putHandoff", {
        ticket,
        provider: entry.provider,
        state: entry.state,
        payloadEnc,
        createdAt: now,
        expiresAt,
      });
      return ticket;
    },

    async redeemHandoff(handoff, state) {
      const row: any = await handoffStub.invoke("redeemHandoff", handoff, state);
      if (!row) return undefined;
      let tokens: ConnectorTokenSet = {} as ConnectorTokenSet;
      let account: ConnectorAccountSummary = {} as ConnectorAccountSummary;
      let codeChallenge = "";
      if (row.payloadEnc && secret) {
        const h = await computeHandoffHash(handoff);
        try {
          const p = await decryptHandoffPayload(secret, h, row.provider, row.state || state, row.payloadEnc);
          tokens = p.tokens as ConnectorTokenSet;
          account = p.account as ConnectorAccountSummary;
          codeChallenge = p.codeChallenge;
        } catch {
          return undefined;
        }
      }
      if (!codeChallenge) return undefined;
      return {
        provider: row.provider,
        tokens,
        account,
        state: row.state,
        codeChallenge,
        createdAt: row.createdAt || row.created_at_ms,
      } as HandoffEntry;
    },
  };

  return { ops, pendingInst, handoffInst, pendingStub, handoffStub };
}
