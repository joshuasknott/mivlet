import {
  MCP_PROTOCOL_VERSION,
  type McpFrame,
  type McpNotification,
  type McpRequest,
  type McpRequestId,
  type McpResponse,
  isMcpNotification,
  isMcpRequest,
  isMcpResponse
} from "./protocol";

export interface McpTransport {
  send(frame: McpRequest | McpNotification): Promise<void>;
  subscribe(handler: (frame: McpFrame) => void): () => void;
  subscribeClose(handler: () => void): () => void;
  close(): Promise<void>;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version: string; [key: string]: unknown };
  instructions?: string;
}

export interface McpToolCallProposal {
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
}

export type McpToolAuthorizer = (proposal: McpToolCallProposal) => Promise<boolean>;

export interface McpClientOptions {
  requestTimeoutMs?: number;
  maxPaginationPages?: number;
  authorizeToolCall: McpToolAuthorizer;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 100;
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_CONTENT_ITEMS = 64;
const MAX_TOOL_TEXT_CHARACTERS = 64 * 1024;
const MAX_STRUCTURED_CHARACTERS = 256 * 1024;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJsonObject(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("MCP tool arguments must be a JSON object.");
  return encoded;
}

function parseJsonObject(encoded: string): Record<string, unknown> {
  const cloned: unknown = JSON.parse(encoded);
  if (!isObject(cloned)) throw new Error("MCP tool arguments must be a JSON object.");
  return cloned;
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
 * Converts an untrusted MCP CallToolResult into a bounded Mivlet-owned contract.
 * External text and structured JSON never acquire instruction authority, and
 * binary media payloads never cross into model context through this helper.
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

/**
 * Stateful MCP client core shared by local STDIO and later remote transports.
 * Discovery is untrusted data, and tool calls cannot cross this layer without
 * an injected Mivlet authorization decision over an immutable input snapshot.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<McpRequestId, PendingRequest>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeClose: () => void;
  private initialized?: McpInitializeResult;
  private closed = false;

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions
  ) {
    this.unsubscribe = transport.subscribe((frame) => this.receive(frame));
    this.unsubscribeClose = transport.subscribeClose(() => this.markTransportClosed());
  }

  async initialize(): Promise<McpInitializeResult> {
    if (this.initialized) return this.initialized;
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Mivlet", version: "0.1.0" }
    });
    const parsed = this.parseInitializeResult(result);
    if (parsed.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error(`MCP server selected unsupported protocol ${parsed.protocolVersion}.`);
    }
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = parsed;
    return parsed;
  }

  async listTools(): Promise<readonly McpTool[]> {
    this.requireCapability("tools");
    return this.collectPages("tools/list", "tools", this.parseTool);
  }

  async listResources(): Promise<readonly McpResource[]> {
    this.requireCapability("resources");
    return this.collectPages("resources/list", "resources", this.parseResource);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpUntrustedToolResult> {
    this.requireCapability("tools");
    if (!name.trim()) throw new Error("MCP tool name is required.");
    const encodedArguments = encodeJsonObject(args);
    const approvalSnapshot = parseJsonObject(encodedArguments);
    deepFreezeJson(approvalSnapshot);
    const approved = await this.options.authorizeToolCall({
      toolName: name,
      arguments: approvalSnapshot
    });
    if (!approved) throw new Error("MCP tool call was not authorized.");
    // Re-clone the exact value captured before authorization. Even a
    // hostile authorizer cannot substitute nested input for the provider call.
    return normalizeMcpToolResult(
      await this.request("tools/call", { name, arguments: parseJsonObject(encodedArguments) })
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeClose();
    this.rejectPendingClosed();
    await this.transport.close();
  }

  private markTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeClose();
    this.rejectPendingClosed();
  }

  private rejectPendingClosed(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("MCP transport closed."));
    }
    this.pending.clear();
  }

  private receive(frame: McpFrame): void {
    if (isMcpRequest(frame)) {
      // Server-initiated sampling, roots, and elicitation are not advertised by
      // this client. A transport adapter must reject them; they never become
      // implicit Mivlet authority here.
      return;
    }
    if (isMcpNotification(frame)) return;
    if (!isMcpResponse(frame)) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timeout);
    if (frame.error) {
      pending.reject(new Error(`MCP ${frame.error.code}: ${frame.error.message}`));
    } else {
      pending.resolve(frame.result);
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("MCP transport is closed.");
    if (method !== "initialize" && !this.initialized) {
      throw new Error("MCP client must initialize before operation.");
    }
    const id = `fable-mcp-${this.nextId++}`;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out.`));
        void this.transport.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "Mivlet request timeout" }
        }).catch(() => undefined);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    try {
      await this.transport.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  private requireCapability(capability: "tools" | "resources"): void {
    if (!this.initialized) throw new Error("MCP client must initialize before operation.");
    if (!this.initialized.capabilities[capability]) {
      throw new Error(`MCP server did not advertise ${capability}.`);
    }
  }

  private async collectPages<T>(
    method: string,
    key: "tools" | "resources",
    parseItem: (value: unknown) => T
  ): Promise<readonly T[]> {
    const output: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = this.options.maxPaginationPages ?? DEFAULT_MAX_PAGES;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request(method, cursor === undefined ? {} : { cursor });
      if (!isObject(result) || !Array.isArray(result[key])) {
        throw new Error(`MCP ${method} returned an invalid result.`);
      }
      output.push(...result[key].map(parseItem));
      const next = result.nextCursor;
      if (next === undefined) return output;
      if (typeof next !== "string" || next.length === 0 || seen.has(next)) {
        throw new Error(`MCP ${method} returned an invalid pagination cursor.`);
      }
      seen.add(next);
      cursor = next;
    }
    throw new Error(`MCP ${method} exceeded the pagination limit.`);
  }

  private parseInitializeResult(value: unknown): McpInitializeResult {
    if (
      !isObject(value) ||
      typeof value.protocolVersion !== "string" ||
      !isObject(value.capabilities) ||
      !isObject(value.serverInfo) ||
      typeof value.serverInfo.name !== "string" ||
      typeof value.serverInfo.version !== "string"
    ) {
      throw new Error("MCP server returned an invalid initialize result.");
    }
    return value as unknown as McpInitializeResult;
  }

  private parseTool(value: unknown): McpTool {
    if (!isObject(value) || typeof value.name !== "string" || !isObject(value.inputSchema)) {
      throw new Error("MCP server returned an invalid tool definition.");
    }
    return value as unknown as McpTool;
  }

  private parseResource(value: unknown): McpResource {
    if (!isObject(value) || typeof value.uri !== "string" || typeof value.name !== "string") {
      throw new Error("MCP server returned an invalid resource definition.");
    }
    return value as unknown as McpResource;
  }
}
