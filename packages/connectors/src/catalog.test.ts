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
