/**
 * Deterministic interleaving tests for the OAuth refresh / revoke surface against
 * the production durable store contract.
 *
 * Audit background (see docs/adr/2026-07-03-broker-ephemeral-storage.md): the
 * broker never retains long-lived tokens. The token set crosses to the desktop
 * only at handoff redemption, and refresh/revoke are stateless passthroughs to
 * the provider token/revocation endpoints with the desktop-supplied token. The
 * only durable state is the single-use pending exchange and handoff stores plus
 * shared rate windows, all executed through Durable Objects (serialized per
 * instance).
 *
 * These tests therefore pin the two invariants the refresh-vs-revoke race
 * audit is about:
 *   - A late refresh cannot resurrect a revoked connection: the provider is the
 *     revocation authority, the broker holds no token state, and a refresh with
 *     a revoked token fails closed with `needs-auth` and no tokens.
 *   - An older refresh result cannot replace newer valid state: every refresh
 *     result is returned once, exactly as the provider produced it; the broker
 *     writes nothing to durable storage and never dedupes or reorders calls.
 *
 * Interleavings are driven deterministically with the injected BrokerClock and
 * the SerialDurableStub (which emulates Durable Object single-threaded
 * execution) against the REAL BrokerPending/BrokerHandoff DO classes and the
 * real encrypted RPC path (createSerialInMemoryEphemeralOps). No live provider
 * endpoints are called; fetch is injected. Canary values must never appear in
 * responses, logs, errors, or durable rows.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BROKER_CONTRACT_VERSION,
  BROKER_HANDOFF_TTL_SECONDS,
  type BrokerProviderId
} from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { fixedClock, type BrokerClock } from "./clock.js";
import { createSerialInMemoryEphemeralOps } from "./ephemeral-rpc.js";
import { createBrokerRouter } from "./router.js";
import { createRateLimiter } from "./rate-limiter.js";
import { providerProfile, type BrokerEnv } from "./provider-profiles.js";
import type { BrokerFetch } from "./provider-client.js";

const ENV: BrokerEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret",
  FABLE_BROKER_LINEAR_CLIENT_ID: "ln-id",
  FABLE_BROKER_LINEAR_CLIENT_SECRET: "ln-secret"
};

/** 32 zero bytes base64url — test-only encryption key (never a real secret). */
function testStoreKey(): string {
  const z = new Uint8Array(32);
  return btoa(String.fromCharCode(...z)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const STATE = "race-state-1234567890";
const REDIRECT = "http://127.0.0.1:43123/callback";

/** Durable-path broker: real DO classes + encrypted RPC + serial stub. */
async function makeDurableBroker(
  provider: BrokerProviderId,
  fetch: BrokerFetch,
  clock: BrokerClock
): Promise<{ broker: FableBroker; pendingInst: any; handoffInst: any; secret: string }> {
  const secret = testStoreKey();
  const { ops, pendingInst, handoffInst } = await createSerialInMemoryEphemeralOps(clock, secret);
  const broker = new FableBroker({
    env: ENV,
    clock,
    fetch,
    publicBaseUrl: "https://broker.test/",
    ephemeralOps: ops
  });
  return { broker, pendingInst, handoffInst, secret };
}

/** Canned GitHub token/identity/revoke responses for the single-use flow tests. */
function githubFetch(overrides: { tokenStatus?: number } = {}): BrokerFetch {
  return vi.fn(async (url: string) => {
    const target = new URL(url);
    const profile = providerProfile("github");
    if (target.href === profile.tokenEndpoint) {
      if (overrides.tokenStatus && overrides.tokenStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad" }), { status: overrides.tokenStatus });
      }
      return new Response(
        JSON.stringify({
          access_token: "canary-github-access",
          refresh_token: "canary-github-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: profile.scopes.join(" ")
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.href === profile.identityEndpoint) {
      return new Response(JSON.stringify({ id: 4242, login: "interleave-user" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
}

/**
 * Stateful Linear provider harness for refresh/revoke interleavings. Linear is
 * the refresh-capable confidential profile (supportsRefresh, form revocation).
 * The provider is the revocation authority: once revoked, any refresh with the
 * revoked token is rejected with 401 (invalid_grant), which the broker maps to
 * needs-auth.
 */
function linearRefreshRevokeProvider(overrides: {
  initialRevoked?: boolean;
  rotateRefreshToken?: boolean;
  rejectRefresh?: boolean;
} = {}) {
  const rotate = overrides.rotateRefreshToken ?? true;
  const calls: string[] = [];
  let revoked = overrides.initialRevoked ?? false;
  let refreshes = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const target = new URL(url);
    const profile = providerProfile("linear");
    if (target.href === profile.tokenEndpoint) {
      calls.push("refresh");
      refreshes += 1;
      const body = new URLSearchParams(String(init?.body));
      const rt = body.get("refresh_token");
      if (revoked || overrides.rejectRefresh || rt !== "canary-refresh-old-rt-1") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          access_token: `canary-access-rotated-${refreshes}`,
          ...(rotate ? { refresh_token: `canary-refresh-rotated-${refreshes}` } : {}),
          token_type: "Bearer",
          expires_in: 3600,
          scope: profile.scopes.join(",")
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.href === profile.revocationEndpoint) {
      calls.push("revoke");
      revoked = true;
      // The second concurrent revoke is a 404 (already revoked) — still success.
      return new Response(JSON.stringify({}), { status: calls.filter((c) => c === "revoke").length === 1 ? 200 : 404 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
  return { fetch, calls, markRevoked: () => { revoked = true; } };
}

function refreshRequest(provider: BrokerProviderId, refreshToken: string) {
  return { contractVersion: BROKER_CONTRACT_VERSION, provider, refreshToken };
}

function revokeRequest(provider: BrokerProviderId, token: string, tokenTypeHint: "access_token" | "refresh_token") {
  return { contractVersion: BROKER_CONTRACT_VERSION, provider, token, tokenTypeHint };
}

describe("production durable contract: single-use under deterministic interleaving", () => {
  it("concurrent callbacks: exactly one consumes the pending exchange", async () => {
    const clock = fixedClock(1_000_000);
    const fetch = githubFetch();
    const { broker, pendingInst, handoffInst } = await makeDurableBroker("github", fetch, clock);

    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: "desktop-challenge",
      codeChallengeMethod: "S256"
    });

    const attempts = Array.from({ length: 8 }, () =>
      broker.callback("github", new URLSearchParams({ code: "c", state: STATE }))
    );
    const settled = await Promise.allSettled(attempts);
    const winners = settled.filter((r) => r.status === "fulfilled");
    expect(winners.length).toBe(1);
    const winner = winners[0] as PromiseFulfilledResult<{ redirect: URL }>;
    expect(winner.value.redirect.searchParams.get("state")).toBe(STATE);
    expect(winner.value.redirect.searchParams.get("handoff")).toBeTruthy();
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(7);

    // Exactly one token exchange reached the provider.
    const tokenCalls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .filter(([url]) => new URL(url).href === providerProfile("github").tokenEndpoint);
    expect(tokenCalls.length).toBe(1);

    // The winner's handoff is the only durable row and holds no plaintext.
    const hRows = (handoffInst as any)._rowsForTest ?? [];
    expect(hRows.length).toBe(1);
    const hSnap = JSON.stringify(hRows);
    expect(hSnap).toContain("payload_enc");
    expect(hSnap).not.toContain("canary-github-access");
    expect(hSnap).not.toContain("gh-secret");
    expect((pendingInst as any)._rowsForTest ?? []).toHaveLength(0);
  });

  it("concurrent redemptions: exactly one wins the single-use handoff", async () => {
    const clock = fixedClock(2_000_000);
    const { broker, handoffInst } = await makeDurableBroker("github", githubFetch(), clock);

    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: "desktop-challenge",
      codeChallengeMethod: "S256"
    });
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: STATE }));
    const handoff = redirect.searchParams.get("handoff")!;

    const attempts = Array.from({ length: 8 }, () =>
      broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: STATE })
    );
    const settled = await Promise.allSettled(attempts);
    const winners = settled.filter((r) => r.status === "fulfilled");
    expect(winners.length).toBe(1);
    const tokens = (winners[0] as PromiseFulfilledResult<{ tokens: { accessToken: string } }>).value.tokens;
    expect(tokens.accessToken).toBe("canary-github-access");
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(7);
    expect((handoffInst as any)._rowsForTest ?? []).toHaveLength(0);
  });

  it("expired pending rejects under concurrent access and is not resurrected", async () => {
    const clock = fixedClock(3_000_000);
    const { broker, pendingInst } = await makeDurableBroker("github", githubFetch(), clock);
    const ttlMs = BROKER_HANDOFF_TTL_SECONDS * 1000;

    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: "desktop-challenge",
      codeChallengeMethod: "S256"
    });
    (clock as any).advance(ttlMs + 1000);

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        broker.callback("github", new URLSearchParams({ code: "c", state: STATE }))
      )
    );
    for (const r of settled) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toMatchObject({ error: "invalid-state" });
    }
    expect((pendingInst as any)._rowsForTest ?? []).toHaveLength(0);
  });

  it("expired handoff burns: a late redeem after expiry is rejected", async () => {
    const clock = fixedClock(4_000_000);
    const { broker, handoffInst } = await makeDurableBroker("github", githubFetch(), clock);
    const ttlMs = BROKER_HANDOFF_TTL_SECONDS * 1000;

    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: "desktop-challenge",
      codeChallengeMethod: "S256"
    });
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: STATE }));
    const handoff = redirect.searchParams.get("handoff")!;

    (clock as any).advance(ttlMs + 1000);
    await expect(
      broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: STATE })
    ).rejects.toMatchObject({ error: "invalid-handoff" });
    await expect(
      broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: STATE })
    ).rejects.toMatchObject({ error: "invalid-handoff" });
    expect((handoffInst as any)._rowsForTest ?? []).toHaveLength(0);
  });
});

