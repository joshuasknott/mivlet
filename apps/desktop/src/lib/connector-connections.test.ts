import { describe, expect, it } from "vitest";
import type { ConnectorManifest } from "@fable/protocol";
import type { RuntimeMcpConnectionDetails } from "../runtime";
import { mergeConnectorConnections, remoteConnectionReady } from "./connector-connections";

const remote = { connectionId: "remote", launchReference: "marketplace-notion", authorizationState: "authorized", credentialState: "available", healthState: "healthy", discoveryState: "discovered", discoveredTools: ["search"], enabledTools: ["search"] } as RuntimeMcpConnectionDetails;
describe("canonical connector projection", () => {
  it("uses the same verified remote route for Installed and chat", () => {
    const [manifest] = mergeConnectorConnections([{ id: "notion", status: "connected" } as ConnectorManifest], [remote]);
    expect(manifest).toMatchObject({ id: "notion", connectionRoute: "remote", status: "connected" });
  });
  it.each([
    { authorizationState: "revoked" }, { authorizationState: "pending" },
    { credentialState: "missing" }, { healthState: "unknown" },
    { discoveryState: "unknown" }, { enabledTools: [] }, { discoveredTools: ["other"] },
  ])("never admits incomplete access or falls back to another account: %j", (change) => {
    const connection = { ...remote, ...change } as RuntimeMcpConnectionDetails;
    expect(remoteConnectionReady(connection)).toBe(false);
    const [manifest] = mergeConnectorConnections([{ id: "notion", status: "connected", account: { id: "different" } } as ConnectorManifest], [connection]);
    expect(manifest.status).not.toBe("connected");
    expect(manifest.connectionRoute).toBe("remote");
    expect(manifest.account).toBeUndefined();
  });
});
