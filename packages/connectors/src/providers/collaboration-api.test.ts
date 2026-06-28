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
});

describe("Slack production adapter", () => {
  it("registers all external mutations as consequential", () => {
    expect(SLACK_CAPABILITIES.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)).toBe(true);
  });

  it("maps channel history, threads, users, and search responses", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (url: string | URL | Request) => String(url).includes("search.messages")
      ? json({ ok: true, messages: { matches: [{ ts: "1", text: "found" }] } })
      : json({ ok: true, messages: [{ ts: "1", text: "hello" }], response_metadata: { next_cursor: "next" } }));
    const adapter = slack(fetcher);
    await expect(adapter.read({ capability: "slack.history.read", input: { channel: "C1" } }, tokens)).resolves.toMatchObject({ nextCursor: "next", items: [{ text: "hello" }] });
    await expect(adapter.read({ capability: "slack.messages.search", input: { query: "found" } }, tokens)).resolves.toMatchObject({ items: [{ text: "found" }] });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([expect.stringContaining("conversations.history"), expect.stringContaining("search.messages")]));
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
});

describe.runIf(Boolean(process.env.FABLE_LIVE_CONNECTOR_TESTS))("live collaboration connectors", () => {
  it.skip("runs only when deliberately supplied credentials are handled by the native keyring boundary", () => undefined);
});
