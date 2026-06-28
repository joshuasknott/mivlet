/**
 * HTTP transport tests: routing, rate limiting, correlation ids, structured
 * redacted errors, version gating, and the unknown-route / unknown-provider
 * guards. Drives the real request handler in memory (no socket bound).
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { BROKER_CONTRACT_VERSION } from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { createBrokerHandler } from "./http.js";
import { providerProfile } from "./provider-profiles.js";

const ENV: NodeJS.ProcessEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

function providerFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  return async (url) => {
    const target = new URL(url);
    if (target.href === providerProfile("github").tokenEndpoint) {
      return new Response(JSON.stringify({
        access_token: "access-token", refresh_token: "refresh-token", token_type: "Bearer", expires_in: 3600
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

function broker() {
  return new FableBroker({ env: ENV, fetch: providerFetch() });
}

interface DriveResult { status: number; body: string; headers: Record<string, string | string[] | undefined>; location?: string }

function drive(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<DriveResult> {
  return new Promise((resolve) => {
    const res = {
      headers: {} as Record<string, string | string[] | undefined>,
      status: 200,
      chunks: [] as string[],
      writeHead(status: number, h?: Record<string, string>) {
        this.status = status;
        if (h) Object.assign(this.headers, h);
      },
      setHeader(name: string, value: string | string[]) { this.headers[name] = value; },
      end(chunk?: string) {
        if (chunk) this.chunks.push(chunk);
        resolve({ status: this.status, body: this.chunks.join(""), headers: this.headers, location: this.headers.location as string | undefined });
      }
    } as unknown as ServerResponse;
    const req = {
      method,
      url: path,
      headers: { host: "127.0.0.1", ...headers },
      socket: { remoteAddress: "127.0.0.1" },
      setEncoding() {},
      on(event: string, fn: (arg?: unknown) => void) {
        if (event === "data" && body !== undefined) fn(typeof body === "string" ? body : JSON.stringify(body));
        if (event === "end") fn();
      },
      destroy() {}
    } as unknown as IncomingMessage;
    handler(req, res);
  });
}

function handler(budget = 60, origins = ["http://127.0.0.1:8788"]) {
  return createBrokerHandler({ broker: broker(), port: 0, requestsPerMinute: budget, allowedOrigins: origins });
}

describe("broker http routing + security", () => {
  it("health is reachable, returns configured providers only, never secrets", async () => {
    const result = await drive(handler(), "GET", "/healthz");
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("ok");
    expect(body.contractVersion).toBe(BROKER_CONTRACT_VERSION);
    expect(body.providers).toEqual(["github"]);
    expect(result.body).not.toContain("secret");
  });

  it("authorize route returns the authorization url", async () => {
    const result = await drive(handler(), "GET", "/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/cb&state=s&code_challenge=ch");
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.authorizationUrl).toContain("client_id=gh-id");
    expect(body.authorizationUrl).toContain("state=s");
  });

  it("handoff redeem maps to the broker and returns tokens", async () => {
    const b = broker();
    const h = createBrokerHandler({ broker: b, port: 0 });
    b.authorize({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github",
      redirectUri: "http://127.0.0.1:1/cb", state: "hs", codeChallenge: "ch", codeChallengeMethod: "S256"
    });
    const cb = await b.callback("github", new URLSearchParams({ code: "c", state: "hs" }));
    const handoff = cb.redirect.searchParams.get("handoff")!;
    const result = await drive(h, "POST", "/oauth/github/handoff", { contractVersion: BROKER_CONTRACT_VERSION, handoff, state: "hs" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).tokens.accessToken).toBe("access-token");
  });

  it("callback route redirects (302) to the desktop redirect", async () => {
    const b = broker();
    const h = createBrokerHandler({ broker: b, port: 0 });
    b.authorize({
      contractVersion: BROKER_CONTRACT_VERSION, provider: "github",
      redirectUri: "http://127.0.0.1:1/cb", state: "cb1", codeChallenge: "ch", codeChallengeMethod: "S256"
    });
    const result = await drive(h, "GET", "/oauth/github/callback?code=c&state=cb1");
    expect(result.status).toBe(302);
    expect(result.location).toContain("http://127.0.0.1:1/cb");
    expect(result.location).toContain("handoff=");
    expect(result.location).not.toContain("access-token");
  });

  it("rejects an unsupported contract version with a structured redacted error", async () => {
    const result = await drive(handler(), "POST", "/oauth/github/handoff", { contractVersion: 99, handoff: "x", state: "y" });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toBe("unsupported-version");
    expect(body.contractVersion).toBe(BROKER_CONTRACT_VERSION);
  });

  it("unknown routes return a redacted invalid-request error", async () => {
    const result = await drive(handler(), "GET", "/oauth/github/nope");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toBe("invalid-request");
  });

  it("unknown provider returns unknown-provider", async () => {
    const result = await drive(handler(), "GET", "/oauth/google/authorize?redirect_uri=http://127.0.0.1:1/cb&state=s&code_challenge=ch");
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error).toBe("unknown-provider");
  });

  it("rate-limits a route after the per-minute budget is exceeded", async () => {
    const h = handler(2); // budget of 2/min
    const r1 = await drive(h, "GET", "/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/cb&state=s1&code_challenge=ch");
    const r2 = await drive(h, "GET", "/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/cb&state=s2&code_challenge=ch");
    const r3 = await drive(h, "GET", "/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/cb&state=s3&code_challenge=ch");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(JSON.parse(r3.body).error).toBe("rate-limited");
  });

  it("OPTIONS preflight returns 204 with CORS headers for allowed origins", async () => {
    const result = await drive(handler(), "OPTIONS", "/oauth/github/handoff", undefined, { origin: "http://127.0.0.1:8788" });
    expect(result.status).toBe(204);
    expect(result.headers["access-control-allow-methods"]).toBeTruthy();
  });

  it("does not set CORS allow-origin for a disallowed origin", async () => {
    const result = await drive(handler(), "OPTIONS", "/oauth/github/handoff", undefined, { origin: "https://evil.example" });
    expect(result.status).toBe(204);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("every response carries a correlation id header", async () => {
    const result = await drive(handler(), "GET", "/healthz");
    expect(result.headers["x-fable-request-id"]).toBeTruthy();
  });

  it("revoke route maps to the broker revoke operation", async () => {
    const result = await drive(handler(), "POST", "/oauth/github/revoke", { contractVersion: BROKER_CONTRACT_VERSION, token: "t" });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).revoked).toBe(true);
  });
});
