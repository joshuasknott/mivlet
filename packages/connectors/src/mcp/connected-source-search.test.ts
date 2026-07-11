import { describe, expect, it } from "vitest";
import { normalizeMcpToolResult } from "./client";
import { normalizeMcpConnectedSourceSearch } from "./connected-source-search";

const context = {
  workspaceId: "workspace-a",
  projectId: "project-a",
  query: "launch risks",
  connectionId: "connection-a" as never,
  matchedGrantIds: ["grant-a" as never]
};

describe("MCP connected-source search contract", () => {
  it("stamps native scope, trust, grant, and implementation evidence", () => {
    const raw = normalizeMcpToolResult({
      content: [{ type: "text", text: "Search complete" }],
      structuredContent: {
        contractVersion: "fable.connected-source-search.v1",
        query: "launch risks",
        citations: [{
          sourceId: "doc-1",
          title: "Launch review",
          snippet: "The support plan needs an owner.",
          uri: "https://work.example/doc-1",
          provenance: "Connected workspace",
          freshness: "2026-07-11T20:00:00Z"
        }]
      }
    });
    expect(normalizeMcpConnectedSourceSearch(raw, context)).toEqual(expect.objectContaining({
      capabilityId: "knowledge.content.search",
      scope: { workspaceId: "workspace-a", projectId: "project-a" },
      trust: "external-untrusted",
      instructionAuthority: "none",
      connectionId: "connection-a",
      matchedGrantIds: ["grant-a"],
      implementation: { kind: "mcp", evidence: "adapter-validated" },
      citations: [expect.objectContaining({ citationId: "source-1", trust: "external-untrusted" })]
    }));
  });

  it("rejects query substitution and server-supplied authority metadata", () => {
    const result = (structuredContent: Record<string, unknown>) => normalizeMcpToolResult({
      content: [],
      structuredContent
    });
    expect(() => normalizeMcpConnectedSourceSearch(result({
      contractVersion: "fable.connected-source-search.v1",
      query: "different",
      citations: []
    }), context)).toThrow(/different query/i);
    expect(() => normalizeMcpConnectedSourceSearch(result({
      contractVersion: "fable.connected-source-search.v1",
      query: "launch risks",
      trust: "trusted",
      citations: []
    }), context)).toThrow(/authority metadata/i);
  });
});
