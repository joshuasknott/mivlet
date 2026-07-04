import { describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";
import { ConnectorRuntime } from "../sdk";
import type { ProviderFetch } from "./http";
import { createNotionAdapter, NOTION_CAPABILITIES } from "./notion-api";
import { createSlackAdapter, SLACK_CAPABILITIES } from "./slack-api";

const tokens: ConnectorTokenSet = { accessToken: "test-token", tokenType: "Bearer", scopes: [] };
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const base = { authBaseUrl: "https://auth.example/", clientId: "client", redirectUri: "http://127.0.0.1:43123/callback" };
const notion = (fetch: ProviderFetch) => createNotionAdapter({ ...base, fetch });
const slack = (fetch: ProviderFetch) => createSlackAdapter({ ...base, fetch });

describe("Notion production adapter", () => {
  it("registers typed read and consequential write capabilities", () => {
    expect(NOTION_CAPABILITIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "notion.blocks.read", kind: "read", consequential: false }),
      expect.objectContaining({ id: "notion.block.delete", kind: "write", consequential: true })
    ]));
  });

  it("maps search and pagination to the official API contract", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json({ results: [{ id: "p1", object: "page", properties: { Name: { title: [] } } }], has_more: true, next_cursor: "next" }));
    const adapter = notion(fetcher);
    const result = await adapter.read({ capability: "notion.search", input: { query: "roadmap", pageSize: 25 }, cursor: "cursor" }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/search");
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "roadmap", page_size: 25, start_cursor: "cursor" });
    expect(init?.headers).toMatchObject({ "notion-version": "2022-06-28" });
    expect(result.nextCursor).toBe("next");
    expect(result.items[0]).toMatchObject({ id: "p1", object: "page", properties: expect.any(Object) });
  });

  it("traverses block children and maps inaccessible/deleted resources", async () => {
    const ok = vi.fn(async () => json({ results: [{ id: "b1", archived: true }], has_more: false }));
    await expect(notion(ok).read({ capability: "notion.blocks.read", input: { blockId: "page-1" } }, tokens)).resolves.toMatchObject({ items: [{ id: "b1", archived: true }] });
    const denied = notion(vi.fn(async () => json({ code: "restricted_resource" }, 403)));
    await expect(denied.read({ capability: "notion.page.read", input: { pageId: "hidden" } }, tokens)).rejects.toMatchObject({ code: "permission-denied" });
    const deleted = notion(vi.fn(async () => json({ code: "object_not_found" }, 404)));
    await expect(deleted.read({ capability: "notion.page.read", input: { pageId: "deleted" } }, tokens)).rejects.toMatchObject({ code: "not-found" });
  });

  it("maps revoked access, rate limits, malformed responses, cancellation, and network failures", async () => {
    for (const [response, code] of [[json({}, 401), "expired-auth"], [json({}, 429, { "retry-after": "2" }), "rate-limited"]] as const) {
      await expect(notion(vi.fn(async () => response)).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ code });
    }
    await expect(notion(vi.fn(async () => new Response("bad"))).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
    await expect(notion(vi.fn(async () => { throw new Error("socket detail"); })).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ message: "The provider network request failed." });
    const controller = new AbortController(); controller.abort();
    await expect(notion(vi.fn(async () => { throw new DOMException("aborted", "AbortError"); })).read({ capability: "notion.search", input: {}, signal: controller.signal }, tokens)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes auth through the broker oauth paths like the other confidential adapters", async () => {
    const start = await notion(vi.fn()).startAuth({ redirectUri: base.redirectUri, state: "s", codeChallenge: "c" });
    expect(start.authorizationUrl).toContain("https://auth.example/oauth/notion/authorize");
    expect(start.state).toBe("s");
  });

  it("redeems, refreshes, and revokes through the versioned broker contract", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      expect(body.contractVersion).toBe(1);
      expect(body.provider).toBe("notion");
      if (path.endsWith("/handoff")) return json({ contractVersion: 1, tokens: { accessToken: "a", refreshToken: "r", tokenType: "Bearer", scopes: [] }, account: { id: "ws", displayName: "Workspace" } });
      if (path.endsWith("/refresh")) return json({ contractVersion: 1, tokens: { accessToken: "a2", tokenType: "Bearer", scopes: [] } });
      return json({ contractVersion: 1, revoked: true });
    });
    const adapter = notion(fetcher);
    const auth = await adapter.completeAuth({ callbackUrl: `${base.redirectUri}?handoff=t&state=s`, expectedState: "s", codeVerifier: "unused" });
    expect(auth).toMatchObject({ tokens: { accessToken: "a", refreshToken: "r" }, account: { id: "ws" } });
    await expect(adapter.refresh(auth.tokens)).resolves.toMatchObject({ accessToken: "a2", refreshToken: "r" });
    await expect(adapter.revoke(auth.tokens)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/oauth/notion/handoff", "/oauth/notion/refresh", "/oauth/notion/revoke"
    ]);
  });

  it("never derives non-contract token or identity broker routes", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn<ProviderFetch>(async (url, init) => {
      seen.push(new URL(String(url)).pathname);
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      expect(body.provider).toBe("notion");
      if (path.endsWith("/handoff")) return json({ contractVersion: 1, tokens: { accessToken: "a", refreshToken: "r", tokenType: "Bearer", scopes: [] }, account: { id: "ws", displayName: "Workspace" } });
      if (path.endsWith("/refresh")) return json({ contractVersion: 1, tokens: { accessToken: "a2", tokenType: "Bearer", scopes: [] } });
      if (path.endsWith("/revoke")) return json({ contractVersion: 1, revoked: true });
      return json({ error: "invalid route" }, 404);
    });
    const adapter = notion(fetcher);
    const auth = await adapter.completeAuth({ callbackUrl: `${base.redirectUri}?handoff=t&state=s`, expectedState: "s", codeVerifier: "unused" });
    await adapter.refresh(auth.tokens);
    await adapter.revoke(auth.tokens);
    expect(seen).toEqual(["/oauth/notion/handoff", "/oauth/notion/refresh", "/oauth/notion/revoke"]);
    expect(seen).not.toContain("/oauth/notion/token");
    expect(seen).not.toContain("/oauth/notion/identity");
  });

  it("handles missing broker configuration (HTTP 503 / broker_configuration)", async () => {
    const fetcher = vi.fn(async () => json({ error: "configuration-required", message: "Notion is not configured on this broker." }, 503));
    const adapter = notion(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "configuration-required",
      message: "Notion is not configured on this broker."
    });
  });

  it("handles unconfigured/expired refresh tokens when token lacks refresh token", async () => {
    const adapter = notion(vi.fn());
    await expect(adapter.refresh({ accessToken: "access", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth",
      message: expect.stringContaining("expired")
    });
  });

  it("handles expired credentials from broker refresh (HTTP 401 / needs-auth)", async () => {
    const fetcher = vi.fn(async () => json({ error: "needs-auth", message: "Refresh token was rejected." }, 401));
    const adapter = notion(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth",
      message: "Refresh token was rejected."
    });
  });

  it("handles token revocation success (200) and idempotent success (404)", async () => {
    const fetcher = vi.fn(async () => json(undefined, 200));
    const adapter = notion(fetcher);
    await expect(adapter.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example/oauth/notion/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contractVersion: 1,
          provider: "notion",
          token: "refresh",
          tokenTypeHint: "refresh_token"
        })
      })
    );

    const fetcher404 = vi.fn(async () => json(undefined, 404));
    const adapter404 = notion(fetcher404);
    await expect(adapter404.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).resolves.toBeUndefined();
  });

  it("handles broker refresh failure (HTTP 500 / provider-unavailable)", async () => {
    const fetcher = vi.fn(async () => json({ error: "provider-unavailable", message: "Broker is temporarily unavailable." }, 500));
    const adapter = notion(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "provider-unavailable",
      message: "Broker is temporarily unavailable.",
      retryable: true
    });
  });

  it("handles missing broker (network connection error or broker HTTP 404)", async () => {
    const fetcher = vi.fn(async () => { throw new Error("TypeError: fetch failed"); });
    const adapter = notion(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toThrow();

    const fetcher404 = vi.fn(async () => json(undefined, 404));
    const adapter404 = notion(fetcher404);
    await expect(adapter404.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "not-found"
    });
  });

  it("handles provider unavailable (HTTP 502 / network error on Notion API request)", async () => {
    const fetcher = vi.fn(async () => new Response("Internal Server Error", { status: 502 }));
    const adapter = notion(fetcher);
    await expect(adapter.read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({
      code: "provider-unavailable",
      retryable: true
    });

    const networkErrorFetcher = vi.fn(async () => { throw new Error("socket hang up"); });
    const networkAdapter = notion(networkErrorFetcher);
    await expect(networkAdapter.read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({
      code: "provider-unavailable",
     message: "The provider network request failed.",
     retryable: true
   });
  });
});


