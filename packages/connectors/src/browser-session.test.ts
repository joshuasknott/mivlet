import type { BrowserSessionState, ConnectorActionRequest, ConnectorManifest } from "@fable/protocol";
import { describe, expect, it } from "vitest";
import {
  assertBrowserSessionMetadataSafe,
  canUseBrowserSession,
  createFixtureBrowserSession,
  createUnavailableBrowserSession,
  deriveBrowserSessionFromConnectors,
  labelFixtureSearchResult,
  resolveBrowserSessionAction
} from "./browser-session";
import { prepareFixtureConnectorAction, searchFixtureConnector } from "./providers/registry";

function connector(id: string, status: ConnectorManifest["status"]): ConnectorManifest {
  return {
    id,
    name: id,
    status,
    permissions: [],
    healthSummary: status,
    lastCheckedAt: "2026-07-02T00:00:00.000Z"
  };
}

function request(
  action: ConnectorActionRequest["action"] = "slack.create-draft",
  payload: Record<string, string> = { channelId: "C123", text: "Draft" }
): ConnectorActionRequest {
  return prepareFixtureConnectorAction(action, payload);
}

describe("browser session lifecycle", () => {
  it("reports unavailable when no live or fixture session exists", () => {
    const session = createUnavailableBrowserSession("No browser session.");
    expect(session.lifecycle).toBe("unavailable");
    expect(canUseBrowserSession(session, "github")).toMatchObject({
      ok: false,
      result: { status: "unavailable" }
    });
  });

  it("keeps fixture preview explicit and unavailable unless allowed", () => {
    const session = createFixtureBrowserSession(new Date("2026-07-02T10:00:00.000Z"));
    expect(session).toMatchObject({
      lifecycle: "active",
      source: "fixture-preview",
      fixtureOnly: true
    });
    expect(canUseBrowserSession(session, "slack")).toMatchObject({ ok: false });
    expect(canUseBrowserSession(session, "slack", { allowFixturePreview: true })).toEqual({ ok: true });

    const result = labelFixtureSearchResult(
      searchFixtureConnector({ connectorId: "slack", query: "", limit: 1 })
    );
    expect(result.source).toBe("fixture");
    expect(result.items[0].summary).toMatch(/^Preview data only:/);
    expect(result.items[0].providerMetadata.fixtureOnly).toBe("true");
  });

  it("derives active and expired live session states from connector manifests", () => {
    const active = deriveBrowserSessionFromConnectors([
      connector("github", "connected"),
      connector("slack", "needs-auth")
    ]);
    expect(active).toMatchObject({
      lifecycle: "active",
      source: "live",
      fixtureOnly: false,
      connectorIds: ["github"]
    });

    const expired = deriveBrowserSessionFromConnectors([
      connector("github", "expired"),
      connector("slack", "needs-auth")
    ]);
    expect(expired).toMatchObject({
      lifecycle: "expired",
      source: "live",
      fixtureOnly: false,
      connectorIds: ["github"]
    });
  });
});

describe("browser session action policy", () => {
  const fixtureSession = createFixtureBrowserSession(new Date("2026-07-02T10:00:00.000Z"), ["slack"]);

  it("turns denied actions into a no-op result", () => {
    const result = resolveBrowserSessionAction({
      session: fixtureSession,
      action: request(),
      decision: "deny",
      allowFixturePreview: true
    });
    expect(result).toMatchObject({
      status: "denied",
      message: "The action was denied. Nothing ran."
    });
  });

  it("completes approved scoped actions inside the explicit fixture session", () => {
    const result = resolveBrowserSessionAction({
      session: fixtureSession,
      action: request(),
      decision: "once",
      permissionMode: "trusted-scope",
      allowFixturePreview: true
    });
    expect(result).toMatchObject({
      status: "completed",
      message: "Preview action completed with fixture data only. No live provider changed."
    });
  });

  it("blocks approved writes when the active permission profile forbids them", () => {
    const result = resolveBrowserSessionAction({
      session: fixtureSession,
      action: request("slack.post"),
      decision: "once",
      permissionMode: "read-only",
      allowFixturePreview: true
    });
    expect(result.status).toBe("denied");
    expect(result.message).toMatch(/Read-only/);
  });

  it("rejects secret-shaped browser session metadata", () => {
    const leaky = {
      ...fixtureSession,
      token: "sk-test-secret"
    } as BrowserSessionState & { token: string };
    expect(() => assertBrowserSessionMetadataSafe(leaky)).toThrow(/prohibited field/i);
    expect(JSON.stringify(fixtureSession).toLowerCase()).not.toMatch(
      /cookie|token|secret|screenshot|clipboard|pagetext|localstorage|sessionstorage/
    );
  });
});
