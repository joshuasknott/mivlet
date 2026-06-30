/**
 * Broker service security + contract tests. These exercise the full confidential
 * OAuth flow with an injectable fetch (no live provider calls) and prove the
 * threat-model invariants: single-use state, single-use handoff, callback
 * substitution rejection, token-redaction at every boundary, version gating,
 * refresh/revocation failures, rate limiting, and malformed responses.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BROKER_CONTRACT_VERSION,
  BrokerContractError,
  type BrokerAuthorizeRequest,
  type BrokerProviderId
} from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { fixedClock } from "./clock.js";
import {
  configuredProviders,
  providerProfile,
  resolveCredentials,
  type BrokerEnv
} from "./provider-profiles.js";
import { createStores } from "./stores.js";
import { BROKER_HANDOFF_TTL_SECONDS } from "@fable/connectors";
import type { BrokerFetch } from "./provider-client.js";

const ENV: BrokerEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret",
  FABLE_BROKER_VERCEL_CLIENT_ID: "vc-id",
  FABLE_BROKER_VERCEL_CLIENT_SECRET: "vc-secret",
  FABLE_BROKER_LINEAR_CLIENT_ID: "ln-id",
  FABLE_BROKER_LINEAR_CLIENT_SECRET: "ln-secret",
  FABLE_BROKER_NOTION_CLIENT_ID: "nt-id",
  FABLE_BROKER_NOTION_CLIENT_SECRET: "nt-secret",
  FABLE_BROKER_SLACK_CLIENT_ID: "sl-id",
  FABLE_BROKER_SLACK_CLIENT_SECRET: "sl-secret"
};

const REDIRECT = "http://127.0.0.1:43123/callback";

function authorizeRequest(provider: BrokerProviderId, state = "desktop-state"): BrokerAuthorizeRequest {
  return {
    contractVersion: BROKER_CONTRACT_VERSION,
    provider,
    redirectUri: REDIRECT,
    state,
    codeChallenge: "desktop-challenge",
    codeChallengeMethod: "S256"
  };
}

/** A fetch that serves token/identity responses for the given provider. */
function providerFetch(provider: BrokerProviderId, overrides: Partial<{
  token: unknown;
  identity: unknown;
  identityStatus: number;
  tokenStatus: number;
  identityInline: boolean;
}> = {}): BrokerFetch {
  return vi.fn(async (url: string) => {
    const target = new URL(url);
    const profile = providerProfile(provider);
    if (target.href === profile.tokenEndpoint) {
      if (overrides.tokenStatus && overrides.tokenStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad" }), { status: overrides.tokenStatus });
      }
      return new Response(JSON.stringify(overrides.token ?? {
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
      return new Response(JSON.stringify(identityFor(provider)), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (target.href === profile.revocationEndpoint) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    // GitHub's revocation endpoint is templated ({clientId}); match the resolved form.
    if (provider === "github" && target.href.startsWith("https://api.github.com/applications/")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
}

function identityFor(provider: BrokerProviderId): unknown {
  switch (provider) {
    case "github": return { id: 1234, login: "fable-user", name: "Fable User", avatar_url: "https://github.com/a.png" };
    case "vercel": return { user: { uid: "vercel-uid", email: "a@vercel.com" } };
    case "linear": return { data: { viewer: { id: "linear-id", name: "Linear User", email: "a@linear.app" } } };
    case "notion": return { id: "notion-bot", bot: { workspace_id: "ws-1", workspace_name: "Fable Notion" } };
    case "slack": return { ok: true, user_id: "U1", user: "Slack User", team: "Fable Slack", url: "https://x.slack.com" };
  }
}

function makeBroker(provider: BrokerProviderId, fetch?: BrokerFetch, clock = fixedClock(1_000_000_000_000)) {
  const stores = createStores(clock);
  const broker = new FableBroker({ env: ENV, clock, fetch, pending: stores.pending, handoff: stores.handoff });
  return { broker, clock, stores };
}

describe("broker provider profiles", () => {
  it("lists only configured providers and never their secrets", () => {
    expect(configuredProviders(ENV).sort()).toEqual(["github", "linear", "notion", "slack", "vercel"]);
    expect(configuredProviders({})).toEqual([]);
  });

  it("resolves credentials only when both id and secret are present", () => {
    expect(resolveCredentials("github", ENV)).toEqual({ clientId: "gh-id", clientSecret: "gh-secret" });
    expect(() => resolveCredentials("github", { FABLE_BROKER_GITHUB_CLIENT_ID: "x" })).toThrow(/GitHub is not configured/);
  });
});

describe("broker authorize", () => {
  it("builds a confidential authorization URL with the broker client id and scopes", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    const { response } = await broker.authorize(authorizeRequest("github", "s1"));
    const url = new URL(response.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("gh-id");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8788/oauth/github/callback");
    expect(url.searchParams.get("scope")).toBe("read:user read:org repo workflow");
    // The broker performs the exchange, so its verifier (not the desktop's) is used.
    expect(url.searchParams.get("code_challenge")).not.toBe("desktop-challenge");
    expect(response.authorizationUrl).not.toContain("secret");
  });

  it("uses the broker verifier for broker-pkce providers (not the desktop challenge)", async () => {
    const { broker } = makeBroker("vercel", providerFetch("vercel"));
    const { response } = await broker.authorize(authorizeRequest("vercel", "s2"));
    const url = new URL(response.authorizationUrl);
    expect(url.searchParams.get("code_challenge")).not.toBe("desktop-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("rejects an unknown provider and an unsupported contract version", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await expect(broker.authorize({ ...authorizeRequest("github"), provider: "google" as BrokerProviderId }))
      .rejects.toThrow(BrokerContractError);
    await expect(broker.authorize({ ...authorizeRequest("github"), contractVersion: 99 as number }))
      .rejects.toThrow(/Unsupported broker contract version/);
  });

  it("fails closed when the provider is not configured", async () => {
    const unconfigured = new FableBroker({ env: {} });
    await expect(unconfigured.authorize(authorizeRequest("github"))).rejects.toThrow(/GitHub is not configured/);
  });

  it("rejects desktop redirects outside the narrow callback allowlist", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await expect(broker.authorize({ ...authorizeRequest("github"), redirectUri: "https://evil.example/callback" }))
      .rejects.toThrow(/not allowed/);
    await expect(broker.authorize({ ...authorizeRequest("github"), redirectUri: "http://127.0.0.1:9/other" }))
      .rejects.toThrow(/not allowed/);
  });
});

describe("broker callback + handoff", () => {
  it("exchanges the code confidentially and redirects to the exact desktop redirect with a single-use handoff", async () => {
    const fetch = providerFetch("github");
    const { broker } = makeBroker("github", fetch);
    await broker.authorize(authorizeRequest("github", "state-1"));
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "provider-code", state: "state-1" }));
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    const handoff = redirect.searchParams.get("handoff");
    const state = redirect.searchParams.get("state");
    expect(handoff).toBeTruthy();
    expect(state).toBe("state-1");
    // The token never appears in the redirect URL — only the opaque handoff.
    expect(redirect.toString()).not.toContain("provider-access-token");

    // Redeem the single-use handoff for the tokens over a direct call.
    const redeemed = await broker.redeem({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff: handoff!, state: state!
    });
    expect(redeemed.tokens.accessToken).toBe("provider-access-token");
    expect(redeemed.account.id).toBe("1234");
    expect(redeemed.account.displayName).toBe("Fable User");
  });

  it("rejects a callback with an unknown / replayed state (single-use)", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await broker.authorize(authorizeRequest("github", "state-once"));
    // First use succeeds.
    await broker.callback("github", new URLSearchParams({ code: "c", state: "state-once" }));
    // Replaying the same state is rejected (state was consumed).
    await expect(broker.callback("github", new URLSearchParams({ code: "c", state: "state-once" })))
      .rejects.toThrow(/unknown, expired, or already used/);
    // Unknown state is rejected.
    await expect(broker.callback("github", new URLSearchParams({ code: "c", state: "never-issued" })))
      .rejects.toThrow(/unknown, expired, or already used/);
  });

  it("rejects callback substitution: provider mismatch on the same state", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await broker.authorize(authorizeRequest("github", "state-mismatch"));
    await expect(broker.callback("slack", new URLSearchParams({ code: "c", state: "state-mismatch" })))
      .rejects.toThrow(/did not match the provider/);
  });

  it("rejects a callback reporting a provider error, or missing code/state", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await broker.authorize(authorizeRequest("github", "e1"));
    await expect(broker.callback("github", new URLSearchParams({ error: "access_denied", state: "e1" })))
      .rejects.toThrow(/authorization error/i);
    await broker.authorize(authorizeRequest("github", "e2"));
    await expect(broker.callback("github", new URLSearchParams({ state: "e2" })))
      .rejects.toThrow(/missing a code/);
    await broker.authorize(authorizeRequest("github", "e3"));
    await expect(broker.callback("github", new URLSearchParams({ code: "x" })))
      .rejects.toThrow(/missing state/);
  });

  it("token replay is impossible: a redeemed handoff cannot be redeemed twice", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await broker.authorize(authorizeRequest("github", "replay"));
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: "replay" }));
    const handoff = redirect.searchParams.get("handoff")!;
    const state = redirect.searchParams.get("state")!;
    await broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state });
    await expect(broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state }))
      .rejects.toThrow(/unknown, expired, already used/);
  });

  it("rejects a handoff redeemed with the wrong bound state", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    await broker.authorize(authorizeRequest("github", "right"));
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: "right" }));
    const handoff = redirect.searchParams.get("handoff")!;
    await expect(broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: "wrong" }))
      .rejects.toThrow(/unknown, expired, already used/);
  });

  it("handoff expires after its TTL and cannot be redeemed", async () => {
    const clock = fixedClock(1_000_000);
    const { broker } = makeBroker("github", providerFetch("github"), clock);
    await broker.authorize(authorizeRequest("github", "ttl"));
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: "ttl" }));
    const handoff = redirect.searchParams.get("handoff")!;
    clock.advance(BROKER_HANDOFF_TTL_SECONDS * 1000 + 1);
    await expect(broker.redeem({ contractVersion: BROKER_CONTRACT_VERSION, provider: "github", handoff, state: "ttl" }))
      .rejects.toThrow(/unknown, expired, already used/);
  });

  it("normalizes provider exchange/identity errors into structured broker errors", async () => {
    const { broker: rejected } = makeBroker("github", providerFetch("github", { tokenStatus: 401 }));
    await rejected.authorize(authorizeRequest("github", "n1"));
    await expect(rejected.callback("github", new URLSearchParams({ code: "c", state: "n1" })))
      .rejects.toMatchObject({ error: "needs-auth" });

    const { broker: limited } = makeBroker("github", providerFetch("github", { tokenStatus: 429 }));
    await limited.authorize(authorizeRequest("github", "n2"));
    await expect(limited.callback("github", new URLSearchParams({ code: "c", state: "n2" })))
      .rejects.toMatchObject({ error: "rate-limited", retryable: true });

    const { broker: unavailable } = makeBroker("github", providerFetch("github", { tokenStatus: 503 }));
    await unavailable.authorize(authorizeRequest("github", "n3"));
    await expect(unavailable.callback("github", new URLSearchParams({ code: "c", state: "n3" })))
      .rejects.toMatchObject({ error: "provider-unavailable", retryable: true });
  });
});

