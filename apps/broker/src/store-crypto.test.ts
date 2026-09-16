/**
 * Tests for the store encryption envelope (pure, no I/O).
 * Covers: versioned envelope, HKDF derivation, AAD binding, corruption detection,
 * key missing/invalid, replay via AAD swap, and that plaintext secrets are never in blobs.
 */

import { describe, expect, it } from "vitest";

import { BROKER_PKCE_S256_EXAMPLE } from "@mivlet/connectors";
import type { BrokerProviderId } from "@mivlet/connectors";

import { MivletBroker } from "./broker.js";
import { fixedClock } from "./clock.js";
import { BrokerPending } from "./durable-stores.js";
import { createSerialInMemoryEphemeralOps } from "./ephemeral-rpc.js";
import {
  encryptPendingSecrets,
  decryptPendingSecrets,
  encryptHandoffPayload,
  decryptHandoffPayload,
  computeStateHash,
  computeHandoffHash,
  derivePeerKey,
  StoreCryptoError,
  looksLikePlaintextToken
} from "./store-crypto.js";

function makeSecret(): string {
  const z = new Uint8Array(32);
  return btoa(String.fromCharCode(...z)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TEST_SECRET = makeSecret();
const PROVIDER: BrokerProviderId = "github";
const DESKTOP_CHALLENGE = BROKER_PKCE_S256_EXAMPLE.challenge;

function pendingSecrets(verifier: string) {
  return { verifier, codeChallenge: DESKTOP_CHALLENGE };
}

describe("store-crypto", () => {
  it("encrypt/decrypt pending secrets roundtrips and binds AAD", async () => {
    const state = "state-abc-12345678901234567890";
    const verifier = "pkce-verifier-1234567890";
    const blob = await encryptPendingSecrets(TEST_SECRET, state, PROVIDER, pendingSecrets(verifier));
    expect(blob.length).toBeGreaterThan(12 + 16 + 1);
    const dec = await decryptPendingSecrets(TEST_SECRET, await computeStateHash(state), PROVIDER, blob);
    expect(dec).toEqual(pendingSecrets(verifier));
  });

  it("encrypt/decrypt handoff payload roundtrips with state+provider AAD", async () => {
    const ticket = "handoff-ticket-12345678901234567890";
    const state = "state-xyz";
    const payload = {
      tokens: { accessToken: "tok-secret-abc" },
      account: { id: "u1" },
      codeChallenge: DESKTOP_CHALLENGE
    };
    const blob = await encryptHandoffPayload(TEST_SECRET, ticket, PROVIDER, state, payload);
    const dec = await decryptHandoffPayload(TEST_SECRET, await computeHandoffHash(ticket), PROVIDER, state, blob);
    expect(dec.tokens).toEqual({ accessToken: "tok-secret-abc" });
    expect(dec.codeChallenge).toBe(DESKTOP_CHALLENGE);
  });

  it("key missing fails closed", async () => {
    await expect(encryptPendingSecrets("", "s12345678901234567890", PROVIDER, pendingSecrets("v")))
      .rejects.toThrow(StoreCryptoError);
    await expect(encryptPendingSecrets("short", "s12345678901234567890", PROVIDER, pendingSecrets("v")))
      .rejects.toThrow(StoreCryptoError);
  });

  it("corrupt ciphertext or AAD swap fails decrypt (fail closed)", async () => {
    const state = "state-for-aad-12345678901234567890";
    const v = "verif";
    const blob = await encryptPendingSecrets(TEST_SECRET, state, PROVIDER, pendingSecrets(v));
    const bad = new Uint8Array(blob);
    bad[bad.length - 1] ^= 0xff;
    await expect(decryptPendingSecrets(TEST_SECRET, await computeStateHash(state), PROVIDER, bad))
      .rejects.toThrow(StoreCryptoError);

    const blob2 = await encryptPendingSecrets(TEST_SECRET, state, "slack", pendingSecrets(v));
    await expect(decryptPendingSecrets(TEST_SECRET, await computeStateHash(state), PROVIDER, blob2))
      .rejects.toThrow(StoreCryptoError);
  });

  it("blobs do not contain plaintext verifier or token", async () => {
    const state = "s12345678901234567890state";
    const secretV = "super-secret-pkce-verifier-should-not-appear";
    const blobV = await encryptPendingSecrets(TEST_SECRET, state, PROVIDER, pendingSecrets(secretV));
    const s = new TextDecoder().decode(blobV);
    expect(s).not.toContain("super-secret-pkce");
    expect(looksLikePlaintextToken(blobV)).toBe(false);

    const payload = {
      tokens: { accessToken: "ya29.real-token-never-in-store" },
      account: {},
      codeChallenge: DESKTOP_CHALLENGE
    };
    const blobP = await encryptHandoffPayload(TEST_SECRET, "t12345678901234567890t", PROVIDER, "st", payload);
    const sp = new TextDecoder().decode(blobP);
    expect(sp).not.toContain("ya29.real");
  });

  it("compute hashes are stable and url-safe", async () => {
    const h1 = await computeStateHash("state-12345678901234567890");
    const h2 = await computeStateHash("state-12345678901234567890");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await derivePeerKey("1.2.3.4")).length).toBe(32);
  });
});

