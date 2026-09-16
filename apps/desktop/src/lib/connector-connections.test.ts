import { describe, expect, it } from "vitest";
import type { ConnectorManifest } from "@mivlet/protocol";
import { retiredRemoteConnectorServerIds } from "../components/marketplace/remote-connectors";
import type { RuntimeMcpConnectionDetails } from "../runtime/domains/mcp";
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
  ])("never admits incomplete remote access or an unverified native account: %j", (change) => {
    const connection = { ...remote, ...change } as RuntimeMcpConnectionDetails;
    expect(remoteConnectionReady(connection)).toBe(false);
    const [manifest] = mergeConnectorConnections([{ id: "notion", status: "connected", account: { id: "different" } } as ConnectorManifest], [connection]);
    expect(manifest.status).not.toBe("connected");
    expect(manifest.connectionRoute).toBe("remote");
    expect(manifest.account).toBeUndefined();
  });
  it.each(["notion", "linear", "vercel"])("keeps a healthy %s account usable when the remote setup is broken", (id) => {
    const native = { id, status: "connected", account: { id: "existing" }, health: { state: "healthy" } } as ConnectorManifest;
    for (const change of [{ authorizationState: "revoked" }, { credentialState: "missing" }, { healthState: "error" }, { enabledTools: [] }]) {
      const [manifest] = mergeConnectorConnections([native], [{ ...remote, launchReference: `marketplace-${id}`, ...change }]);
      expect(manifest).toEqual({ ...native, connectionRoute: "native" });
    }
  });
  it.each([
    { health: { state: "error" } }, { health: { state: "unknown" } },
    { status: "expired" }, { scopes: [{ id: "read", required: true, granted: false }] },
  ])("requires verified native access before selecting it: %j", (change) => {
    const native = { id: "notion", status: "connected", health: { state: "healthy" }, ...change } as ConnectorManifest;
    expect(mergeConnectorConnections([native], [{ ...remote, authorizationState: "revoked" }])[0]).toMatchObject({ connectionRoute: "remote", status: "revoked" });
  });
  it("preserves an existing native account and its reconnect route when no remote setup exists", () => {
    const native = { id: "notion", status: "expired", account: { id: "existing" } } as ConnectorManifest;
    expect(mergeConnectorConnections([native], [])).toEqual([{ ...native, connectionRoute: "native" }]);
  });
  it("ignores a saved configuration for a retired route without deleting it or other records", () => {
    const retired = { ...remote, launchReference: retiredRemoteConnectorServerIds[0] } as RuntimeMcpConnectionDetails;
    const saved = [retired, remote];
    const manifests = mergeConnectorConnections([{ id: "notion", status: "needs-auth" } as ConnectorManifest], saved);
    expect(manifests.some((manifest) => manifest.id === "todoist")).toBe(false);
    expect(manifests).toMatchObject([{ id: "notion", connectionRoute: "remote", status: "connected" }]);
    expect(saved).toEqual([retired, remote]);
  });
});