describe("Slack production adapter", () => {
  it("registers all external mutations as consequential", () => {
    expect(SLACK_CAPABILITIES.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)).toBe(true);
  });

  it("maps channel history and user responses without claiming user-token message search", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (url: string | URL | Request) => String(url).includes("users.list")
      ? json({ ok: true, members: [{ id: "U1", name: "tester" }], response_metadata: { next_cursor: "users-next" } })
      : json({ ok: true, messages: [{ ts: "1", text: "hello" }], response_metadata: { next_cursor: "next" } }));
    const adapter = slack(fetcher);
    await expect(adapter.read({ capability: "slack.history.read", input: { channel: "C1" } }, tokens)).resolves.toMatchObject({ nextCursor: "next", items: [{ text: "hello" }] });
    await expect(adapter.read({ capability: "slack.users.list", input: {} }, tokens)).resolves.toMatchObject({ nextCursor: "users-next", items: [{ name: "tester" }] });
    expect(adapter.capabilities.map((capability) => capability.id)).not.toContain("slack.messages.search");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([expect.stringContaining("conversations.history"), expect.stringContaining("users.list")]));
  });

  it("normalizes missing scopes, revoked tokens, inaccessible/archived channels, and API rate limits", async () => {
    for (const [error, code] of [["missing_scope", "permission-denied"], ["token_revoked", "expired-auth"], ["channel_not_found", "not-found"], ["is_archived", "invalid-request"], ["ratelimited", "rate-limited"]]) {
      const adapter = slack(vi.fn(async () => json({ ok: false, error })));
      await expect(adapter.read({ capability: "slack.channels.list", input: {} }, tokens)).rejects.toMatchObject({ code });
    }
  });

  it("never performs a post without a matching explicit approval", async () => {
    const fetcher = vi.fn(async () => json({ ok: true, ts: "123.456", channel: "C1" }));
    const adapter = slack(fetcher);
    const approvals = { approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "denied" as const, decidedAt: "2026-06-27T12:00:00Z" })), complete: vi.fn(async () => undefined) };
    const runtime = new ConnectorRuntime({ approvals }); runtime.register(adapter);
    await expect(runtime.write({ connectorId: "slack", account: { id: "U1", displayName: "Tester", workspace: "Example" }, tokens }, { capability: "slack.message.post", input: { channel: "C1", text: "Exact proposed text" }, target: "Example / #general", preview: "Exact proposed text", riskLevel: "high" })).rejects.toMatchObject({ code: "approval-required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps approved posts and replies to chat.postMessage exactly", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json({ ok: true, ts: "123.456", channel: "C1" }));
    const adapter = slack(fetcher);
    await adapter.write({ capability: "slack.reply.post", input: { channel: "C1", thread_ts: "100.000", text: "Exact text" }, target: "#general thread 100.000", preview: "Exact text", riskLevel: "high" }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("chat.postMessage");
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", thread_ts: "100.000", text: "Exact text" });
  });

  it("routes auth through the broker oauth paths like the other confidential adapters", async () => {
    const start = await slack(vi.fn()).startAuth({ redirectUri: base.redirectUri, state: "s2", codeChallenge: "c" });
    expect(start.authorizationUrl).toContain("https://auth.example/oauth/slack/authorize");
  });

  it("redeems, refreshes, and revokes only through Slack broker contract routes", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn<ProviderFetch>(async (url, init) => {
      seen.push(new URL(String(url)).pathname);
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      expect(body.provider).toBe("slack");
      if (path.endsWith("/handoff")) return json({ contractVersion: 1, tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", tokenType: "Bearer", scopes: [] }, account: { id: "U1", displayName: "Slack User", workspace: "Fable" } });
      if (path.endsWith("/refresh")) return json({ contractVersion: 1, tokens: { accessToken: "synthetic-access-2", tokenType: "Bearer", scopes: [] } });
      if (path.endsWith("/revoke")) return json({ contractVersion: 1, revoked: true });
      return json({ error: "invalid route" }, 404);
    });
    const adapter = slack(fetcher);
    const auth = await adapter.completeAuth({ callbackUrl: `${base.redirectUri}?handoff=t&state=s2`, expectedState: "s2", codeVerifier: "unused" });
    await adapter.refresh(auth.tokens);
    await adapter.revoke(auth.tokens);
    expect(seen).toEqual(["/oauth/slack/handoff", "/oauth/slack/refresh", "/oauth/slack/revoke"]);
    expect(seen).not.toContain("/oauth/slack/token");
    expect(seen).not.toContain("/oauth/slack/identity");
  });

  it("handles missing broker configuration (HTTP 503 / broker_configuration)", async () => {
    const fetcher = vi.fn(async () => json({ error: "configuration-required", message: "Slack is not configured on this broker." }, 503));
    const adapter = slack(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "configuration-required",
      message: "Slack is not configured on this broker."
    });
  });

  it("handles unconfigured/expired refresh tokens when token lacks refresh token", async () => {
    const adapter = slack(vi.fn());
    await expect(adapter.refresh({ accessToken: "access", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth",
      message: expect.stringContaining("expired")
    });
  });

  it("handles expired credentials from broker refresh (HTTP 401 / needs-auth)", async () => {
    const fetcher = vi.fn(async () => json({ error: "needs-auth", message: "Refresh token was rejected." }, 401));
    const adapter = slack(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth",
      message: "Refresh token was rejected."
    });
  });

  it("handles token revocation success (200) and idempotent success (404)", async () => {
    const fetcher = vi.fn(async () => json(undefined, 200));
    const adapter = slack(fetcher);
    await expect(adapter.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example/oauth/slack/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          contractVersion: 1,
          provider: "slack",
          token: "refresh",
          tokenTypeHint: "refresh_token"
        })
      })
    );

    const fetcher404 = vi.fn(async () => json(undefined, 404));
    const adapter404 = slack(fetcher404);
    await expect(adapter404.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).resolves.toBeUndefined();
  });

  it("handles broker refresh failure (HTTP 500 / provider-unavailable)", async () => {
    const fetcher = vi.fn(async () => json({ error: "provider-unavailable", message: "Broker is temporarily unavailable." }, 500));
    const adapter = slack(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "provider-unavailable",
      message: "Broker is temporarily unavailable.",
      retryable: true
    });
  });

  it("handles missing broker (network connection error or broker HTTP 404)", async () => {
    const fetcher = vi.fn(async () => { throw new Error("TypeError: fetch failed"); });
    const adapter = slack(fetcher);
    await expect(adapter.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toThrow();

    const fetcher404 = vi.fn(async () => json(undefined, 404));
    const adapter404 = slack(fetcher404);
    await expect(adapter404.refresh({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "not-found"
    });
  });

  it("handles provider unavailable (HTTP 502 / network error on Slack API request)", async () => {
    const fetcher = vi.fn(async () => new Response("Internal Server Error", { status: 502 }));
    const adapter = slack(fetcher);
    await expect(adapter.read({ capability: "slack.channels.list", input: {} }, tokens)).rejects.toMatchObject({
      code: "provider-unavailable",
      retryable: true
    });

    const networkErrorFetcher = vi.fn(async () => { throw new Error("socket hang up"); });
    const networkAdapter = slack(networkErrorFetcher);
    await expect(networkAdapter.read({ capability: "slack.channels.list", input: {} }, tokens)).rejects.toMatchObject({
      code: "provider-unavailable",
     message: "The provider network request failed.",
     retryable: true
   });
  });
});

describe.runIf(Boolean(process.env.FABLE_LIVE_CONNECTOR_TESTS))("live collaboration connectors", () => {
  it.skip("runs only when deliberately supplied credentials are handled by the native keyring boundary", () => undefined);
});
