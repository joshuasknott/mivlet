/**
 * Desktop↔broker PKCE contract: authorize stores the desktop S256 challenge,
 * never forwards it to the provider, and redeem requires the matching verifier.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BROKER_CONTRACT_VERSION,
  BROKER_PKCE_CHALLENGE_METHOD,
  BROKER_PKCE_S256_EXAMPLE
} from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { fixedClock } from "./clock.js";
import { s256Challenge } from "./pkce.js";
import { providerProfile, type BrokerEnv } from "./provider-profiles.js";
import { createBrokerRouter } from "./router.js";
import { BROKER_AUTHORIZE_STATE_MIN_LENGTH, createStores } from "./stores.js";
import type { BrokerFetch } from "./provider-client.js";

function oauthState(tag: string): string {
  return tag.length >= BROKER_AUTHORIZE_STATE_MIN_LENGTH
    ? tag
    : `${tag}${"x".repeat(BROKER_AUTHORIZE_STATE_MIN_LENGTH - tag.length)}`;
}

const ENV: BrokerEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret",
  FABLE_BROKER_NOTION_CLIENT_ID: "nt-id",
  FABLE_BROKER_NOTION_CLIENT_SECRET: "nt-secret"
};

const REDIRECT = "http://127.0.0.1:43123/callback";

function githubFetch(): BrokerFetch {
  return vi.fn(async (url: string) => {
    const target = new URL(url);
    const profile = providerProfile("github");
    if (target.href === profile.tokenEndpoint) {
      return new Response(JSON.stringify({
        access_token: "provider-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: profile.scopes.join(" ")
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.href === profile.identityEndpoint) {
      return new Response(JSON.stringify({ id: 1, login: "u", name: "U" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
}

function makeBroker() {
  const clock = fixedClock(1_000_000_000_000);
  const stores = createStores(clock);
  const broker = new FableBroker({
    env: ENV,
    clock,
    fetch: githubFetch(),
    pending: stores.pending,
    handoff: stores.handoff
  });
  return { broker, stores };
}

function authorize(state = "desktop-pkce-state") {
  return {
    contractVersion: BROKER_CONTRACT_VERSION,
    provider: "github" as const,
    redirectUri: REDIRECT,
    state: oauthState(state),
    codeChallenge: BROKER_PKCE_S256_EXAMPLE.challenge,
    codeChallengeMethod: BROKER_PKCE_CHALLENGE_METHOD
  };
}

describe("desktop↔broker PKCE contract", () => {
  it("never forwards the desktop challenge to a broker-pkce provider", async () => {
    const { broker } = makeBroker();
    const { response } = await broker.authorize(authorize("fwd"));
    const url = new URL(response.authorizationUrl);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).not.toBe(BROKER_PKCE_S256_EXAMPLE.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits provider PKCE for pkce:none while still requiring the desktop challenge", async () => {
    const clock = fixedClock(2_000_000_000_000);
    const broker = new FableBroker({
      env: ENV,
      clock,
      fetch: vi.fn(async () => new Response("{}", { status: 404 })) as BrokerFetch
    });
    const { response } = await broker.authorize({
      ...authorize("notion-pkce"),
      provider: "notion"
    });
    const url = new URL(response.authorizationUrl);
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("rejects missing, plain, and malformed desktop challenges", async () => {
    const { broker } = makeBroker();
    await expect(broker.authorize({
      ...authorize("plain"),
      codeChallengeMethod: "plain" as typeof BROKER_PKCE_CHALLENGE_METHOD
    })).rejects.toMatchObject({ error: "invalid-request" });
    await expect(broker.authorize({
      ...authorize("short"),
      codeChallenge: "ch"
    })).rejects.toMatchObject({ error: "invalid-request" });
  });

  it("redeems only when the desktop verifier matches the stored challenge", async () => {
    const { broker } = makeBroker();
    await broker.authorize(authorize("ok"));
    const { redirect } = await broker.callback("github", new URLSearchParams({
      code: "c",
      state: oauthState("ok")
    }));
    const handoff = redirect.searchParams.get("handoff")!;
    const state = redirect.searchParams.get("state")!;

    await expect(broker.redeem({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      handoff,
      state,
      codeVerifier: "a".repeat(43)
    })).rejects.toMatchObject({ error: "invalid-handoff" });

    await broker.authorize(authorize("ok2"));
    const second = await broker.callback("github", new URLSearchParams({
      code: "c",
      state: oauthState("ok2")
    }));
    const redeemed = await broker.redeem({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      handoff: second.redirect.searchParams.get("handoff")!,
      state: oauthState("ok2"),
      codeVerifier: BROKER_PKCE_S256_EXAMPLE.verifier
    });
    expect(redeemed.tokens.accessToken).toBe("provider-access-token");
  });

  it("router rejects duplicate PKCE parameters, missing method, and plain", async () => {
    const { broker } = makeBroker();
    const router = createBrokerRouter({ broker });
    const challenge = BROKER_PKCE_S256_EXAMPLE.challenge;
    const state = oauthState("router-pkce");
    const base = `http://127.0.0.1/oauth/github/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}&code_challenge=${challenge}`;

    const missingMethod = await router.handle(new Request(`${base}`), "127.0.0.1");
    expect(missingMethod.status).toBe(400);
    expect((await missingMethod.json() as { error: string }).error).toBe("invalid-request");

    const plain = await router.handle(
      new Request(`${base}&code_challenge_method=plain`),
      "127.0.0.1"
    );
    expect(plain.status).toBe(400);

    const duplicate = await router.handle(
      new Request(`${base}&code_challenge_method=S256&code_challenge=${challenge}`),
      "127.0.0.1"
    );
    expect(duplicate.status).toBe(400);

    const ok = await router.handle(
      new Request(`${base}&code_challenge_method=S256`),
      "127.0.0.1"
    );
    expect(ok.status).toBe(302);
    const location = ok.headers.get("location")!;
    expect(location).not.toContain(challenge);
  });
});

describe("RFC 7636 S256 helper", () => {
  it("matches the Appendix B vector", async () => {
    expect(await s256Challenge(BROKER_PKCE_S256_EXAMPLE.verifier))
      .toBe(BROKER_PKCE_S256_EXAMPLE.challenge);
  });
});
