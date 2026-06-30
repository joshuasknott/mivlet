import { describe, expect, it } from "vitest";
import {
  FIRST_WAVE_CONNECTOR_IDS,
  importFixtureConnectorItem,
  listFirstWaveConnectors,
  mapGmailError,
  mapGitHubError,
  normalizeGmailItem,
  normalizeGitHubItem,
  normalizeGoogleCalendarItem,
  normalizeGoogleDriveItem,
  normalizeNotionItem,
  normalizeSlackItem,
  normalizeVercelItem,
  prepareGoogleCalendarDelete,
  prepareGoogleDriveAction,
  prepareFixtureConnectorAction,
  googleConnectorPermissions,
  googleHealthFromLifecycle,
  googleReconnectMessage,
  googleScopeIds,
  googleStatusFromLifecycle,
  mergeGoogleTokenRefresh,
  resolveGoogleLifecycleState,
  searchFixtureConnector,
  shapeConnectorSearchRequest
} from "../index";

describe("first-wave connector registry", () => {
  it("keeps the stable connector ids in order", () => {
    expect(FIRST_WAVE_CONNECTOR_IDS).toEqual([
      "github",
      "vercel",
      "google-drive",
      "notion",
      "gmail",
      "slack",
      "google-calendar",
      "linear"
    ]);
    expect(listFirstWaveConnectors().map((connector) => connector.id)).toEqual(
      FIRST_WAVE_CONNECTOR_IDS
    );
  });

  it("includes honest fixture auth, health, permissions, and setup metadata", () => {
    for (const connector of listFirstWaveConnectors()) {
      expect(connector.status).toBe("fixture");
      expect(connector.authMode).toBeTruthy();
      expect(connector.health?.state).toBe("unknown");
      expect(connector.scopes?.length).toBeGreaterThan(0);
      expect(connector.setupMessage).toBeTruthy();
      expect(connector.account).toBeUndefined();
    }
  });
});

describe("provider normalizers", () => {
  it("normalizes provider payloads into untrusted Fable search items", () => {
    const items = [
      normalizeGitHubItem({
        id: 1,
        kind: "repository",
        name: "fable",
        repository: "acme/fable"
      }),
      normalizeVercelItem({
        id: "deployment-1",
        kind: "deployment",
        name: "fable-preview",
        team: "Acme",
        state: "READY"
      }),
      normalizeGoogleDriveItem({
        id: "drive-1",
        name: "Brief",
        mimeType: "application/vnd.google-apps.document",
        selected: true
      }),
      normalizeNotionItem({
        id: "notion-1",
        object: "page",
        title: "Plan",
        workspace: "Acme"
      }),
      normalizeGmailItem({
        id: "message-1",
        threadId: "thread-1",
        subject: "Review",
        from: "sender@example.invalid",
        snippet: "Synthetic message"
      }),
      normalizeSlackItem({
        id: "slack-1",
        kind: "message",
        channelId: "C_FIXTURE",
        channelName: "product",
        text: "Synthetic message"
      }),
      normalizeGoogleCalendarItem({
        id: "event-1",
        kind: "event",
        title: "Review",
        calendarId: "fixture-primary"
      }),
      searchFixtureConnector({
        connectorId: "linear",
        query: "",
        limit: 1
      }).items[0]
    ];

    expect(items.map((item) => item.connectorId)).toEqual(FIRST_WAVE_CONNECTOR_IDS);
    expect(items.every((item) => item.trust === "untrusted")).toBe(true);
    expect(items.every((item) => Object.keys(item.providerMetadata).length > 0)).toBe(true);
  });

  it("shapes bounded search requests and returns fixture search results", () => {
    const request = shapeConnectorSearchRequest("gmail", " release ", 500);
    expect(request).toMatchObject({ connectorId: "gmail", query: "release", limit: 50 });

    const result = searchFixtureConnector(request);
    expect(result.source).toBe("fixture");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].connectorId).toBe("gmail");
  });

  it("bounds direct fixture searches and overlong Unicode queries", () => {
    const query = "😀".repeat(501);
    expect(shapeConnectorSearchRequest("github", query, Number.NaN)).toMatchObject({
      limit: 20,
      query: "😀".repeat(500)
    });
    expect(
      searchFixtureConnector({ connectorId: "github", query: "", limit: -10 }).items
    ).toHaveLength(1);
  });

  it("imports external content as an untrusted KnowledgeSource", () => {
    const item = searchFixtureConnector({
      connectorId: "google-drive",
      query: "",
      limit: 5
    }).items[0];
    const imported = importFixtureConnectorItem({
      connectorId: "google-drive",
      item,
      importedAt: "2026-06-27T10:00:00.000Z"
    });

    expect(imported.source).toMatchObject({
      connectorId: "google-drive",
      origin: "connector-import",
      trust: "untrusted",
      pinned: false
    });
    expect(imported.source.providerMetadata?.selected).toBe("true");
  });

  it("rejects cross-provider and unselected Drive imports", () => {
    const item = normalizeGoogleDriveItem({
      id: "drive-unselected",
      name: "Unselected",
      mimeType: "text/plain",
      selected: false
    });
    const request = {
      connectorId: "google-drive" as const,
      item,
      importedAt: "2026-06-27T10:00:00.000Z"
    };

    expect(() =>
      importFixtureConnectorItem({ ...request, connectorId: "notion" })
    ).toThrow(/does not match/i);
    expect(() => importFixtureConnectorItem(request)).toThrow(/explicitly selected/i);
  });

  it("maps project and database imports to folder knowledge", () => {
    const imported = importFixtureConnectorItem({
      connectorId: "vercel",
      item: normalizeVercelItem({
        id: "project-1",
        kind: "project",
        name: "Fable",
        team: "Acme"
      }),
      importedAt: "2026-06-27T10:00:00.000Z"
    });

    expect(imported.source.kind).toBe("folder");
  });
});

