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
  prepareFixtureConnectorAction,
  searchFixtureConnector,
  shapeConnectorSearchRequest
} from "../index";

describe("first-wave connector registry", () => {
  it("keeps the seven stable connector ids in order", () => {
    expect(FIRST_WAVE_CONNECTOR_IDS).toEqual([
      "github",
      "vercel",
      "google-drive",
      "notion",
      "gmail",
      "slack",
      "google-calendar"
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
      })
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
});