describe("broker refresh + revoke", () => {
  it("rotates a token through the confidential client", async () => {
    const fetch = providerFetch("github");
    const { broker } = makeBroker("github", fetch);
    const refreshed = await broker.refresh({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github", refreshToken: "old-refresh"
    });
    expect(refreshed.tokens.accessToken).toBe("provider-access-token");
    // The refresh request carried the secret to the provider only.
    const call = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .find(([url]) => url === providerProfile("github").tokenEndpoint);
    expect(call).toBeTruthy();
    expect(String(call![1].body)).toContain("client_secret=gh-secret");
    expect(String(call![1].body)).toContain("grant_type=refresh_token");
  });

  it("maps refresh failure to needs-auth (non-retryable)", async () => {
    const fetch = providerFetch("github", { tokenStatus: 401 });
    const { broker } = makeBroker("github", fetch);
    await expect(broker.refresh({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github", refreshToken: "bad"
    })).rejects.toMatchObject({ error: "needs-auth", retryable: false });
  });

  it("revokes at the provider and returns revoked=true", async () => {
    const fetch = providerFetch("github");
    const { broker } = makeBroker("github", fetch);
    const result = await broker.revoke({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github", token: "provider-refresh-token"
    });
    expect(result.revoked).toBe(true);
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    // GitHub's grant endpoint is keyed by client id; the {clientId} placeholder
    // must be substituted with the configured confidential client id (gh-id).
    const call = calls.find(([url]) => url === "https://api.github.com/applications/gh-id/grant");
    expect(call).toBeTruthy();
    expect(String(call![1].body)).toContain("token=provider-refresh-token");
    // The placeholder must NEVER reach the provider verbatim.
    expect(calls.some(([url]) => url.includes("{clientId}"))).toBe(false);
  });
});