describe("provider error and action boundaries", () => {
  it("maps provider failures without returning raw provider content", () => {
    expect(mapGitHubError({ status: 429, code: "secondary_rate_limit" })).toMatchObject({
      code: "rate-limited",
      retryable: true
    });
    expect(mapGmailError({ status: 401, code: "expired_token" })).toMatchObject({
      code: "expired-auth",
      retryable: false
    });
    expect(mapGmailError({ status: 429, code: "token_bucket_exhausted" })).toMatchObject({
      code: "rate-limited",
      retryable: true
    });
  });

  it("routes drafts and consequential actions through ApprovalRequest", () => {
    const draft = prepareFixtureConnectorAction("gmail.create-draft", {
      to: "recipient@example.invalid"
    });
    expect(draft.approval).toMatchObject({
      service: "Gmail",
      mode: "trusted-scope",
      riskLevel: "medium"
    });
    expect(draft.approval.consequence).toMatch(/does not send/i);

    const send = prepareFixtureConnectorAction("gmail.send", {
      targetId: "fixture-draft"
    });
    expect(send.approval).toMatchObject({
      mode: "full-access",
      riskLevel: "high",
      confirmationPhrase: "send email"
    });

    const post = prepareFixtureConnectorAction("slack.post", { channelId: "C_FIXTURE" });
    expect(post.approval.confirmationPhrase).toBe("post message");
  });

  it("prepares Google Drive mutations with native policy metadata", () => {
    const share = prepareGoogleDriveAction("google-drive.share-file", {
      fileId: "file-1",
      recipient: "recipient@example.invalid",
      role: "reader"
    });
    expect(share.approval).toMatchObject({
      service: "Google Drive",
      mode: "full-access",
      riskLevel: "high",
      consequence: "Shares the selected Google Drive item with an external recipient.",
      confirmationPhrase: "share drive file"
    });

    const rename = prepareGoogleDriveAction("google-drive.rename-file", {
      fileId: "file-1",
      name: "Updated name"
    });
    expect(rename.approval).toMatchObject({
      mode: "trusted-scope",
      riskLevel: "medium",
      consequence: "Renames the selected Google Drive item after explicit approval."
    });
    expect(rename.approval.confirmationPhrase).toBeUndefined();
  });

  it("prepares Google Calendar deletion with per-action confirmation", () => {
    const action = prepareGoogleCalendarDelete({
      calendarId: "primary",
      eventId: "event-1",
      title: "Review"
    });
    expect(action.approval).toMatchObject({
      service: "Google Calendar",
      mode: "full-access",
      riskLevel: "high",
      consequence: "Deletes or cancels the selected calendar event after explicit approval.",
      confirmationPhrase: "delete calendar event"
    });
  });
});

describe("shared Google connector lifecycle", () => {
  it("defines service-specific scope boundaries behind a shared Google identity grant", () => {
    expect(googleScopeIds("google-drive")).toContain("openid");
    expect(googleScopeIds("google-drive")).toContain("https://www.googleapis.com/auth/drive.file");
    expect(googleScopeIds("gmail")).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(googleScopeIds("google-calendar")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(googleConnectorPermissions("gmail").map((scope) => scope.label)).toEqual([
      "Read mail",
      "Create drafts",
      "Send approved mail"
    ]);
  });

  it("preserves existing refresh tokens and scopes when Google omits them during refresh", () => {
    expect(mergeGoogleTokenRefresh(
      {
        accessToken: "old-access",
        refreshToken: "keep-refresh",
        tokenType: "Bearer",
        expiresAt: "2026-07-01T00:00:00.000Z",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"]
      },
      {
        accessToken: "new-access",
        tokenType: "Bearer",
        expiresAt: "2026-07-01T01:00:00.000Z",
        scopes: []
      }
    )).toMatchObject({
      accessToken: "new-access",
      refreshToken: "keep-refresh",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"]
    });
  });

  it("maps connected, stale, expired, revoked, and partial-failure states without token data", () => {
    const base = {
      connectorId: "google-calendar" as const,
      account: { id: "google-sub", displayName: "Google User" },
      grantedScopes: googleScopeIds("google-calendar"),
      expiresAt: "2026-07-01T00:00:00.000Z",
      lastCheckedAt: "2026-06-30T12:00:00.000Z"
    };

    expect(resolveGoogleLifecycleState(base, Date.parse("2026-06-30T12:00:00.000Z"))).toBe("connected");
    expect(resolveGoogleLifecycleState({ ...base, grantedScopes: ["openid"] })).toBe("stale");
    expect(resolveGoogleLifecycleState(base, Date.parse("2026-07-01T00:00:01.000Z"))).toBe("expired");
    expect(resolveGoogleLifecycleState({ ...base, revokedAt: "2026-06-30T12:01:00.000Z" })).toBe("revoked");
    expect(resolveGoogleLifecycleState({
      ...base,
      lastError: {
        code: "provider-unavailable",
        connectorId: "google-calendar",
        message: "Google Calendar unavailable.",
        retryable: true
      }
    })).toBe("partial-failure");

    expect(googleStatusFromLifecycle("configuration-required")).toBe("unavailable");
    expect(googleHealthFromLifecycle("google-calendar", "partial-failure", base.lastCheckedAt)).toMatchObject({
      state: "degraded"
    });
    expect(googleReconnectMessage("gmail")).toMatch(/Reconnect Gmail/);
  });
});
