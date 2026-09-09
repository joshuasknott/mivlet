import { describe, expect, it } from "vitest";
import { remoteConnectors, remoteConnectorServerId } from "./remote-connectors";
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
});
