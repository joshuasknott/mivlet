import {
  CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION,
  type CapabilityGrantId,
  type ConnectedSourceCitation,
  type ConnectedSourceSearchResult,
  type ConnectionId
} from "@mivlet/protocol";
import type { McpUntrustedToolResult } from "./client";

const MAX_CITATIONS = 50;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`MCP cited search returned an invalid ${label}.`);
  }
  return value.trim();
}

function optionalUri(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const uri = text(value, "citation URI", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("MCP cited search returned an invalid citation URI.");
  }
  if (!new Set(["https:", "http:", "file:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("MCP cited search returned an unsafe citation URI.");
  }
  return uri;
}

export interface McpConnectedSourceContext {
  workspaceId: string;
  projectId?: string;
  query: string;
  connectionId: string;
  matchedGrantIds: readonly string[];
  degraded?: boolean;
  degradationReasons?: readonly string[];
}

/**
 * Converts one strict MCP structured result into the same semantic contract as
 * native connected-source search. Server-supplied trust/scope/authority fields
 * are rejected by the exact top-level allowlist and replaced with native facts.
 */
export function normalizeMcpConnectedSourceSearch(
  result: McpUntrustedToolResult,
  context: McpConnectedSourceContext
): ConnectedSourceSearchResult {
  if (result.isError || result.structuredTruncated || !result.structuredJson) {
    throw new Error("MCP cited search did not return a complete structured result.");
  }
  const decoded = object(JSON.parse(result.structuredJson) as unknown);
  if (!decoded) throw new Error("MCP cited search returned an invalid structured result.");
  const allowed = new Set(["contractVersion", "query", "citations", "nextCursor"]);
  if (Object.keys(decoded).some((key) => !allowed.has(key))) {
    throw new Error("MCP cited search attempted to supply Mivlet-owned authority metadata.");
  }
  if (decoded.contractVersion !== CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION) {
    throw new Error("MCP cited search returned an unsupported contract version.");
  }
  if (decoded.query !== context.query) {
    throw new Error("MCP cited search returned results for a different query.");
  }
  if (!Array.isArray(decoded.citations) || decoded.citations.length > MAX_CITATIONS) {
    throw new Error("MCP cited search returned an invalid citation list.");
  }
  const citations = decoded.citations.map((raw, index): ConnectedSourceCitation => {
    const citation = object(raw);
    if (!citation) throw new Error("MCP cited search returned an invalid citation.");
    const citationFields = new Set(["sourceId", "title", "snippet", "uri", "provenance", "freshness"]);
    if (Object.keys(citation).some((key) => !citationFields.has(key))) {
      throw new Error("MCP cited search citation attempted to supply authority metadata.");
    }
    return {
      citationId: `source-${index + 1}`,
      sourceId: text(citation.sourceId, "source id", 512),
      title: text(citation.title, "citation title", 512),
      snippet: text(citation.snippet, "citation snippet", 4_096),
      ...(citation.uri === undefined ? {} : { uri: optionalUri(citation.uri) }),
      provenance: text(citation.provenance, "citation provenance", 512),
      freshness: text(citation.freshness, "citation freshness", 200),
      trust: "external-untrusted"
    };
  });
  const nextCursor = decoded.nextCursor === undefined
    ? undefined
    : text(decoded.nextCursor, "next cursor", 2_048);
  return Object.freeze({
    contractVersion: CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION,
    capabilityId: "knowledge.content.search",
    query: context.query,
    scope: Object.freeze({
      workspaceId: context.workspaceId,
      ...(context.projectId ? { projectId: context.projectId } : {})
    }),
    citations: Object.freeze(citations.map((citation) => Object.freeze(citation))),
    ...(nextCursor ? { nextCursor } : {}),
    trust: "external-untrusted",
    instructionAuthority: "none",
    degraded: context.degraded === true,
    degradationReasons: Object.freeze([...(context.degradationReasons ?? [])]),
    connectionId: context.connectionId as ConnectionId,
    matchedGrantIds: Object.freeze([...context.matchedGrantIds]) as readonly CapabilityGrantId[],
    implementation: Object.freeze({ kind: "mcp", evidence: "adapter-validated" })
  });
}
