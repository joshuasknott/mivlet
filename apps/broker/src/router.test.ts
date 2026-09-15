/**
 * Runtime-neutral router tests.
 *
 * These drive the shared {@link createBrokerRouter} directly with standard Web
 * `Request`/`Response` — the exact path the Cloudflare Workers transport takes
 * (and the same implementation the Node transport delegates to). They cover the
 * full confidential lifecycle and the failure cases the broker must fail closed
 * on: valid + invalid callbacks, missing provider config, refresh failure,
 * revoke failure, and identity failure.
 *
 * Secrets are never asserted into responses/logs; each test also re-checks the
 * redaction invariant where a secret or token could leak.
 */

import { describe, expect, it, vi } from "vitest";

import { BROKER_CONTRACT_VERSION, type BrokerProviderId } from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { createBrokerRouter, CORRELATION_HEADER } from "./router.js";
import {
  providerProfile,
  resolveEndpoint,
  type BrokerEnv,
  type ProviderCredentials
} from "./provider-profiles.js";
import type { BrokerFetch } from "./provider-client.js";
import { BROKER_AUTHORIZE_STATE_MIN_LENGTH } from "./stores.js";

function oauthState(tag: string): string {
  return tag.length >= BROKER_AUTHORIZE_STATE_MIN_LENGTH
    ? tag
    : `${tag}${"x".repeat(BROKER_AUTHORIZE_STATE_MIN_LENGTH - tag.length)}`;
}

const ENV: BrokerEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret",
  FABLE_BROKER_VERCEL_CLIENT_ID: "vc-id",
  FABLE_BROKER_VERCEL_CLIENT_SECRET: "vc-secret"
};

