import { describe, expect, it, vi } from "vitest";
import type { ConnectorTokenSet } from "@fable/protocol";
import {
  MAX_RETRY_AFTER_MS,
  ProviderHttpClient,
  googleOAuthClient,
  oauthClient,
  providerError
} from "./http";

const CANARY = "canary-access-token-7f3";
const tokens: ConnectorTokenSet = {
  accessToken: CANARY,
  tokenType: "Bearer",
  scopes: []
};

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function client(fetcher: (input: string, init?: RequestInit) => Promise<Response>) {
  return new ProviderHttpClient("github", "https://api.example.com/", fetcher);
}

describe("ProviderHttpClient retry policy", () => {
  it("recovers an idempotent GET from 429 with Retry-After", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "slow down" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ items: ["ok"] }));
    const result = await client(fetcher).request<{ items: string[] }>({ path: "items" }, tokens);
    expect(result.data).toEqual({ items: ["ok"] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("items"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: `Bearer ${CANARY}` })
      })
    );
  });

  it("recovers an idempotent GET from 503 and from a transient network failure", async () => {
    const overloaded = vi
      .fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ items: ["ok"] }));
    await expect(
      client(overloaded).request<{ items: string[] }>({ path: "items" }, tokens)
    ).resolves.toMatchObject({ data: { items: ["ok"] } });
    expect(overloaded).toHaveBeenCalledTimes(2);

    const persistent = vi.fn(async () => json({}, 503));
    await expect(client(persistent).request({ path: "items" }, tokens)).rejects.toMatchObject({
      code: "configuration-required",
      retryable: false
    });
    expect(persistent).toHaveBeenCalledTimes(2);

    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(json({ items: ["ok"] }));
    await expect(
      client(flaky).request<{ items: string[] }>({ path: "items" }, tokens)
    ).resolves.toMatchObject({ data: { items: ["ok"] } });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded attempts and surfaces the last error", async () => {
    const fetcher = vi.fn(async () =>
      json({ error: "rate_limit_exceeded" }, 429, { "retry-after": "0" })
    );
    await expect(client(fetcher).request({ path: "items" }, tokens)).rejects.toMatchObject({
      connectorId: "github",
      code: "rate-limited",
      retryable: true,
      retryAfter: "0"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries on the clamped Retry-After delay and never on the raw value", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json({}, 429, { "retry-after": "999999" }))
        .mockResolvedValueOnce(json({ ok: true }));
      const pending = client(fetcher).request({ path: "items" }, tokens);
      await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ data: { ok: true } });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops invalid Retry-After values instead of surfacing NaN", async () => {
    const fetcher = vi.fn(async () => json({}, 429, { "retry-after": "garbage" }));
    const error = await client(fetcher).request({ path: "items" }, tokens).catch((e) => e);
    expect(error.retryAfter).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("NaN");
    expect(error).toMatchObject({ code: "rate-limited", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("parses Retry-After seconds and HTTP-dates with clamping in providerError", () => {
    expect(providerError("github", 429, undefined, "2").retryAfter).toBe("2000");
    expect(providerError("github", 429, undefined, "-5").retryAfter).toBe("0");
    expect(providerError("github", 429, undefined, "315360000").retryAfter).toBe(
      String(MAX_RETRY_AFTER_MS)
    );
    expect(providerError("github", 429, undefined, "Wed, 21 Oct 2015 07:28:00 GMT").retryAfter).toBe("0");
    expect(providerError("github", 429, undefined, "Fri, 01 Jan 2030 00:00:00 GMT").retryAfter).toBe(
      String(MAX_RETRY_AFTER_MS)
    );
    expect(providerError("github", 503, undefined, "garbage").retryAfter).toBeUndefined();
    expect(providerError("github", 503, undefined, "").retryAfter).toBeUndefined();
  });

  it("stops waiting and never re-fires when the signal aborts during backoff", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetcher = vi.fn(async () => json({}, 429, { "retry-after": "30" }));
      const pending = client(fetcher).request({ path: "items", signal: controller.signal }, tokens);
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts before issuing the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => json({ ok: true }));
    await expect(
      client(fetcher).request({ path: "items", signal: controller.signal }, tokens)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry a request aborted mid-flight like a timeout", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const pending = client(fetcher).request({ path: "items", signal: controller.signal }, tokens);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("surfaces AbortError instead of malformed_response when the body read is aborted", async () => {
    const controller = new AbortController();
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      })
    } as unknown as Response;
    const fetcher = vi.fn(async () => fakeResponse);
    await expect(
      client(fetcher).request({ path: "items", signal: controller.signal }, tokens)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized and malformed error bodies without crashing or leaking", async () => {
    const oversized = "x".repeat(128 * 1024);
    const declared = client(
      vi.fn(async () => json(oversized, 429, { "retry-after": "0" }))
    );
    const error = await declared.request({ path: "items" }, tokens).catch((e) => e);
    expect(error).toMatchObject({ code: "rate-limited", retryable: true });
    expect(JSON.stringify(error)).not.toContain(oversized.slice(0, 16));

    const streamed = new Response(oversized, { status: 429 });
    streamed.headers.delete("content-length");
    const streamedClient = client(vi.fn(async () => streamed));
    await expect(streamedClient.request({ path: "items" }, tokens)).rejects.toMatchObject({
      code: "rate-limited"
    });

    const malformed = client(vi.fn(async () => new Response("not-json", { status: 429 })));
    await expect(malformed.request({ path: "items" }, tokens)).rejects.toMatchObject({
      code: "rate-limited"
    });
  });

  it("never replays an uncertain mutation", async () => {
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const fetcher = vi.fn(async () => json({}, 503, { "retry-after": "0" }));
      await expect(
        client(fetcher).request({ method, path: "items", body: { title: "x" } }, tokens)
      ).rejects.toMatchObject({ code: "configuration-required", retryable: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry non-retryable statuses", async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetcher = vi.fn(async () => json({}, status));
      await expect(client(fetcher).request({ path: "items" }, tokens)).rejects.toMatchObject({
        retryable: false
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("never leaks credential canaries into surfaced errors", async () => {
    const echoingBody = client(
      vi.fn(async () =>
        json({ message: `token ${CANARY} was revoked`, error: "rate_limit_exceeded" }, 429, {
          "retry-after": "0"
        })
      )
    );
    const bodyError = await echoingBody.request({ path: "items" }, tokens).catch((e) => e);
    expect(JSON.stringify(bodyError)).not.toContain(CANARY);

    const networkError = client(
      vi.fn(async () => {
        throw new Error(`socket hang up with Bearer ${CANARY}`);
      })
    );
    const netError = await networkError.request({ path: "items" }, tokens).catch((e) => e);
    expect(netError).toMatchObject({
      code: "provider-unavailable",
      message: "The provider network request failed."
    });
    expect(JSON.stringify(netError)).not.toContain(CANARY);
    expect(JSON.stringify(netError)).not.toContain("socket hang up");
  });
});

describe("OAuth refresh and revoke stay free of read retries", () => {
  const oauthOptions = {
    connectorId: "github" as const,
    clientId: "client",
    authorizationEndpoint: "https://broker.example/oauth/github/authorize",
    tokenEndpoint: "https://broker.example/oauth/github/token",
    redirectUri: "http://127.0.0.1:43123/callback",
    scopes: ["read:user"]
  };

  it("does not retry a rate-limited refresh or revoke", async () => {
    const fetcher = vi.fn(async () =>
      json({ error: "rate-limited", message: "slow down" }, 429, { "retry-after": "2" })
    );
    const oauth = oauthClient({ ...oauthOptions, fetch: fetcher });
    await expect(
      oauth.refresh({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", scopes: [] })
    ).rejects.toMatchObject({ code: "rate-limited", retryable: true, retryAfter: "2000" });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const revokeFetcher = vi.fn(async () => json({}, 429, { "retry-after": "garbage" }));
    const revoking = oauthClient({ ...oauthOptions, revocationEndpoint: "https://broker.example/oauth/github/revoke", fetch: revokeFetcher });
    await expect(
      revoking.revoke({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", scopes: [] })
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(revokeFetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rate-limited public-PKCE refresh", async () => {
    const fetcher = vi.fn(async () => json({}, 429, { "retry-after": "2" }));
    const oauth = googleOAuthClient({
      ...oauthOptions,
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      revocationEndpoint: "https://oauth2.googleapis.com/revoke",
      fetch: fetcher
    });
    await expect(
      oauth.refresh({ accessToken: "a", refreshToken: "r", tokenType: "Bearer", scopes: [] })
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});