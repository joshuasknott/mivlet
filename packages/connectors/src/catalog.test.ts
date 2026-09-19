import { describe, expect, it } from "vitest";
import {
  connectorCatalog,
  listSupportedConnectors,
  SUPPORTED_CONNECTOR_IDS
} from "./catalog";

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
    expect(github?.scopes?.every((scope) => scope.required && scope.access === "read")).toBe(true);
    expect(github?.scopes?.some((scope) => scope.id === "repo")).toBe(false);
    expect(github?.setupMessage).toMatch(/classic GitHub OAuth App/i);
    expect(github?.setupMessage).not.toMatch(/GitHub App with read-only repository permissions/i);
    expect(github?.permissions.join(" ")).toMatch(/private repositories are not granted/i);
    expect(github?.permissions.join(" ")).not.toMatch(/GitHub App/i);
    const drive = connectorCatalog.find((connector) => connector.id === "google-drive");
    const driveFile = drive?.scopes?.find(
      (scope) => scope.id === "https://www.googleapis.com/auth/drive.file"
    );
    expect(driveFile?.access).toBe("write");
  });

  it("does not list Notion console capabilities as OAuth scope ids", () => {
    const notion = connectorCatalog.find((connector) => connector.id === "notion");
    expect(notion?.scopes).toEqual([]);
    expect(notion?.setupMessage).toMatch(/does not take OAuth scope query parameters/i);
  });

  it("keeps write-capable Vercel, Linear, and Slack scopes required on Connect", () => {
    const vercel = connectorCatalog.find((connector) => connector.id === "vercel");
    const linear = connectorCatalog.find((connector) => connector.id === "linear");
    const slack = connectorCatalog.find((connector) => connector.id === "slack");
    const vercelWrite = vercel?.scopes?.find((scope) => scope.id === "deployment:write");
    const linearWrite = linear?.scopes?.find((scope) => scope.id === "write");
    const slackChat = slack?.scopes?.find((scope) => scope.id === "chat:write");
    const slackReactions = slack?.scopes?.find((scope) => scope.id === "reactions:write");

    expect(vercel?.scopes?.map((scope) => scope.id)).toEqual([
      "project:read",
      "deployment:read",
      "deployment:write"
    ]);
    expect(linear?.scopes?.map((scope) => scope.id)).toEqual(["read", "write"]);
    expect(slack?.scopes?.map((scope) => scope.id)).toEqual([
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "mpim:read",
      "users:read",
      "chat:write",
      "reactions:write"
    ]);

    expect(vercelWrite).toMatchObject({ access: "write", required: true });
    expect(linearWrite).toMatchObject({ access: "write", required: true });
    expect(linear?.scopes?.map((scope) => scope.id)).toEqual(["read", "write"]);
    expect(linear?.scopes?.some((scope) => scope.id === "issues:create" || scope.id === "comments:create")).toBe(
      false
    );
    expect(slackChat).toMatchObject({ access: "write", required: true });
    expect(slackReactions).toMatchObject({ access: "write", required: true });
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