describe("refresh + revoke interleavings are stateless passthroughs (provider is the authority)", () => {
  it("duplicate concurrent refreshes are independent passthroughs with no broker-side clobber", async () => {
    const clock = fixedClock(5_000_000);
    const provider = linearRefreshRevokeProvider();
    const { broker, pendingInst, handoffInst } = await makeDurableBroker("linear", provider.fetch, clock);

    const [a, b] = await Promise.all([
      broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1")),
      broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1"))
    ]);

    // Each caller gets exactly the provider's own rotated result; the broker
    // does not dedupe, reorder, or hold state between the two.
    expect(a.tokens.accessToken).toBe("canary-access-rotated-1");
    expect(b.tokens.accessToken).toBe("canary-access-rotated-2");
    expect(a.tokens.refreshToken).toBe("canary-refresh-rotated-1");
    expect(b.tokens.refreshToken).toBe("canary-refresh-rotated-2");
    expect(provider.calls.filter((c) => c === "refresh")).toHaveLength(2);

    // Both provider requests carried the desktop-supplied token unchanged.
    const bodies = (provider.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .map(([, init]) => String(init?.body ?? ""));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("canary-refresh-old-rt-1");
    }

    // Refresh writes nothing durable: no rows, nothing to resurrect or clobber.
    expect((pendingInst as any)._rowsForTest ?? []).toHaveLength(0);
    expect((handoffInst as any)._rowsForTest ?? []).toHaveLength(0);
  });

  it("rotation is preserved when the provider rotates the refresh token", async () => {
    const clock = fixedClock(6_000_000);
    const provider = linearRefreshRevokeProvider({ rotateRefreshToken: true });
    const { broker } = await makeDurableBroker("linear", provider.fetch, clock);

    const result = await broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1"));
    expect(result.tokens.refreshToken).toBe("canary-refresh-rotated-1");
    expect(provider.calls).toEqual(["refresh"]);
  });

  it("a provider that does not rotate keeps the prior refresh token (no universal guarantee claimed)", async () => {
    const clock = fixedClock(7_000_000);
    const provider = linearRefreshRevokeProvider({ rotateRefreshToken: false });
    const { broker } = await makeDurableBroker("linear", provider.fetch, clock);

    const result = await broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1"));
    // The broker echoes the desktop's token only because THIS provider omitted a
    // rotated one — provider-specific behavior, never a universal claim.
    expect(result.tokens.refreshToken).toBe("canary-refresh-old-rt-1");
  });

  it("revoke winning: a refresh with a revoked token fails closed with needs-auth and no tokens", async () => {
    const clock = fixedClock(8_000_000);
    const provider = linearRefreshRevokeProvider();
    const { broker, pendingInst, handoffInst } = await makeDurableBroker("linear", provider.fetch, clock);

    const revoke = await broker.revoke(revokeRequest("linear", "canary-refresh-old-rt-1", "refresh_token"));
    expect(revoke.revoked).toBe(true);

    await expect(broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1")))
      .rejects.toMatchObject({ error: "needs-auth", retryable: false });

    // The broker wrote no durable state, so a late refresh cannot resurrect the
    // revoked connection — the provider is the only revocation authority.
    expect((pendingInst as any)._rowsForTest ?? []).toHaveLength(0);
    expect((handoffInst as any)._rowsForTest ?? []).toHaveLength(0);
    expect(provider.calls).toEqual(["revoke", "refresh"]);
  });

  it("refresh racing revoke: the broker returns each provider result once, in order, without resurrecting", async () => {
    const clock = fixedClock(9_000_000);
    const provider = linearRefreshRevokeProvider();
    const { broker, pendingInst, handoffInst } = await makeDurableBroker("linear", provider.fetch, clock);

    // Interleaving 1: the refresh lands before the revoke and succeeds with the
    // provider's rotated result.
    const before = await broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1"));
    expect(before.tokens.accessToken).toBe("canary-access-rotated-1");

    // Interleaving 2: the revoke lands; the provider revokes the token.
    const revoke = await broker.revoke(revokeRequest("linear", "canary-refresh-old-rt-1", "refresh_token"));
    expect(revoke.revoked).toBe(true);

    // Interleaving 3: any later refresh with the revoked token is rejected by
    // the provider and the broker fails closed — the revoked connection is not
    // resurrected by the earlier (older) refresh result.
    await expect(broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1")))
      .rejects.toMatchObject({ error: "needs-auth" });

    expect(provider.calls).toEqual(["refresh", "revoke", "refresh"]);
    expect((pendingInst as any)._rowsForTest ?? []).toHaveLength(0);
    expect((handoffInst as any)._rowsForTest ?? []).toHaveLength(0);
  });

  it("duplicate concurrent revokes are idempotent: an already-revoked token still returns revoked=true", async () => {
    const clock = fixedClock(10_000_000);
    const provider = linearRefreshRevokeProvider();
    const { broker } = await makeDurableBroker("linear", provider.fetch, clock);

    const [first, second] = await Promise.all([
      broker.revoke(revokeRequest("linear", "canary-refresh-old-rt-1", "refresh_token")),
      broker.revoke(revokeRequest("linear", "canary-refresh-old-rt-1", "refresh_token"))
    ]);
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(true);
    expect(provider.calls.filter((c) => c === "revoke")).toHaveLength(2);
  });
});

describe("secret canaries never enter responses, logs, or errors on refresh/revoke", () => {
  it("refresh rejection and revoke success bodies and router logs never contain token or secret canaries", async () => {
    const clock = fixedClock(11_000_000);
    const provider = linearRefreshRevokeProvider({ initialRevoked: true });
    const { broker } = await makeDurableBroker("linear", provider.fetch, clock);
    const logLines: string[] = [];
    const router = createBrokerRouter({
      broker,
      rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000, clock })
    });

    const refreshRes = await router.handle(
      new Request("https://broker.test/oauth/linear/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(refreshRequest("linear", "canary-refresh-old-rt-1"))
      }),
      "127.0.0.1",
      (line) => logLines.push(line)
    );
    expect(refreshRes.status).toBe(401);
    const refreshBody = JSON.stringify(await refreshRes.json());
    expect(refreshBody).not.toContain("canary-refresh-old-rt-1");
    expect(refreshBody).not.toContain("canary-access-rotated");
    expect(refreshBody).not.toContain("ln-secret");

    const revokeRes = await router.handle(
      new Request("https://broker.test/oauth/linear/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(revokeRequest("linear", "canary-refresh-old-rt-1", "refresh_token"))
      }),
      "127.0.0.1",
      (line) => logLines.push(line)
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = JSON.stringify(await revokeRes.json());
    expect(revokeBody).not.toContain("canary-refresh-old-rt-1");
    expect(revokeBody).not.toContain("ln-secret");

    const joinedLogs = logLines.join("\n");
    expect(joinedLogs).not.toContain("canary-refresh-old-rt-1");
    expect(joinedLogs).not.toContain("canary-access-rotated");
    expect(joinedLogs).not.toContain("ln-secret");
  });

  it("a successful refresh response contains only the provider's rotated tokens, never the client secret", async () => {
    const clock = fixedClock(12_000_000);
    const provider = linearRefreshRevokeProvider();
    const { broker } = await makeDurableBroker("linear", provider.fetch, clock);

    const result = await broker.refresh(refreshRequest("linear", "canary-refresh-old-rt-1"));
    const body = JSON.stringify(result);
    expect(body).toContain("canary-access-rotated-1");
    expect(body).not.toContain("ln-secret");
    expect(body).not.toContain("ln-id");
  });
});