import { describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";
import { ConnectorRuntime, type ConnectorApprovalBoundary } from "../sdk";
import { createGoogleDriveAdapter, GOOGLE_DRIVE_CAPABILITIES } from "./google-drive";
import { createGmailAdapter, GMAIL_CAPABILITIES } from "./gmail";
import {
  createGoogleCalendarAdapter,
  GOOGLE_CALENDAR_CAPABILITIES
} from "./google-calendar";

const tokens: ConnectorTokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  scopes: [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.events"
  ]
};
// Google uses public PKCE directly against accounts.google.com; the adapter
// supplies default auth base URLs, so only the OAuth client id + redirect uri
// are required. Tests never exercise real network.
const common = {
  clientId: "google-client",
  redirectUri: "http://127.0.0.1:43123/callback"
};

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fetchCall(fetcher: unknown, index = 0): [string, RequestInit?] {
  return ((fetcher as { mock: { calls: unknown[] } }).mock.calls[index] ?? []) as [string, RequestInit?];
}

function fetchUrl(fetcher: unknown, index = 0): string {
  return String(fetchCall(fetcher, index)[0]);
}

function fetchInit(fetcher: unknown, index = 0): RequestInit {
  return fetchCall(fetcher, index)[1] ?? {};
}

describe("Google Drive production adapter", () => {
  it("starts direct PKCE with the minimum default Drive scopes", async () => {
    const adapter = createGoogleDriveAdapter({ ...common, fetch: vi.fn() });
    const started = await adapter.startAuth({
      redirectUri: common.redirectUri,
      state: "state-1",
      codeChallenge: "challenge-1"
    });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file"
    ]);
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("maps file reads, nextPageToken pagination, and rate limits", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          files: [
            { id: "file-1", name: "Roadmap.gdoc", mimeType: "application/vnd.google-apps.document" }
          ],
          nextPageToken: "page-2"
        },
        200,
        { "x-ratelimit-remaining": "98", "x-ratelimit-reset": "1782600000" }
      )
    );
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "drive.search", input: { query: "roadmap", limit: 5 } },
      tokens
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/drive\/v3\/files/),
      expect.objectContaining({ method: "GET" })
    );
    // The query string should carry the search term, page size, and fields mask.
    const calledUrl = fetchUrl(fetcher);
    expect(calledUrl).toContain("q=roadmap");
    expect(calledUrl).toContain("pageSize=5");
    expect(result).toMatchObject({ nextCursor: "page-2", rateLimit: { remaining: 98 } });
    expect(result.items[0]).toMatchObject({ id: "file-1", name: "Roadmap.gdoc" });
  });

  it("reads a single file's metadata when a fileId is supplied", async () => {
    const fetcher = vi.fn(async () =>
      response({ id: "file-9", name: "Notes.md", mimeType: "text/markdown" })
    );
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "drive.read", input: { fileId: "file-9" } },
      tokens
    );
    expect(fetchUrl(fetcher)).toContain("files/file-9");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "file-9" });
  });

  it("redacts permission and ACL detail from file objects", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "file-1",
        name: "Shared.gdoc",
        mimeType: "application/vnd.google-apps.document",
        permissions: [{ id: "p1", emailAddress: "collaborator@example.com", role: "writer" }],
        owners: [{ displayName: "Owner", emailAddress: "owner@example.com" }],
        permissionIds: ["p1", "p2"]
      })
    );
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "drive.read", input: { fileId: "file-1" } }, tokens);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("collaborator@example.com");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("permissionIds");
  });

  it("maps permission, expired access, rate limit, and network errors", async () => {
    for (const [status, code] of [
      [401, "expired-auth"],
      [403, "permission-denied"],
      [429, "rate-limited"]
    ] as const) {
      const adapter = createGoogleDriveAdapter({
        ...common,
        fetch: vi.fn(async () => response({ error: "secret provider detail" }, status))
      });
      await expect(
        adapter.read({ capability: "drive.search", input: {} }, tokens)
      ).rejects.toMatchObject({ code });
    }
    const network = createGoogleDriveAdapter({
      ...common,
      fetch: vi.fn(async () => {
        throw new Error("socket and token details");
      })
    });
    await expect(
      network.read({ capability: "drive.search", input: {} }, tokens)
    ).rejects.toMatchObject({ code: "provider-unavailable" });
    const malformed = createGoogleDriveAdapter({
      ...common,
      fetch: vi.fn(async () => new Response("not-json", { status: 200 }))
    });
    await expect(
      malformed.read({ capability: "drive.search", input: {} }, tokens)
    ).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("passes cancellation to provider egress", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("cancelled", "AbortError");
    });
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    await expect(
      adapter.read({ capability: "drive.search", input: {}, signal: controller.signal }, tokens)
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles unconfigured/expired refresh tokens", async () => {
    const adapter = createGoogleDriveAdapter(common);
    await expect(adapter.refresh({ accessToken: "access", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth",
      message: expect.stringContaining("expired")
    });
  });

  it("refreshes directly against Google's OAuth2 token endpoint (public PKCE)", async () => {
    const fetcher = vi.fn(async () =>
      response({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.readonly"
      })
    );
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const refreshed = await adapter.refresh({ accessToken: "old", refreshToken: "old-refresh", tokenType: "Bearer", scopes: [] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" })
    );
    const body = String(fetchInit(fetcher).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
    expect(body).toContain("client_id=google-client");
    expect(refreshed).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("revokes directly against Google's OAuth2 revocation endpoint", async () => {
    const fetcher = vi.fn(async () => response(undefined, 200));
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    await expect(
      adapter.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" })
    );
    const body = String(fetchInit(fetcher).body);
    expect(body).toContain("token=refresh");
    expect(body).toContain("token_type_hint=refresh_token");

    // 404 is idempotent success.
    const fetcher404 = vi.fn(async () => response(undefined, 404));
    const adapter404 = createGoogleDriveAdapter({ ...common, fetch: fetcher404 });
    await expect(
      adapter404.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] })
    ).resolves.toBeUndefined();
  });

  it("completes public-PKCE authorization by exchanging the code directly", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/drive.readonly"
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return response({ sub: "user-1", name: "Test User", email: "test@example.com" });
      }
      return response({}, 404);
    });
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const callbackUrl = "http://127.0.0.1:43123/callback?state=state-xyz&code=auth-code-123";
    const result = await adapter.completeAuth({ callbackUrl, expectedState: "state-xyz", codeVerifier: "verifier-abc" });
    const exchangeBody = String(fetchInit(fetcher).body);
    expect(exchangeBody).toContain("grant_type=authorization_code");
    expect(exchangeBody).toContain("code=auth-code-123");
    expect(exchangeBody).toContain("code_verifier=verifier-abc");
    expect(result.tokens.accessToken).toBe("access-1");
    expect(result.account).toMatchObject({ id: "user-1", displayName: "Test User" });
  });

  it("does not infer granted scopes when Google omits the scope field", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return response({ sub: "user-1", email: "test@example.com" });
      }
      return response({}, 404);
    });
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const result = await adapter.completeAuth({
      callbackUrl: "http://127.0.0.1:43123/callback?state=state-xyz&code=auth-code-123",
      expectedState: "state-xyz",
      codeVerifier: "verifier-abc"
    });
    expect(result.tokens.scopes).toEqual([]);
    await expect(adapter.read(
      { capability: "drive.search", input: {} },
      result.tokens
    )).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects callback substitution and missing scopes before provider egress", async () => {
    const fetcher = vi.fn(async () => response({}));
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    await expect(adapter.completeAuth({
      callbackUrl: "http://127.0.0.1:43124/callback?state=state-1&code=code-1",
      expectedState: "state-1",
      codeVerifier: "verifier-1"
    })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(adapter.read(
      { capability: "drive.search", input: {} },
      { accessToken: "access", tokenType: "Bearer", scopes: [] }
    )).rejects.toMatchObject({ code: "permission-denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves refresh tokens but not historical scopes when Google omits scope", async () => {
    const fetcher = vi.fn(async () => response({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600
    }));
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    await expect(adapter.refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      scopes: ["https://www.googleapis.com/auth/drive.file"]
    })).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      scopes: []
    });
  });

  it("ensures errors do not leak sensitive details in user-facing messages", async () => {
    const fetcher = vi.fn(async () =>
      response({ error: "invalid_grant", message: "token secret-google-abc is invalid" }, 400)
    );
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const errPromise = adapter.read({ capability: "drive.search", input: {} }, tokens);
    await expect(errPromise).rejects.toMatchObject({ code: "invalid-request" });
    const err = await errPromise.catch((e) => e);
    expect(err.message).not.toContain("secret-google-abc");
    expect(err.message).toBe("The provider rejected the request.");
  });
});