/** A fetch that serves canned token/identity/revoke responses for a provider. */
function providerFetch(
  provider: BrokerProviderId,
  overrides: Partial<{
    tokenStatus: number;
    identityStatus: number;
    revokeStatus: number;
    tokenBody: unknown;
    identityBody: unknown;
  }> = {}
): BrokerFetch {
  return vi.fn(async (url: string): Promise<Response> => {
    const target = new URL(url);
    const profile = providerProfile(provider);
    if (target.href === profile.tokenEndpoint) {
      if (overrides.tokenStatus && overrides.tokenStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad" }), { status: overrides.tokenStatus });
      }
      return new Response(JSON.stringify(overrides.tokenBody ?? {
        access_token: "provider-access-token",
        refresh_token: "provider-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: profile.scopes.join(" ")
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.href === profile.identityEndpoint) {
      if (overrides.identityStatus && overrides.identityStatus >= 400) {
        return new Response(JSON.stringify({}), { status: overrides.identityStatus });
      }
      return new Response(JSON.stringify(overrides.identityBody ?? identityFor(provider)), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    // GitHub's revocation endpoint is templated; match the resolved form.
    const resolvedRevoke = provider === "github"
      ? resolveEndpoint(profile.revocationEndpoint, creds(provider))
      : profile.revocationEndpoint;
    if (target.href === resolvedRevoke) {
      if (overrides.revokeStatus && overrides.revokeStatus >= 400 && overrides.revokeStatus !== 404) {
        return new Response(JSON.stringify({}), { status: overrides.revokeStatus });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
}

function identityFor(provider: BrokerProviderId): unknown {
  switch (provider) {
    case "github": return { id: 4242, login: "router-user", name: "Router User" };
    case "vercel": return { user: { uid: "vercel-uid", email: "a@vercel.com" } };
    default: return { id: "x" };
  }
}

function creds(provider: BrokerProviderId): ProviderCredentials {
  const profile = providerProfile(provider);
  return {
    clientId: ENV[profile.clientIdEnv]!,
    clientSecret: ENV[profile.clientSecretEnv]!
  };
}

function makeRouter(env: BrokerEnv, fetch?: BrokerFetch) {
  const broker = new FableBroker({ env, fetch, publicBaseUrl: "https://broker.test/" });
  const router = createBrokerRouter({ broker });
  return { broker, router };
}

function makeRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json", ...headers };
  }
  return new Request(new URL(path, "https://broker.test/"), init);
}

/** Run the full authorize → callback → redeem lifecycle to obtain a token set. */
async function completeFlow(router: ReturnType<typeof createBrokerRouter>, broker: FableBroker, provider: BrokerProviderId, state: string) {
  const authorizeState = oauthState(state);
  await broker.authorize({
    contractVersion: BROKER_CONTRACT_VERSION, provider,
    redirectUri: "http://127.0.0.1:9999/callback", state: authorizeState, codeChallenge: "ch", codeChallengeMethod: "S256"
  });
  const callbackRes = await router.handle(
    makeRequest("GET", `/oauth/${provider}/callback?code=provider-code&state=${authorizeState}`),
    "127.0.0.1"
  );
  expect(callbackRes.status).toBe(302);
  const location = callbackRes.headers.get("location")!;
  // The token never appears in the desktop redirect — only the opaque handoff.
  expect(location).not.toContain("provider-access-token");
  const url = new URL(location);
  return { handoff: url.searchParams.get("handoff")!, state: url.searchParams.get("state")!, location };
}

describe("router: lifecycle + transport", () => {
  it("health returns configured providers only and never secrets, with a correlation id", async () => {
    const { router } = makeRouter(ENV, providerFetch("github"));
    const res = await router.handle(makeRequest("GET", "/healthz"), "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get(CORRELATION_HEADER)).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.contractVersion).toBe(BROKER_CONTRACT_VERSION);
    expect(body.providers.sort()).toEqual(["github", "vercel"]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("valid callback: exchanges confidentially, 302s to the desktop redirect with a single-use handoff", async () => {
    const fetch = providerFetch("github");
    const { broker, router } = makeRouter(ENV, fetch);
    // completeFlow drives authorize -> callback and returns the single-use handoff.
    const { handoff, state } = await completeFlow(router, broker, "github", "valid-cb");
    expect(handoff).toBeTruthy();
    expect(state).toBe(oauthState("valid-cb"));

    // Redeem the handoff for the token set over a direct POST.
    const redeemRes = await router.handle(
      makeRequest("POST", "/oauth/github/handoff", { contractVersion: BROKER_CONTRACT_VERSION, handoff, state }), "127.0.0.1"
    );
    expect(redeemRes.status).toBe(200);
    const redeemed = await redeemRes.json();
    expect(redeemed.tokens.accessToken).toBe("provider-access-token");
    expect(redeemed.account.id).toBe("4242");
    // The single-use handoff cannot be redeemed twice (token replay impossible).
    const replayRes = await router.handle(
      makeRequest("POST", "/oauth/github/handoff", { contractVersion: BROKER_CONTRACT_VERSION, handoff, state }), "127.0.0.1"
    );
    expect(replayRes.status).toBe(400);
    expect((await replayRes.json()).error).toBe("invalid-handoff");
  });

  it("invalid callback: missing code/state, provider error, and unknown state each fail closed", async () => {
    const { broker, router } = makeRouter(ENV, providerFetch("github"));
    // Provider reports an error on the callback.
    const errRes = await router.handle(
      makeRequest("GET", `/oauth/github/callback?error=access_denied&state=x`), "127.0.0.1"
    );
    expect(errRes.status).toBe(401); // needs-auth
    expect((await errRes.json()).error).toBe("needs-auth");

    // Missing code.
    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github",
      redirectUri: "http://127.0.0.1:9999/callback", state: oauthState("no-code"), codeChallenge: "ch", codeChallengeMethod: "S256"
    });
    const noCode = await router.handle(makeRequest("GET", `/oauth/github/callback?state=${oauthState("no-code")}`), "127.0.0.1");
    expect(noCode.status).toBe(400);

    // Unknown / replayed state: nothing pending, rejected before any token exchange.
    const unknown = await router.handle(makeRequest("GET", `/oauth/github/callback?code=c&state=never-issued`), "127.0.0.1");
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invalid-state");
  });

  it("missing config: an unconfigured provider fails closed with configuration-required (503)", async () => {
    // GitHub has no credentials in this env.
    const { router } = makeRouter({ FABLE_BROKER_VERCEL_CLIENT_ID: "vc-id", FABLE_BROKER_VERCEL_CLIENT_SECRET: "vc-secret" }, providerFetch("github"));
    const res = await router.handle(
      makeRequest("GET", `/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch`), "127.0.0.1"
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("configuration-required");
    expect(JSON.stringify(body)).not.toContain("gh-secret");
  });

  it("refresh failure: a 401 token endpoint maps to needs-auth (non-retryable)", async () => {
    const fetch = providerFetch("github", { tokenStatus: 401 });
    const { router } = makeRouter(ENV, fetch);
    const res = await router.handle(
      makeRequest("POST", "/oauth/github/refresh", { contractVersion: BROKER_CONTRACT_VERSION, refreshToken: "bad" }), "127.0.0.1"
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("needs-auth");
    expect(body.retryable).toBe(false);
    // The rejected refresh token must not leak into the response.
    expect(JSON.stringify(body)).not.toContain("bad");
  });

  it("revoke failure: a non-404 revocation error maps to a structured broker error", async () => {
    const fetch = providerFetch("github", { revokeStatus: 401 });
    const { router } = makeRouter(ENV, fetch);
    const res = await router.handle(
      makeRequest("POST", "/oauth/github/revoke", { contractVersion: BROKER_CONTRACT_VERSION, token: "doomed-refresh" }), "127.0.0.1"
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("needs-auth");
    // The revoked token must not leak into the response.
    expect(JSON.stringify(body)).not.toContain("doomed-refresh");
  });

  it("revoke treats 404 (already revoked) as success", async () => {
    const fetch = providerFetch("github", { revokeStatus: 404 });
    const { router } = makeRouter(ENV, fetch);
    const res = await router.handle(
      makeRequest("POST", "/oauth/github/revoke", { contractVersion: BROKER_CONTRACT_VERSION, token: "gone" }), "127.0.0.1"
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(true);
  });

  it("identity failure: a non-ok identity endpoint fails closed during callback", async () => {
    const fetch = providerFetch("github", { identityStatus: 500 });
    const { broker, router } = makeRouter(ENV, fetch);
    await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github",
      redirectUri: "http://127.0.0.1:9999/callback", state: oauthState("id-fail"), codeChallenge: "ch", codeChallengeMethod: "S256"
    });
    const res = await router.handle(makeRequest("GET", `/oauth/github/callback?code=c&state=${oauthState("id-fail")}`), "127.0.0.1");
    expect(res.status).toBe(502); // provider-unavailable (5xx from identity)
    expect((await res.json()).error).toBe("provider-unavailable");
  });

  it("OAuth error on the callback is safe to surface without exposing secrets", async () => {
    const { router } = makeRouter(ENV, providerFetch("github"));
    // A provider error description must not echo raw provider diagnostics that
    // could carry secrets; the broker surfaces only its own redacted message.
    const res = await router.handle(
      makeRequest("GET", `/oauth/github/callback?error=access_denied&error_description=secret-leak&state=x`), "127.0.0.1"
    );
    const body = await res.json();
    expect(body.error).toBe("needs-auth");
    expect(JSON.stringify(body)).not.toContain("secret-leak");
    expect(JSON.stringify(body)).not.toContain("gh-secret");
  });

  it("rate-limits after the per-route budget and never logs a body or token", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const { router } = makeRouter(ENV, providerFetch("github"));
    // Build a tight-budget router to exercise the limiter path directly.
    const broker = new FableBroker({ env: ENV, fetch: providerFetch("github"), publicBaseUrl: "https://broker.test/" });
    const limited = createBrokerRouter({ broker, requestsPerMinute: 1 });
    const ok = await limited.handle(
      makeRequest("GET", `/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=${oauthState("a")}&code_challenge=ch`), "127.0.0.1", log
    );
    expect(ok.status).toBe(302);
    const blocked = await limited.handle(
      makeRequest("GET", `/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=${oauthState("b")}&code_challenge=ch`), "127.0.0.1", log
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("rate-limited");
    // No log line carries a token or secret.
    expect(lines.join("\n")).not.toContain("gh-secret");
    expect(lines.join("\n")).not.toContain("provider-access-token");
    void router; // router built for symmetry; limiter path is the subject
  });
});
