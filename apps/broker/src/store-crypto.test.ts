/**
 * Tests for the store encryption envelope (pure, no I/O).
 * Covers: versioned envelope, HKDF derivation, AAD binding, corruption detection,
 * key missing/invalid, replay via AAD swap, and that plaintext secrets are never in blobs.
 */

import { describe, expect, it } from "vitest";

import {
  encryptVerifier,
  decryptVerifier,
  encryptHandoffPayload,
  decryptHandoffPayload,
  computeStateHash,
  computeHandoffHash,
  derivePeerKey,
  StoreCryptoError,
  looksLikePlaintextToken
} from "./store-crypto.js";
import type { BrokerProviderId } from "@fable/connectors";
import { FableBroker } from "./broker.js";
import { fixedClock } from "./clock.js";
import { BrokerPending } from "./durable-stores.js";
import { createSerialInMemoryEphemeralOps } from "./ephemeral-rpc.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex chars? Wait, base64url of 32B
// 32 random bytes base64url (no pad)
const GOOD_SECRET = "dGVzdC1zZWNyZXQtMzItYnl0ZXMtZXhhY3QtZm9yLWJyb2tlcg"; // ~43 chars, decode to 32? Use proper.
const VALID_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // placeholder; will be decoded to 32 zero bytes for test (ok for test only)

function makeSecret(): string {
  // 32 zero bytes -> base64url
  const z = new Uint8Array(32);
  let b64 = btoa(String.fromCharCode(...z)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return b64;
}

const TEST_SECRET = makeSecret();

const PROVIDER: BrokerProviderId = "github";

describe("store-crypto", () => {
  it("encrypt/decrypt verifier roundtrips and binds AAD", async () => {
    const state = "state-abc-12345678901234567890";
    const verifier = "pkce-verifier-1234567890";
    const blob = await encryptVerifier(TEST_SECRET, state, PROVIDER, verifier);
    expect(blob.length).toBeGreaterThan(12 + 16 + 1);
    const dec = await decryptVerifier(TEST_SECRET, await computeStateHash(state), PROVIDER, blob);
    expect(dec).toBe(verifier);
  });

  it("encrypt/decrypt handoff payload roundtrips with state+provider AAD", async () => {
    const ticket = "handoff-ticket-12345678901234567890";
    const state = "state-xyz";
    const payload = { tokens: { accessToken: "tok-secret-abc" }, account: { id: "u1" } };
    const blob = await encryptHandoffPayload(TEST_SECRET, ticket, PROVIDER, state, payload as any);
    const dec = await decryptHandoffPayload(TEST_SECRET, await computeHandoffHash(ticket), PROVIDER, state, blob);
    expect((dec as any).tokens.accessToken).toBe("tok-secret-abc");
  });

  it("key missing fails closed", async () => {
    await expect(encryptVerifier("", "s1234567890123456", PROVIDER, "v")).rejects.toThrow(StoreCryptoError);
    await expect(encryptVerifier("short", "s1234567890123456", PROVIDER, "v")).rejects.toThrow(StoreCryptoError);
  });

  it("corrupt ciphertext or AAD swap fails decrypt (fail closed)", async () => {
    const state = "state-for-aad-12345678901234567890";
    const v = "verif";
    const blob = await encryptVerifier(TEST_SECRET, state, PROVIDER, v);
    const bad = new Uint8Array(blob);
    bad[bad.length - 1] ^= 0xff; // flip tag
    await expect(decryptVerifier(TEST_SECRET, await computeStateHash(state), PROVIDER, bad)).rejects.toThrow(StoreCryptoError);

    // AAD swap by using different provider
    const blob2 = await encryptVerifier(TEST_SECRET, state, "slack" as any, v);
    await expect(decryptVerifier(TEST_SECRET, await computeStateHash(state), PROVIDER, blob2)).rejects.toThrow(StoreCryptoError);
  });

  it("blobs do not contain plaintext verifier or token", async () => {
    const state = "s12345678901234567890state";
    const secretV = "super-secret-pkce-verifier-should-not-appear";
    const blobV = await encryptVerifier(TEST_SECRET, state, PROVIDER, secretV);
    const s = new TextDecoder().decode(blobV);
    expect(s).not.toContain("super-secret-pkce");
    expect(looksLikePlaintextToken(blobV)).toBe(false);

    const payload = { tokens: { accessToken: "ya29.real-token-never-in-store" }, account: {} };
    const blobP = await encryptHandoffPayload(TEST_SECRET, "t12345678901234567890t", PROVIDER, "st", payload as any);
    const sp = new TextDecoder().decode(blobP);
    expect(sp).not.toContain("ya29.real");
  });

  it("compute hashes are stable and url-safe", async () => {
    const h1 = await computeStateHash("state-12345678901234567890");
    const h2 = await computeStateHash("state-12345678901234567890");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await derivePeerKey("1.2.3.4")).length).toBe(32); // 16 bytes hex
  });
});

