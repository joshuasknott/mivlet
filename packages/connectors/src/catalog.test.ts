import { describe, expect, it } from "vitest";
import {
  connectorCatalog,
  listSupportedConnectors,
  SUPPORTED_CONNECTOR_IDS
} from "./catalog";
import { LINEAR_OAUTH_SCOPES } from "./providers/linear";
import { SLACK_OAUTH_SCOPES } from "./providers/slack-api";
import { VERCEL_OAUTH_SCOPES } from "./providers/vercel";

describe("connector catalogue", () => {
  it("contains each supported provider exactly once", () => {
    const providerIds = connectorCatalog
      .filter((connector) => connector.id !== "local-files")
      .map((connector) => connector.id);
    expect(providerIds).toEqual(SUPPORTED_CONNECTOR_IDS);
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });

  it("fails closed until native configuration and authorization are proven", () => {
    for (const connector of connectorCatalog.filter(
      (candidate) => candidate.id !== "local-files"
    )) {
      expect(connector.status).toBe("unconfigured");
      expect(connector.supportsSearch).toBe(false);
      expect(connector.supportsImport).toBe(false);
      expect(connector.supportedActions).toEqual([]);
      expect(connector.authMode).not.toBe("none");
      expect(connector.scopes?.every((scope) => !scope.granted)).toBe(true);
    }
  });

  it("requests read-appropriate GitHub scopes and does not label write power as read", () => {
    const github = connectorCatalog.find((connector) => connector.id === "github");
    expect(github?.scopes?.map((scope) => scope.id)).toEqual(["read:user", "read:org"]);
    expect(github?.scopes?.some((scope) => scope.id === "repo" || scope.access !== "read")).toBe(
      false
    );
    const drive = connectorCatalog.find((connector) => connector.id === "google-drive");
    const driveFile = drive?.scopes?.find(
      (scope) => scope.id === "https://www.googleapis.com/auth/drive.file"
    );
    expect(driveFile?.access).toBe("write");
  });

  it("keeps write-capable Vercel, Linear, and Slack scopes only where native writes exist", () => {
    const vercel = connectorCatalog.find((connector) => connector.id === "vercel");
    const linear = connectorCatalog.find((connector) => connector.id === "linear");
    const slack = connectorCatalog.find((connector) => connector.id === "slack");
    const vercelWrite = vercel?.scopes?.find((scope) => scope.id === "deployment:write");
    const linearWrite = linear?.scopes?.find((scope) => scope.id === "write");
    const slackChat = slack?.scopes?.find((scope) => scope.id === "chat:write");
    const slackReactions = slack?.scopes?.find((scope) => scope.id === "reactions:write");

    expect(VERCEL_OAUTH_SCOPES).toEqual([
      "user:read",
      "team:read",
      "project:read",
      "deployment:read",
      "deployment:write"
    ]);
    expect(LINEAR_OAUTH_SCOPES).toEqual(["read", "write"]);
    expect(SLACK_OAUTH_SCOPES).toContain("chat:write");
    expect(SLACK_OAUTH_SCOPES).toContain("reactions:write");

    expect(vercelWrite).toMatchObject({ access: "write", required: false });
    expect(linearWrite).toMatchObject({ access: "write", required: false });
    expect(linear?.scopes?.map((scope) => scope.id)).toEqual(["read", "write"]);
    expect(linear?.scopes?.some((scope) => scope.id === "issues:create" || scope.id === "comments:create")).toBe(
      false
    );
    expect(slackChat).toMatchObject({ access: "write", required: false });
    expect(slackReactions).toMatchObject({ access: "write", required: false });
    expect(slack?.scopes?.filter((scope) => scope.access === "write").map((scope) => scope.id)).toEqual([
      "chat:write",
      "reactions:write"
    ]);
  });

  it("keeps explicit local files available without authentication", () => {
    expect(connectorCatalog.find((connector) => connector.id === "local-files"))
      .toMatchObject({ status: "connected", authMode: "none", supportsImport: true });
  });

  it("returns an isolated copy for shell state", () => {
    const first = listSupportedConnectors();
    const second = listSupportedConnectors();
    first[1].permissions.push("mutated");
    expect(second[1].permissions).not.toContain("mutated");
  });
});