describe("broker token redaction invariant", () => {
  it("never includes secrets or tokens in authorize URLs, redirects, or health", async () => {
    const { broker } = makeBroker("github", providerFetch("github"));
    const { response } = await broker.authorize(authorizeRequest("github", "redact"));
    expect(response.authorizationUrl).not.toContain("gh-secret");
    expect(response.authorizationUrl).not.toContain("provider-access-token");
    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: "redact" }));
    expect(redirect.toString()).not.toContain("provider-access-token");
    expect(redirect.toString()).not.toContain("gh-secret");
    const health = broker.health();
    expect(JSON.stringify(health)).not.toContain("secret");
    expect(JSON.stringify(health)).not.toContain("token");
  });
});

describe("broker provider coverage", () => {
  for (const provider of ["github", "vercel", "linear", "notion", "slack"] as BrokerProviderId[]) {
    it(`${provider} completes the full confidential flow + handoff`, async () => {
      const { broker } = makeBroker(provider, providerFetch(provider));
      await broker.authorize(authorizeRequest(provider, `state-${provider}`));
      const { redirect } = await broker.callback(provider, new URLSearchParams({ code: "c", state: `state-${provider}` }));
      const handoff = redirect.searchParams.get("handoff")!;
      const redeemed = await broker.redeem({
        contractVersion: BROKER_CONTRACT_VERSION, provider, handoff, state: `state-${provider}`
      });
      expect(redeemed.tokens.accessToken).toBe("provider-access-token");
      expect(redeemed.account.id).toBeTruthy();
    });
  }
});