describe("Gmail production adapter", () => {
  it("maps message list reads, nextPageToken pagination, and rate limits", async () => {
    const fetcher = vi.fn(async () =>
      response(
        { messages: [{ id: "msg-1", threadId: "thread-1" }], nextPageToken: "page-2", resultSizeEstimate: 100 },
        200,
        { "x-ratelimit-remaining": "200", "x-ratelimit-reset": "1782600000" }
      )
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "gmail.search", input: { query: "from:boss", limit: 10 } },
      tokens
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/gmail\/v1\/users\/me\/messages/),
      expect.objectContaining({ method: "GET" })
    );
    const calledUrl = fetchUrl(fetcher);
    expect(calledUrl).toContain("q=from");
    expect(calledUrl).toContain("maxResults=10");
    expect(result).toMatchObject({ nextCursor: "page-2", rateLimit: { remaining: 200 } });
    expect(result.items[0]).toMatchObject({ id: "msg-1", threadId: "thread-1" });
  });

  it("reads a single message with metadata format when a messageId is supplied", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "msg-7",
        threadId: "thread-7",
        snippet: "Quick sync tomorrow",
        payload: { headers: [{ name: "Subject", value: "Sync" }] }
      })
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "gmail.read", input: { messageId: "msg-7" } },
      tokens
    );
    const calledUrl = fetchUrl(fetcher);
    expect(calledUrl).toContain("messages/msg-7");
    expect(calledUrl).toContain("format=metadata");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "msg-7", snippet: "Quick sync tomorrow" });
  });

  it("redacts raw payload bytes from message objects (no full bodies persisted)", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "msg-1",
        threadId: "thread-1",
        snippet: "preview only",
        raw: "U3VwZXIgcHJpdmF0ZSByYXcgYm9keSBjb250ZW50",
        payload: { parts: [{ body: { data: "secret" } }] },
        sizeEstimate: 4096
      })
    );
    const adapter = createGmailAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "gmail.read", input: { messageId: "msg-1" } }, tokens);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("U3VwZXIgcHJpdmF0ZSByYXcgYm9keSBjb250ZW50");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("sizeEstimate");
    expect(serialized).toContain("snippet");
  });

  it("maps permission, expired access, rate limit, and network errors", async () => {
    for (const [status, code] of [
      [401, "expired-auth"],
      [403, "permission-denied"],
      [429, "rate-limited"]
    ] as const) {
      const adapter = createGmailAdapter({
        ...common,
        fetch: vi.fn(async () => response({ error: "detail" }, status))
      });
      await expect(
        adapter.read({ capability: "gmail.search", input: {} }, tokens)
      ).rejects.toMatchObject({ code });
    }
    const network = createGmailAdapter({
      ...common,
      fetch: vi.fn(async () => {
        throw new Error("network down");
      })
    });
    await expect(
      network.read({ capability: "gmail.search", input: {} }, tokens)
    ).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("handles unconfigured/expired refresh tokens and revokes directly", async () => {
    const adapter = createGmailAdapter(common);
    await expect(adapter.refresh({ accessToken: "access", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth"
    });
    const fetcher = vi.fn(async () => response(undefined, 200));
    const revoker = createGmailAdapter({ ...common, fetch: fetcher });
    await revoker.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("Google Calendar production adapter", () => {
  it("maps calendar list reads, nextPageToken pagination, and rate limits", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          items: [{ id: "cal-1@group.calendar.google.com", summary: "Work" }],
          nextPageToken: "page-2"
        },
        200,
        { "x-ratelimit-remaining": "500" }
      )
    );
    const adapter = createGoogleCalendarAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "calendar.list", input: { limit: 25 } },
      tokens
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/calendar\/v3\/users\/me\/calendarList/),
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchUrl(fetcher)).toContain("maxResults=25");
    expect(result).toMatchObject({ nextCursor: "page-2", rateLimit: { remaining: 500 } });
    expect(result.items[0]).toMatchObject({ id: "cal-1@group.calendar.google.com", summary: "Work" });
  });

  it("lists events for a calendar with singleEvents expansion and time bounds", async () => {
    const fetcher = vi.fn(async () =>
      response({
        items: [{ id: "evt-1", summary: "Standup", status: "confirmed" }],
        nextPageToken: "page-3"
      })
    );
    const adapter = createGoogleCalendarAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      {
        capability: "calendar.read",
        input: {
          calendarId: "primary",
          timeMin: "2026-06-01T00:00:00Z",
          timeMax: "2026-07-01T00:00:00Z"
        }
      },
      tokens
    );
    const calledUrl = fetchUrl(fetcher);
    expect(calledUrl).toContain("calendars/primary/events");
    expect(calledUrl).toContain("singleEvents=true");
    expect(calledUrl).toContain("orderBy=startTime");
    expect(calledUrl).toContain("timeMin=2026-06-01");
    expect(result).toMatchObject({ nextCursor: "page-3" });
  });

  it("reads a single event when an eventId is supplied", async () => {
    const fetcher = vi.fn(async () =>
      response({ id: "evt-9", summary: "1:1", status: "confirmed" })
    );
    const adapter = createGoogleCalendarAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "calendar.read", input: { calendarId: "primary", eventId: "evt-9" } },
      tokens
    );
    expect(fetchUrl(fetcher)).toContain("calendars/primary/events/evt-9");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "evt-9", summary: "1:1" });
  });

  it("redacts conference data and attendee emails from event objects", async () => {
    const fetcher = vi.fn(async () =>
      response({
        id: "evt-1",
        summary: "Standup",
        attendees: [
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
          { email: "bob@example.com", displayName: "Bob", responseStatus: "needsAction" }
        ],
        conferenceData: { entryPoints: [{ uri: "https://meet.google.com/secret-meeting" }] },
        hangoutLink: "https://meet.google.com/secret-meeting"
      })
    );
    const adapter = createGoogleCalendarAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read(
      { capability: "calendar.read", input: { calendarId: "primary", eventId: "evt-1" } },
      tokens
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("bob@example.com");
    expect(serialized).not.toContain("conferenceData");
    expect(serialized).not.toContain("hangoutLink");
    expect(serialized).not.toContain("secret-meeting");
    // Display names and response status are preserved.
    expect(serialized).toContain("Alice");
    expect(serialized).toContain("responseStatus");
  });

  it("maps permission, expired access, rate limit, and network errors", async () => {
    for (const [status, code] of [
      [401, "expired-auth"],
      [403, "permission-denied"],
      [429, "rate-limited"]
    ] as const) {
      const adapter = createGoogleCalendarAdapter({
        ...common,
        fetch: vi.fn(async () => response({ error: "detail" }, status))
      });
      await expect(
        adapter.read({ capability: "calendar.list", input: {} }, tokens)
      ).rejects.toMatchObject({ code });
    }
    const network = createGoogleCalendarAdapter({
      ...common,
      fetch: vi.fn(async () => {
        throw new Error("network down");
      })
    });
    await expect(
      network.read({ capability: "calendar.list", input: {} }, tokens)
    ).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("handles unconfigured/expired refresh tokens and revokes directly", async () => {
    const adapter = createGoogleCalendarAdapter(common);
    await expect(adapter.refresh({ accessToken: "access", tokenType: "Bearer", scopes: [] })).rejects.toMatchObject({
      code: "expired-auth"
    });
    const fetcher = vi.fn(async () => response(undefined, 200));
    const revoker = createGoogleCalendarAdapter({ ...common, fetch: fetcher });
    await revoker.revoke({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", scopes: [] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("google connector capability and approval registration", () => {
  it("registers complete, unique read/write capability sets", () => {
    for (const capabilities of [GOOGLE_DRIVE_CAPABILITIES, GMAIL_CAPABILITIES, GOOGLE_CALENDAR_CAPABILITIES]) {
      expect(new Set(capabilities.map((capability) => capability.id)).size).toBe(capabilities.length);
      expect(capabilities.some((capability) => capability.kind === "read")).toBe(true);
      expect(
        capabilities.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)
      ).toBe(true);
    }
  });

  it("cannot execute a Drive write without a matching explicit approval", async () => {
    const fetcher = vi.fn(async () => response({ id: "file-1" }));
    const adapter = createGoogleDriveAdapter({ ...common, fetch: fetcher });
    const boundary: ConnectorApprovalBoundary = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({
        ...record,
        result: "denied" as const,
        decidedAt: new Date().toISOString()
      })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals: boundary });
    runtime.register(adapter);
    await expect(
      runtime.write(
        { connectorId: "google-drive", account: { id: "u1", displayName: "User" }, tokens },
        {
          capability: "google-drive.delete-file",
          input: { fileId: "file-1" },
          target: "file-1",
          preview: "Delete file-1",
          riskLevel: "high"
        }
      )
    ).rejects.toMatchObject({ code: "approval-required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("isolates per-service failures: a Gmail error does not affect Drive state", async () => {
    // Two separate adapters with independent HTTP clients. A failing Gmail
    // read must not throw into or corrupt a Drive read running against its
    // own client.
    const driveFetcher = vi.fn(async () => response({ id: "file-1", name: "ok.md" }));
    const gmailFetcher = vi.fn(async () => response({ error: "blocked" }, 403));
    const drive = createGoogleDriveAdapter({ ...common, fetch: driveFetcher });
    const gmail = createGmailAdapter({ ...common, fetch: gmailFetcher });

    const driveResult = drive.read({ capability: "drive.read", input: { fileId: "file-1" } }, tokens);
    const gmailResult = gmail.read({ capability: "gmail.search", input: {} }, tokens);

    await expect(driveResult).resolves.toMatchObject({ items: [{ id: "file-1" }] });
    await expect(gmailResult).rejects.toMatchObject({ code: "permission-denied" });
  });
});

describe.skipIf(!process.env.FABLE_LIVE_CONNECTOR_TESTS)("opt-in live google connectors", () => {
  it("requires deliberately supplied credentials and expected scope claims", () => {
    expect(process.env.FABLE_LIVE_CONNECTOR_TESTS).toBeTruthy();
    expect(
      process.env.FABLE_GOOGLE_TEST_TOKEN
    ).toBeTruthy();
    expect(
      process.env.FABLE_GOOGLE_TEST_EXPECTED_SCOPES
    ).toBeTruthy();
  });

  it("validates the supplied token's active granted scopes without running OAuth", async () => {
    const token = process.env.FABLE_GOOGLE_TEST_TOKEN;
    const expectedScopes = (process.env.FABLE_GOOGLE_TEST_EXPECTED_SCOPES ?? "")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    expect(token).toBeTruthy();
    expect(expectedScopes.length).toBeGreaterThan(0);

    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token!)}`);
    expect(response.ok).toBe(true);
    const body = await response.json() as { scope?: string; email?: string };
    const granted = new Set((body.scope ?? "").split(/\s+/).filter(Boolean));
    for (const scope of expectedScopes) {
      expect(granted.has(scope)).toBe(true);
    }
    if (process.env.FABLE_GOOGLE_TEST_EMAIL) {
      expect(body.email).toBe(process.env.FABLE_GOOGLE_TEST_EMAIL);
    }
  });
});
