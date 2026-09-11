import { describe, expect, it, vi } from "vitest";
import type {
  ConnectorApprovalRecord,
  ConnectorTokenSet,
} from "@fable/protocol";
import { ConnectorRuntime } from "../sdk";
import type { ProviderFetch } from "./http";
import { createSlackAdapter } from "./slack-api";
import { normalizeSlackItem } from "./slack";

const tokens: ConnectorTokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  scopes: [],
};
const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const base = {
  authBaseUrl: "https://auth.example/",
  clientId: "client",
  redirectUri: "http://127.0.0.1:43123/callback",
};
const slack = (fetch: ProviderFetch) => createSlackAdapter({ ...base, fetch });

describe("Slack response handling", () => {
  it("turns every HTTP 200 ok:false read into a truthful connector error instead of success or an empty page", async () => {
    for (const capability of [
      "slack.channels.list",
      "slack.history.read",
      "slack.thread.read",
      "slack.users.list",
    ]) {
      const adapter = slack(
        vi.fn(async () => json({ ok: false, error: "missing_scope" })),
      );
      const input =
        capability === "slack.history.read"
          ? { channel: "C1" }
          : capability === "slack.thread.read"
            ? { channel: "C1", ts: "1.0" }
            : {};
      await expect(
        adapter.read({ capability, input }, tokens),
      ).rejects.toMatchObject({
        code: "permission-denied",
        connectorId: "slack",
        retryable: false,
      });
    }
  });

  it("maps Slack ok:false states to useful connector codes", async () => {
    const cases: Array<[string, string]> = [
      ["missing_scope", "permission-denied"],
      ["no_permission", "permission-denied"],
      ["access_denied", "permission-denied"],
      ["restricted_action", "permission-denied"],
      ["token_revoked", "expired-auth"],
      ["token_expired", "expired-auth"],
      ["invalid_auth", "expired-auth"],
      ["not_authed", "expired-auth"],
      ["channel_not_found", "not-found"],
      ["not_in_channel", "not-found"],
      ["channel_is_limited_access", "not-found"],
      ["ratelimited", "rate-limited"],
      ["rate_limited", "rate-limited"],
      ["is_archived", "invalid-request"],
      ["invalid_cursor", "invalid-request"],
      ["invalid_arguments", "invalid-request"],
      ["service_unavailable", "provider-unavailable"],
    ];
    for (const [error, code] of cases) {
      const adapter = slack(vi.fn(async () => json({ ok: false, error })));
      await expect(
        adapter.read({ capability: "slack.channels.list", input: {} }, tokens),
      ).rejects.toMatchObject({ code });
    }
  });

  it("reports unknown provider errors as unknown, not as a caller-side invalid request", async () => {
    const adapter = slack(
      vi.fn(async () =>
        json({ ok: false, error: "some_unexpected_provider_error" }),
      ),
    );
    const error = await adapter
      .read({ capability: "slack.channels.list", input: {} }, tokens)
      .catch((caught) => caught);
    expect(error).toMatchObject({
      code: "unknown",
      connectorId: "slack",
      retryable: false,
    });
    expect(error.message).toBe(
      "Slack rejected the request (some_unexpected_provider_error).",
    );
  });

  it("keeps rate-limit state retryable on reads and preserves the Retry-After value", async () => {
    const adapter = slack(
      vi.fn(async () =>
        json({ ok: false, error: "ratelimited" }, 200, { "retry-after": "2" }),
      ),
    );
    await expect(
      adapter.read({ capability: "slack.channels.list", input: {} }, tokens),
    ).rejects.toMatchObject({
      code: "rate-limited",
      retryable: true,
      retryAfter: "2000",
    });

    const http429 = slack(
      vi.fn(async () =>
        json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "30" }),
      ),
    );
    await expect(
      http429.read({ capability: "slack.channels.list", input: {} }, tokens),
    ).rejects.toMatchObject({
      code: "rate-limited",
      retryable: true,
      retryAfter: "30000",
    });
  });

  it("never classifies writes as retryable, so approved posts cannot duplicate", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () =>
      json({ ok: false, error: "ratelimited" }),
    );
    const adapter = slack(fetcher);
    const approvals = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({
        ...record,
        result: "approved" as const,
        decidedAt: "2026-06-27T12:00:00Z",
      })),
      complete: vi.fn(async () => undefined),
    };
    const runtime = new ConnectorRuntime({
      approvals,
      maxRetries: 2,
      sleep: async () => undefined,
    });
    runtime.register(adapter);
    await expect(
      runtime.write(
        {
          connectorId: "slack",
          account: { id: "U1", displayName: "Tester", workspace: "Example" },
          tokens,
        },
        {
          capability: "slack.message.post",
          input: { channel: "C1", text: "Exact proposed text" },
          target: "Example / #general",
          preview: "Exact proposed text",
          riskLevel: "high",
          idempotencyKey: "k1",
        },
      ),
    ).rejects.toMatchObject({ code: "rate-limited", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry approved writes on network or HTTP failures either", async () => {
    const approvals = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({
        ...record,
        result: "approved" as const,
        decidedAt: "2026-06-27T12:00:00Z",
      })),
      complete: vi.fn(async () => undefined),
    };

    const networkFetcher = vi.fn<ProviderFetch>(async () => {
      throw new Error("socket hang up");
    });
    const network = slack(networkFetcher);
    const networkRuntime = new ConnectorRuntime({
      approvals,
      maxRetries: 2,
      sleep: async () => undefined,
    });
    networkRuntime.register(network);
    await expect(
      networkRuntime.write(
        {
          connectorId: "slack",
          account: { id: "U1", displayName: "Tester", workspace: "Example" },
          tokens,
        },
        {
          capability: "slack.message.post",
          input: { channel: "C1", text: "Exact proposed text" },
          target: "Example / #general",
          preview: "Exact proposed text",
          riskLevel: "high",
          idempotencyKey: "k1",
        },
      ),
    ).rejects.toMatchObject({ code: "provider-unavailable", retryable: false });
    expect(networkFetcher).toHaveBeenCalledTimes(1);

    const http429Fetcher = vi.fn(async () =>
      json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "5" }),
    );
    const http429 = slack(http429Fetcher);
    const http429Runtime = new ConnectorRuntime({
      approvals,
      maxRetries: 2,
      sleep: async () => undefined,
    });
    http429Runtime.register(http429);
    await expect(
      http429Runtime.write(
        {
          connectorId: "slack",
          account: { id: "U1", displayName: "Tester", workspace: "Example" },
          tokens,
        },
        {
          capability: "slack.message.update",
          input: { channel: "C1", ts: "123.456", text: "Exact proposed text" },
          target: "Example / #general",
          preview: "Exact proposed text",
          riskLevel: "high",
          idempotencyKey: "k2",
        },
      ),
    ).rejects.toMatchObject({
      code: "rate-limited",
      retryable: false,
      retryAfter: "5000",
    });
    expect(http429Fetcher).toHaveBeenCalledTimes(1);
  });

  it("turns an ok:false write into a truthful error rather than resolving", async () => {
    const adapter = slack(
      vi.fn(async () => json({ ok: false, error: "missing_scope" })),
    );
    await expect(
      adapter.write(
        {
          capability: "slack.message.post",
          input: { channel: "C1", text: "hello" },
          target: "#general",
          preview: "hello",
          riskLevel: "high",
        },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("validates required write identifiers before egress", async () => {
    const adapter = slack(vi.fn());
    await expect(
      adapter.write(
        {
          capability: "slack.message.post",
          input: { text: "no channel" },
          target: "#general",
          preview: "no channel",
          riskLevel: "high",
        },
        tokens,
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "Slack channel is required.",
    });
    await expect(
      adapter.write(
        {
          capability: "slack.reply.post",
          input: { channel: "C1", text: "no thread" },
          target: "#general",
          preview: "no thread",
          riskLevel: "high",
        },
        tokens,
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "Slack thread_ts is required.",
    });
    await expect(
      adapter.write(
        {
          capability: "slack.message.delete",
          input: { channel: "C1" },
          target: "#general",
          preview: "delete",
          riskLevel: "critical",
        },
        tokens,
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "Slack ts is required.",
    });
  });

  it("maps a blank request cursor to no cursor instead of sending cursor=", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () =>
      json({ ok: true, channels: [{ id: "C1" }] }),
    );
    const adapter = slack(fetcher);
    const result = await adapter.read(
      { capability: "slack.channels.list", input: {}, cursor: "" },
      tokens,
    );
    expect(String(fetcher.mock.calls[0][0])).not.toContain("cursor=");
    expect(result).toMatchObject({ items: [{ id: "C1" }] });
    expect(result.nextCursor).toBeUndefined();
  });

  it("drops a next_cursor that repeats the requested cursor so pagination stays bounded", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () =>
      json({
        ok: true,
        channels: [{ id: "C1" }],
        response_metadata: { next_cursor: "same" },
      }),
    );
    const adapter = slack(fetcher);
    const first = await adapter.read(
      { capability: "slack.channels.list", input: {} },
      tokens,
    );
    expect(first.nextCursor).toBe("same");
    const second = await adapter.read(
      {
        capability: "slack.channels.list",
        input: {},
        cursor: first.nextCursor,
      },
      tokens,
    );
    expect(second.nextCursor).toBeUndefined();
    expect(second.items).toEqual([{ id: "C1" }]);
  });

  it("returns empty pages for empty or absent collection fields", async () => {
    const empty = slack(
      vi.fn(async () =>
        json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        }),
      ),
    );
    await expect(
      empty.read({ capability: "slack.channels.list", input: {} }, tokens),
    ).resolves.toEqual({ items: [] });

    const absent = slack(vi.fn(async () => json({ ok: true })));
    await expect(
      absent.read(
        { capability: "slack.history.read", input: { channel: "C1" } },
        tokens,
      ),
    ).resolves.toEqual({ items: [] });
  });

  it("survives malformed response_metadata without fabricating a cursor or losing items", async () => {
    for (const metadata of [
      null,
      "junk",
      [],
      { next_cursor: 123 },
      { next_cursor: "" },
      { next_cursor: null },
    ]) {
      const adapter = slack(
        vi.fn(async () =>
          json({
            ok: true,
            channels: [{ id: "C1" }],
            response_metadata: metadata,
          }),
        ),
      );
      const result = await adapter.read(
        { capability: "slack.channels.list", input: {} },
        tokens,
      );
      expect(result).toEqual({ items: [{ id: "C1" }] });
    }
  });

  it("maps thread reads to conversations.replies with exact channel and ts", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () =>
      json({
        ok: true,
        messages: [{ ts: "1.000", thread_ts: "1.000", text: "reply" }],
        response_metadata: { next_cursor: "thread-next" },
      }),
    );
    const adapter = slack(fetcher);
    const result = await adapter.read(
      {
        capability: "slack.thread.read",
        input: { channel: "C1", ts: "1.000" },
        cursor: "cursor-1",
      },
      tokens,
    );
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://slack.com/api/conversations.replies?channel=C1&ts=1.000&limit=100&cursor=cursor-1",
    );
    expect(result).toMatchObject({
      nextCursor: "thread-next",
      items: [{ ts: "1.000", text: "reply" }],
    });

    await expect(
      adapter.read(
        { capability: "slack.thread.read", input: { channel: "C1" } },
        tokens,
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "Slack ts is required.",
    });
    await expect(
      adapter.read(
        { capability: "slack.thread.read", input: { ts: "1.000" } },
        tokens,
      ),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "Slack channel is required.",
    });
  });

  it("keeps Slack timestamps opaque instead of parsing or reformatting them", async () => {
    const ts = "1512085950.000216";
    const adapter = slack(
      vi.fn(async () => json({ ok: true, messages: [{ ts, text: "opaque" }] })),
    );
    const result = await adapter.read(
      { capability: "slack.history.read", input: { channel: "C1" } },
      tokens,
    );
    expect(result.items[0]?.ts).toBe(ts);

    const item = normalizeSlackItem({
      id: `C1:${ts}`,
      kind: "message",
      channelId: "C1",
      channelName: "general",
      text: "opaque",
      timestamp: ts,
    });
    expect(item.freshness).toBe(ts);
    expect(item.providerMetadata).toMatchObject({ timestamp: ts });
  });

  it("propagates cancellation without retrying", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<ProviderFetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("cancelled", "AbortError");
    });
    const adapter = slack(fetcher);
    controller.abort();
    await expect(
      adapter.read(
        {
          capability: "slack.channels.list",
          input: {},
          signal: controller.signal,
        },
        tokens,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-object success body instead of treating it as an empty page", async () => {
    for (const body of [null, "ok", [], 42]) {
      const adapter = slack(vi.fn(async () => json(body)));
      await expect(
        adapter.read({ capability: "slack.channels.list", input: {} }, tokens),
      ).rejects.toMatchObject({
        code: "unknown",
        message: "Slack returned an invalid response.",
      });
    }
  });
});
