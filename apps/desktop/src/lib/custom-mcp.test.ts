import { describe, expect, it } from "vitest";
import { customMcpConnectorId, customMcpServerReference } from "./custom-mcp";
import { chatConnectorIds, chatConnectorTools } from "./connector-chat";
import { mergeConnectorConnections } from "./connector-connections";
import { mentionParts } from "../components/ConnectorMention";
const reference = "local-brief.v1_test";
const id = customMcpConnectorId(reference)!;
const connection = { launchReference: reference, displayName: "Brief server", authorizationState: "not-required", credentialState: "not-required", healthState: "healthy", discoveryState: "discovered", discoveredTools: ["read"], enabledTools: ["read"], discoveredResources: [], enabledResources: [] };
describe("custom tool servers in conversations", () => {
  it("uses a reversible path-free ID, separate from official app routes, in actual mention parsing", () => {
    expect(customMcpServerReference(id)).toBe(reference);
    const connector = { id, name: "Brief server" };
    expect(mentionParts(`Use @${id} please`, [connector]).some(part => part.connector === connector)).toBe(true);
    for (const value of ["../file", "marketplace-vercel", "marketplace-todoist", "host:command", "a".repeat(129)]) expect(customMcpConnectorId(value)).toBeUndefined();
    expect(customMcpServerReference("mcp-2f6574632f706173737764")).toBeUndefined();
    expect(customMcpServerReference("mcp-6d61726b6574706c6163652d76657263656c")).toBeUndefined();
  });
  it("admits only discovered enabled access and exposes the same three shared tools", () => {
    const manifests = mergeConnectorConnections([], [connection]);
    expect(manifests[0]).toMatchObject({ id, name: "Brief server", connectionRoute: "mcp", status: "connected", supportsSearch: false });
    expect(chatConnectorTools(chatConnectorIds([], manifests), manifests).map(tool => tool.name)).toEqual(["connector-tools", "connector-call", "connector-resource"]);
    expect(chatConnectorTools([id], manifests)[0].description).toContain(id);
    expect(chatConnectorTools([id], [])).toEqual([]);
    expect(chatConnectorTools([id])).toEqual([]);
  });
  it("supports a public resource-only server without inventing credentials", () => {
    expect(mergeConnectorConnections([], [{ ...connection, discoveredTools: [], enabledTools: [], discoveredResources: ["brief://report"], enabledResources: ["brief://report"] }])[0].status).toBe("connected");
  });
  it.each([{ enabledTools: [] }, { discoveredTools: [] }, { healthState: "offline" }, { authorizationState: "revoked" }, { credentialState: "missing" }, { discoveryState: "not-started" }])("keeps unready custom access out of chat: %j", change => {
    const manifests = mergeConnectorConnections([], [{ ...connection, ...change }]);
    expect(chatConnectorIds([], manifests)).toEqual([]);
    expect(chatConnectorTools([id], manifests)).toEqual([]);
  });
});
