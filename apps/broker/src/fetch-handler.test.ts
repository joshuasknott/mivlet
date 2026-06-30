import { describe, expect, it } from "vitest";

import { BROKER_CONTRACT_VERSION } from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { createBrokerFetchHandler } from "./fetch-handler.js";
import { providerProfile } from "./provider-profiles.js";

const ENV = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

function providerFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return async (url) => {
    const target = new URL(url);
    if (target.href === providerProfile("github").tokenEndpoint) {
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.href === providerProfile("github").identityEndpoint) {
      return new Response(JSON.stringify({ id: 1, login: "u" }), { status: 200 });
    }
    if (target.href === providerProfile("github").revocationEndpoint) {
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

function broker(env = ENV) {
  return new FableBroker({ env, fetch: providerFetch() });
}

function handler(env = ENV, budget = 60) {
  return createBrokerFetchHandler({
    broker: broker(env),
    requestsPerMinute: budget,
    allowedOrigins: ["http://127.0.0.1:8788"],
    port: 8788
  });
}

describe("broker fetch transport", () => {
  it("serves health without leaking secrets", async () => {
    const response = await handler()(new Request("https://auth.example.test/healthz"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fable-request-id")).toBeTruthy();
    const body = await response.json() as { providers: string[]; contractVersion: number };
    expect(body.contractVersion).toBe(BROKER_CONTRACT_VERSION);
    expect(body.providers).toEqual(["github"]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("redirects authorize requests to the provider and fails closed when config is missing", async () => {
    const ok = await handler()(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch",
      { redirect: "manual" }
    ));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("client_id=gh-id");

    const missing = await handler({})(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch"
    ));
    expect(missing.status).toBe(503);
    expect((await missing.json() as { error: string }).error).toBe("configuration-required");
  });

  it("completes the callback to handoff redemption flow through Fetch requests", async () => {
    const b = broker();
    const h = createBrokerFetchHandler({ broker: b, port: 8788 });
    await b.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider: "github",
      redirectUri: "http://127.0.0.1:1/callback",
      state: "hs",
      codeChallenge: "ch",
      codeChallengeMethod: "S256"
    });

    const callback = await h(new Request("https://auth.example.test/oauth/github/callback?code=c&state=hs"));
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:1/callback");
    expect(redirect.searchParams.get("handoff")).toBeTruthy();

    const redeemed = await h(new Request("https://auth.example.test/oauth/github/handoff", {
      method: "POST",
      body: JSON.stringify({
        contractVersion: BROKER_CONTRACT_VERSION,
        handoff: redirect.searchParams.get("handoff"),
        state: "hs"
      }),
      headers: { "content-type": "application/json" }
    }));
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json() as { tokens: { accessToken: string } }).tokens.accessToken).toBe("access-token");
  });

  it("keeps CORS narrow and rate-limits OAuth routes", async () => {
    const preflight = await handler()(new Request("https://auth.example.test/oauth/github/handoff", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" }
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const h = handler(ENV, 1);
    const first = await h(new Request("https://auth.example.test/oauth/github/nope"));
    const second = await h(new Request("https://auth.example.test/oauth/github/nope"));
    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });
});
