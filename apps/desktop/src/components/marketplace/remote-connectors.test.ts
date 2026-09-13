import { describe, expect, it } from "vitest";
import { remoteConnectorFor, remoteConnectorServerId, remoteConnectors, retiredRemoteConnectorServerIds } from "./remote-connectors";
import { findMarketplaceConnector } from "./marketplace-catalog";

describe("official connection routes", () => {
  it("maps every route to an existing directory entry and a unique stable configuration", () => {
    expect(new Set(remoteConnectors.map((preset) => remoteConnectorServerId(preset.id))).size).toBe(remoteConnectors.length);
    for (const preset of remoteConnectors) expect(findMarketplaceConnector(preset.id)).toBeDefined();
  });
  it("uses public credential-free HTTPS endpoints", () => {
    for (const preset of remoteConnectors) {
      for (const endpoint of [preset.endpoint, preset.documentation]) {
        const url = new URL(endpoint);
        expect(url.protocol).toBe("https:");
        expect(url.username + url.password + url.search + url.hash).toBe("");
      }
    }
  });
  it("points the verified Atlassian Rovo route at the provider's current MCP endpoint", () => {
    expect(remoteConnectorFor("atlassian-rovo")).toMatchObject({
      name: "Atlassian Rovo",
      endpoint: "https://mcp.atlassian.com/v2/mcp",
      documentation: "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started",
    });
  });
  it("ignores the retired Todoist route without reusing another configuration", () => {
    expect(remoteConnectorFor("todoist")).toBeUndefined();
    expect(retiredRemoteConnectorServerIds).toContain("marketplace-todoist");
    for (const preset of remoteConnectors) expect(remoteConnectorServerId(preset.id)).not.toBe("marketplace-todoist");
  });
});