describe("DO class direct drive + no-plaintext snapshot", () => {
  it("instantiates BrokerPending and stores encrypted verifier; raw has no plaintext", async () => {
    const inserts: unknown[] = [];
    const mockCtx = {
      storage: {
        sql: {
          exec(q: string, ...bindings: unknown[]) {
            if (/INSERT/i.test(q)) inserts.push({ q, bindings });
            return [];
          }
        },
        setAlarm() {}
      }
    };
    const d = new BrokerPending(mockCtx as never, {});
    const state = "state-do-12345678901234567890";
    const verifier = "secret-verifier-do-not-appear-in-sql";
    const enc = await encryptPendingSecrets(makeSecretForTest(), state, "github", pendingSecrets(verifier));
    await d.putPending({
      state,
      provider: "github",
      redirectUri: "r",
      providerRedirectUri: "pr",
      verifierEnc: enc,
      createdAt: 1,
      expiresAt: Date.now() + 10000
    });
    const joined = JSON.stringify(inserts);
    expect(joined).not.toContain("secret-verifier-do-not-appear");
    expect(joined).toContain("verifier_enc");
  });

  it("handoff via serial in-mem ops + broker flow: no plaintext in storage rows", async () => {
    const clock = fixedClock(1000);
    const secret = makeSecretForTest();
    const { ops, pendingInst, handoffInst } = await createSerialInMemoryEphemeralOps(clock, secret);
    const ENV = { MIVLET_BROKER_GITHUB_CLIENT_ID: "id", MIVLET_BROKER_GITHUB_CLIENT_SECRET: "sec" };
    const pfetch = async (u: string) => {
      const url = new URL(u);
      if (url.href.includes("token")) {
        return new Response(JSON.stringify({ access_token: "tok-no-plain" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.href.includes("user")) {
        return new Response(JSON.stringify({ id: 1, login: "u" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const broker = new MivletBroker({
      env: ENV,
      clock,
      fetch: pfetch,
      publicBaseUrl: "https://b.test/",
      ephemeralOps: ops
    });
    expect(broker.health().providers).toContain("github");
    const state = "flowstate12345678901234567890";
    await ops.createPending({
      provider: "github",
      redirectUri: "r",
      providerRedirectUri: "pr",
      state,
      verifier: "verif-flow-plain-never-stored",
      codeChallenge: DESKTOP_CHALLENGE
    });
    const cons = await ops.consumePending(state);
    expect(cons?.verifier).toBe("verif-flow-plain-never-stored");
    expect(cons?.codeChallenge).toBe(DESKTOP_CHALLENGE);
    const pSnap = JSON.stringify(pendingInst._rowsForTest || []);
    expect(pSnap).not.toContain("verif-flow-plain");
    const ticket = await ops.issueHandoff({
      provider: "github",
      tokens: { accessToken: "tok-flow-plain-never", tokenType: "Bearer", scopes: [] },
      account: { id: "u", displayName: "U" },
      state,
      codeChallenge: DESKTOP_CHALLENGE
    });
    const hSnap = JSON.stringify(handoffInst._rowsForTest || []);
    expect(hSnap).toContain("payload_enc");
    expect(hSnap).not.toContain("tok-flow-plain");
    const red = await ops.redeemHandoff(ticket, state);
    expect(red?.tokens?.accessToken).toBe("tok-flow-plain-never");
    expect(red?.codeChallenge).toBe(DESKTOP_CHALLENGE);
  });
});

function makeSecretForTest() {
  const z = new Uint8Array(32);
  for (let i = 0; i < 32; i++) z[i] = i;
  return btoa(String.fromCharCode(...z)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
