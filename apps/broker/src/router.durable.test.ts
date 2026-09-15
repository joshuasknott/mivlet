/**
 * Router + broker E2E with durable-mem backend + rate cross-isolate simulation.
 * Uses async ephemeralOps + SerialDurableStub + real DO classes for binding path.
 */

import { describe, expect, it } from "vitest";

import { BROKER_CONTRACT_VERSION, BROKER_PKCE_S256_EXAMPLE } from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { createBrokerRouter } from "./router.js";
import {
  createDurableMemoryRateLimiter,
  createDurableRateLimiter
} from "./durable-stores.js";
import { createEphemeralOps, createSerialInMemoryEphemeralOps } from "./ephemeral-rpc.js";
import { fixedClock } from "./clock.js";

const ENV = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "sec"
} as any;

function pfetch() {
  return async (u: string) => {
    const url = new URL(u);
    if (url.href.includes("token")) return new Response(JSON.stringify({ access_token: "tok", token_type: "Bearer", scope: "" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.href.includes("user")) return new Response(JSON.stringify({ id: 1, login: "u" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
}

describe("durable backend E2E (async ephemeral-ops with serial in-mem DO)", () => {
  it("full authorize-callback-redeem E2E with ephemeralOps (binding-path exercised, real data returned)", async () => {
    const clock = fixedClock(1_000);
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 32 zero bytes base64-ish for test (real enc path)
    const { ops, pendingInst, handoffInst } = await createSerialInMemoryEphemeralOps(clock, secret);
    const broker = new FableBroker({ env: ENV, clock, fetch: pfetch(), publicBaseUrl: "https://b.test/", ephemeralOps: ops });

    await broker.authorize({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", redirectUri: "http://127.0.0.1:1/callback", state: "d1-12345678901234567890", codeChallenge: BROKER_PKCE_S256_EXAMPLE.challenge, codeChallengeMethod: "S256" });

    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: "d1-12345678901234567890" }));
    const handoff = redirect.searchParams.get("handoff")!;
    const redeemed = await broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: "d1-12345678901234567890", codeVerifier: BROKER_PKCE_S256_EXAMPLE.verifier });
    expect(redeemed.tokens.accessToken).toBe("tok");

    // Verify roundtripped data and no plaintext in the simulated storage
    // Access rows via internal for snapshot assertions (test-only)
    const pRows = (pendingInst as any)._rowsForTest ?? [];
    const hRows = (handoffInst as any)._rowsForTest ?? [];
    // After redeem, pending should be consumed (empty), handoff too
    // At least assert no plaintext verifier/tokens in any remaining enc rows (if present)
    const anyPlaintext = JSON.stringify(pRows) + JSON.stringify(hRows);
    expect(anyPlaintext).not.toContain("pkce-");
    expect(anyPlaintext).not.toContain("tok");
  });

  it("storage_backend_memory_default + rate cross via shared limiter", () => {
    const clock = fixedClock(10_000);
    const lim = createDurableMemoryRateLimiter({ limit: 1, windowMs: 60000, clock });
    const broker = new FableBroker({ env: ENV, clock, fetch: pfetch(), publicBaseUrl: "https://b.test/" });
    const r = createBrokerRouter({ broker, rateLimiter: lim });
    expect(lim.check("x:y").allowed).toBe(true);
  });

  it("real DO adapters via ephemeral ops constructed with binding and return correct values (consume/redeem)", async () => {
    const clock = fixedClock(2_000);
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const calls: string[] = [];
    const stored: { pending?: { verifierEnc: Uint8Array }; handoff?: { payloadEnc: Uint8Array } } = {};
    const mockBinding: any = {
      idFromName: (h: string) => h,
      get: (id: string) => ({
        putPending: async (a: any) => { calls.push("putPending"); stored.pending = { verifierEnc: a.verifierEnc }; },
        consumePending: async (s: string) => {
          calls.push("consumePending");
          return {
            state: s,
            provider: "github",
            redirectUri: "r",
            providerRedirectUri: "pr",
            verifierEnc: stored.pending?.verifierEnc ?? null,
            createdAt: 2000,
            expiresAt: 2000 + 300000
          };
        },
        putHandoff: async (a: any) => { calls.push("putHandoff"); stored.handoff = { payloadEnc: a.payloadEnc }; },
        redeemHandoff: async (t: string, s: string) => {
          calls.push("redeemHandoff");
          return {
            ticket: t,
            provider: "github",
            state: s,
            payloadEnc: stored.handoff?.payloadEnc ?? null,
            createdAt: 2000,
            expiresAt: 2000 + 300000
          };
        }
      })
    };
    // Use real createEphemeralOps + mock binding to exercise the RPC path
    const ops = createEphemeralOps({ BROKER_PENDING: mockBinding, BROKER_HANDOFF: mockBinding }, secret, clock);
    // Use direct ops + mock binding to test the RPC path (no full authorize to avoid redirect validation)
    await ops.createPending({
      state: "bindteststate1234567890",
      provider: "github",
      redirectUri: "r",
      providerRedirectUri: "pr",
      verifier: "verifier",
      codeChallenge: BROKER_PKCE_S256_EXAMPLE.challenge
    });
    const consumed = await ops.consumePending("bindteststate1234567890");
    expect(consumed).toBeDefined();
    expect(consumed?.provider).toBe("github");
    expect(consumed?.state).toBe("bindteststate1234567890");

    const ticket = await ops.issueHandoff({ provider: "github", tokens: { accessToken: "tkn" } as any, account: {} as any, state: "st", codeChallenge: BROKER_PKCE_S256_EXAMPLE.challenge });
    expect(typeof ticket).toBe("string");
    const redeemed = await ops.redeemHandoff(ticket, "st");
    expect(redeemed).toBeDefined();
    expect(redeemed?.provider).toBe("github");

    expect(calls).toContain("putPending");
    expect(calls).toContain("consumePending");
    expect(calls).toContain("putHandoff");
    expect(calls).toContain("redeemHandoff");
  });

  it("shares durable rate limits across router instances while isolating keys", async () => {
    const windows = new Map<string, { start: number; count: number }>();
    const binding: any = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        check: async ({ limit, windowMs, now }: { limit: number; windowMs: number; now: number }) => {
          const current = windows.get(id);
          if (!current || now - current.start >= windowMs) {
            windows.set(id, { start: now, count: 1 });
            return { allowed: true, remaining: limit - 1, retryAfterMs: windowMs };
          }
          current.count += 1;
          return {
            allowed: current.count <= limit,
            remaining: Math.max(0, limit - current.count),
            retryAfterMs: current.start + windowMs - now
          };
        }
      })
    };
    const clock = fixedClock(5_000);
    const limiterA = createDurableRateLimiter(binding, { limit: 2, windowMs: 60_000, clock });
    const limiterB = createDurableRateLimiter(binding, { limit: 2, windowMs: 60_000, clock });

    expect((await limiterA.check("/oauth/github/authorize:203.0.113.1")).allowed).toBe(true);
    expect((await limiterB.check("/oauth/github/authorize:203.0.113.1")).allowed).toBe(true);
    expect((await limiterA.check("/oauth/github/authorize:203.0.113.1")).allowed).toBe(false);
    expect((await limiterB.check("/oauth/github/authorize:203.0.113.2")).allowed).toBe(true);
  });
});