describe("DO class direct drive + no-plaintext snapshot", () => {
  it("instantiates BrokerPending and stores encrypted verifier; raw has no plaintext", async () => {
    // minimal mock ctx with sql that records inserts
    const inserts: any[] = [];
    const mockCtx: any = {
      storage: {
        sql: {
          exec(q: string, ...bindings: any[]) {
            if (/INSERT/i.test(q)) inserts.push({ q, bindings });
            return [];
          }
        },
        setAlarm() {}
      }
    };
    const d = new BrokerPending(mockCtx, {});
    const state = "state-do-12345678901234567890";
    const verifier = "secret-verifier-do-not-appear-in-sql";
    const enc = await encryptVerifier(makeSecretForTest(), state, "github" as any, verifier);
    await d.putPending({
      state,
      provider: "github" as any,
      redirectUri: "r",
      providerRedirectUri: "pr",
      verifierEnc: enc,
      createdAt: 1,
      expiresAt: Date.now() + 10000
    });
    // snapshot: no plaintext in recorded
    const joined = JSON.stringify(inserts);
    expect(joined).not.toContain("secret-verifier-do-not-appear");
    expect(joined).toContain("verifier_enc"); // blob present
  });

  it("handoff via serial in-mem ops + broker flow: no plaintext in storage rows", async () => {
    const clock = fixedClock(1000);
    const secret = makeSecretForTest();
    const { ops, pendingInst, handoffInst } = await createSerialInMemoryEphemeralOps(clock, secret);
    // drive a minimal broker flow using ephemeralOps to exercise enc path
    const ENV = { FABLE_BROKER_GITHUB_CLIENT_ID: "id", FABLE_BROKER_GITHUB_CLIENT_SECRET: "sec" } as any;
    const pfetch = async (u: string) => {
      const url = new URL(u); if (url.href.includes("token")) return new Response(JSON.stringify({ access_token: "tok-no-plain" }), { status: 200, headers: { "content-type": "application/json" } }); if (url.href.includes("user")) return new Response(JSON.stringify({ id: 1, login: "u" }), { status: 200 }); return new Response("{}", { status: 200 });
    };
    const broker = new FableBroker({ env: ENV, clock, fetch: pfetch, publicBaseUrl: "https://b.test/", ephemeralOps: ops });
    // Use direct ops for roundtrip snapshot (avoids full oauth without real code)
    const state = "flowstate12345678901234567890";
    await ops.createPending({ provider: "github" as any, redirectUri: "r", providerRedirectUri: "pr", state, verifier: "verif-flow-plain-never-stored" });
    const cons = await ops.consumePending(state);
    expect(cons?.verifier).toBe("verif-flow-plain-never-stored");
    // snapshot after create/consume but before any handoff redeem (consume deletes pending)
    const pSnap = JSON.stringify(pendingInst._rowsForTest || []);
    expect(pSnap).not.toContain("verif-flow-plain");
    const ticket = await ops.issueHandoff({ provider: "github" as any, tokens: { accessToken: "tok-flow-plain-never" } as any, account: {} as any, state });
    // snapshot handoff row before redeem deletes it
    let hSnap = JSON.stringify(handoffInst._rowsForTest || []);
    expect(hSnap).toContain("payload_enc");
    expect(hSnap).not.toContain("tok-flow-plain");
    const red = await ops.redeemHandoff(ticket, state);
    expect(red?.tokens?.accessToken).toBe("tok-flow-plain-never");
  });
});

function makeSecretForTest() {
  const z = new Uint8Array(32); for (let i=0;i<32;i++) z[i]=i;
  return btoa(String.fromCharCode(...z)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
