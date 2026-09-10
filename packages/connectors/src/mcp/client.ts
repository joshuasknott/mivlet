import type {
  McpFrame,
  McpNotification,
  McpRequest,
  McpInitializeResult,
  McpResource,
  McpTool
} from "./protocol";

/**
 * Renderer-safe MCP contracts. The official SDK client lives in sdk-client.ts
 * and is loaded only by the bundled native host.
 */
export interface McpTransport {
  send(frame: McpRequest | McpNotification): Promise<void>;
  subscribe(handler: (frame: McpFrame) => void): () => void;
  subscribeClose(handler: () => void): () => void;
  close(): Promise<void>;
}

export interface McpClientOptions {
  requestTimeoutMs?: number;
  maxPaginationPages?: number;
}

export type { McpFrame, McpInitializeResult, McpNotification, McpRequest, McpResource, McpTool };

export interface McpUntrustedContent {
  kind: "text" | "resource-link" | "embedded-text" | "media";
  trust: "untrusted";
  instructionAuthority: "none";
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  truncated: boolean;
}

export interface McpUntrustedToolResult {
  trust: "untrusted";
  instructionAuthority: "none";
  isError: boolean;
  content: readonly McpUntrustedContent[];
  structuredJson?: string;
  structuredTruncated?: boolean;
}

const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_CONTENT_ITEMS = 64;
const MAX_TOOL_TEXT_CHARACTERS = 64 * 1024;
const MAX_STRUCTURED_CHARACTERS = 256 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeJson(value: unknown): void {
  if (!isObject(value) && !Array.isArray(value)) return;
  for (const child of Object.values(value)) deepFreezeJson(child);
  Object.freeze(value);
}

function boundedText(value: string, max = MAX_TOOL_TEXT_CHARACTERS): [string, boolean] {
  if (value.length <= max) return [value, false];
  return [value.slice(0, max), true];
}

function safeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * Converts an untrusted MCP CallToolResult into a bounded Mivlet-owned
 * contract. External text and structured JSON never acquire instruction
 * authority, and binary media payloads never cross into model context.
 */
export function normalizeMcpToolResult(value: unknown): McpUntrustedToolResult {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_TOOL_RESULT_BYTES || !isObject(value)) {
    throw new Error("MCP tool returned an invalid or oversized result.");
  }
  if (!Array.isArray(value.content) || value.content.length > MAX_TOOL_CONTENT_ITEMS) {
    throw new Error("MCP tool returned invalid content.");
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    throw new Error("MCP tool returned an invalid error state.");
  }
  const content = value.content.map((item): McpUntrustedContent => {
    if (!isObject(item) || typeof item.type !== "string") {
      throw new Error("MCP tool returned invalid content.");
    }
    const base = { trust: "untrusted" as const, instructionAuthority: "none" as const };
    if (item.type === "text" && typeof item.text === "string") {
      const [text, truncated] = boundedText(item.text);
      return { ...base, kind: "text", text, truncated };
    }
    if (item.type === "resource_link") {
      const uri = safeOptionalString(item.uri, 2_048);
      if (!uri) throw new Error("MCP tool returned an invalid resource link.");
      return {
        ...base,
        kind: "resource-link",
        uri,
        name: safeOptionalString(item.name, 512),
        mimeType: safeOptionalString(item.mimeType, 200),
        truncated: false
      };
    }
    if (item.type === "resource" && isObject(item.resource)) {
      const uri = safeOptionalString(item.resource.uri, 2_048);
      const text = item.resource.text;
      if (!uri || typeof text !== "string") {
        throw new Error("MCP tool returned an unsupported embedded resource.");
      }
      const [bounded, truncated] = boundedText(text);
      return {
        ...base,
        kind: "embedded-text",
        uri,
        text: bounded,
        mimeType: safeOptionalString(item.resource.mimeType, 200),
        truncated
      };
    }
    if ((item.type === "image" || item.type === "audio") && typeof item.data === "string") {
      return {
        ...base,
        kind: "media",
        mimeType: safeOptionalString(item.mimeType, 200),
        truncated: true
      };
    }
    throw new Error("MCP tool returned an unsupported content type.");
  });
  const result: McpUntrustedToolResult = {
    trust: "untrusted",
    instructionAuthority: "none",
    isError: value.isError === true,
    content
  };
  if (value.structuredContent !== undefined) {
    if (!isObject(value.structuredContent)) {
      throw new Error("MCP tool returned invalid structured content.");
    }
    const structured = JSON.stringify(value.structuredContent);
    if (structured === undefined) throw new Error("MCP tool returned invalid structured content.");
    const [structuredJson, structuredTruncated] = boundedText(structured, MAX_STRUCTURED_CHARACTERS);
    result.structuredJson = structuredJson;
    result.structuredTruncated = structuredTruncated;
  }
  deepFreezeJson(result);
  return result;
}
