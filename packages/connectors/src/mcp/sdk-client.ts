import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode as SdkErrorCode,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  McpError as SdkMcpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ClientNotification,
  type ClientRequest,
  type ClientResult,
  type JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport as SdkTransport,
  TransportSendOptions
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions as SdkRequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  isMcpNotification,
  isMcpRequest,
  type McpFrame,
  type McpInitializeResult,
  type McpResource,
  type McpServerCapabilities,
  type McpTool
} from "./protocol";
import {
  type McpClientOptions,
  type McpNotification,
  type McpRequest,
  type McpTransport
} from "./client";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 100;

/** Official MCP SDK protocol ownership for the bundled native host. */
class MivletSdkProtocol extends Protocol<ClientRequest, ClientNotification, ClientResult> {
  private serverCapabilities?: McpServerCapabilities;

  constructor() {
    super({ enforceStrictCapabilities: true });
  }

  setServerCapabilities(capabilities: McpServerCapabilities): void {
    this.serverCapabilities = capabilities;
  }

  protected assertCapabilityForMethod(method: ClientRequest["method"]): void {
    switch (method) {
      case "initialize":
      case "ping":
        return;
      case "tools/list":
        if (!this.serverCapabilities?.tools) {
          throw new Error(`Server does not support tools (required for ${method})`);
        }
        return;
      case "resources/list":
        if (!this.serverCapabilities?.resources) {
          throw new Error(`Server does not support resources (required for ${method})`);
        }
        return;
      default:
        throw new Error(`Mivlet does not support MCP method ${method}.`);
    }
  }

  protected assertNotificationCapability(method: ClientNotification["method"]): void {
    if (
      method === "notifications/initialized" ||
      method === "notifications/cancelled" ||
      method === "notifications/progress"
    ) return;
    throw new Error(`Mivlet does not support MCP notification ${method}.`);
  }

  protected assertRequestHandlerCapability(method: string): void {
    if (method === "ping") return;
    throw new Error(`Mivlet cannot handle MCP request ${method}.`);
  }

  protected assertTaskCapability(method: string): void {
    throw new Error(`Mivlet does not support MCP task requests (${method}).`);
  }

  protected assertTaskHandlerCapability(method: string): void {
    throw new Error(`Mivlet cannot handle MCP task request ${method}.`);
  }
}

/** Forwards frames to a native-owned transport without opening credentials or processes. */
class SdkTransportAdapter implements SdkTransport {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeClose: () => void;
  private closed = false;
  private closeNotified = false;
  private negotiatedProtocolVersion?: string;
  private closePromise?: Promise<void>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: SdkTransport["onmessage"];

  constructor(
    private readonly transport: McpTransport,
    private readonly onTransportClosed: () => void
  ) {
    this.unsubscribe = transport.subscribe((frame) => this.receive(frame));
    this.unsubscribeClose = transport.subscribeClose(() => this.markClosed());
  }

  async start(): Promise<void> {
    // The host opens its underlying transport before constructing this adapter.
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const frame = message as unknown as McpFrame;
    if (isMcpRequest(frame) || isMcpNotification(frame)) {
      await this.transport.send(frame);
      return;
    }
    throw new Error("MCP client cannot send a response frame.");
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cleanup();
    this.closePromise = (async () => {
      try {
        await this.transport.close();
      } finally {
        this.notifyClosed();
      }
    })();
    await this.closePromise;
  }

  setProtocolVersion(version: string): void {
    this.negotiatedProtocolVersion = version;
  }

  get protocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  private receive(frame: McpFrame): void {
    if (this.closed) return;
    // Mivlet does not advertise sampling, roots, elicitation, or other
    // server-to-client requests. Reject them before SDK handlers can reply.
    if (isMcpRequest(frame)) {
      this.onerror?.(new Error("MCP server request rejected by Mivlet."));
      return;
    }
    this.onmessage?.(frame as JSONRPCMessage);
  }

  private markClosed(): void {
    this.closed = true;
    this.cleanup();
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onTransportClosed();
    this.onclose?.();
  }

  private cleanup(): void {
    this.unsubscribe();
    this.unsubscribeClose();
  }
}

/**
 * Official-SDK MCP client. Import this module only from the native host;
 * renderer code uses the contracts and bounded normalizer from client.ts.
 */
export class McpClient {
  private readonly adapter: SdkTransportAdapter;
  private readonly sdkProtocol: MivletSdkProtocol;
  private initialized?: McpInitializeResult;
  private closed = false;

  constructor(
    transport: McpTransport,
    private readonly options: McpClientOptions = {}
  ) {
    this.adapter = new SdkTransportAdapter(transport, () => this.markTransportClosed());
    this.sdkProtocol = new MivletSdkProtocol();
  }

  async initialize(): Promise<McpInitializeResult> {
    if (this.initialized) return this.initialized;
    if (this.closed) throw new Error("MCP transport is closed.");

    try {
      await this.requestSdk(() => this.sdkProtocol.connect(this.adapter));
      const result = await this.requestSdk(() => this.sdkProtocol.request(
        {
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "Mivlet", version: "0.1.0" }
          }
        },
        InitializeResultSchema,
        { timeout: this.requestTimeoutMs() }
      ));
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
      }
      this.adapter.setProtocolVersion(result.protocolVersion);
      this.sdkProtocol.setServerCapabilities(result.capabilities);
      await this.requestSdk(() => this.sdkProtocol.notification({ method: "notifications/initialized" }));
      const parsed: McpInitializeResult = {
        protocolVersion: result.protocolVersion,
        capabilities: result.capabilities,
        serverInfo: result.serverInfo,
        ...(result.instructions === undefined ? {} : { instructions: result.instructions })
      };
      this.initialized = parsed;
      return parsed;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<readonly McpTool[]> {
    this.requireCapability("tools");
    return this.collectPages(
      "tools/list",
      "tools",
      (params) => this.requestSdk(() => this.sdkProtocol.request(
        { method: "tools/list", params },
        ListToolsResultSchema,
        this.requestOptions()
      )).catch((error: unknown) => {
        if (isSdkValidationError(error)) throw new Error("MCP server returned an invalid tool definition.");
        throw error;
      }),
      this.parseTool
    );
  }

  async listResources(): Promise<readonly McpResource[]> {
    this.requireCapability("resources");
    return this.collectPages(
      "resources/list",
      "resources",
      (params) => this.requestSdk(() => this.sdkProtocol.request(
        { method: "resources/list", params },
        ListResourcesResultSchema,
        this.requestOptions()
      )).catch((error: unknown) => {
        if (isSdkValidationError(error)) throw new Error("MCP server returned an invalid resource definition.");
        throw error;
      }),
      this.parseResource
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.sdkProtocol.close();
    } finally {
      await this.adapter.close();
    }
  }

  private markTransportClosed(): void {
    this.closed = true;
  }

  private async requestSdk<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof SdkMcpError && error.code === SdkErrorCode.ConnectionClosed) {
        throw new Error("MCP transport closed.");
      }
      throw error;
    }
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
    listPage: (params: { cursor?: string }) => Promise<unknown>,
    parseItem: (value: unknown) => T
  ): Promise<readonly T[]> {
    const output: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const maxPages = this.options.maxPaginationPages ?? DEFAULT_MAX_PAGES;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await listPage(cursor === undefined ? {} : { cursor });
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

  private requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private requestOptions(): SdkRequestOptions {
    return { timeout: this.requestTimeoutMs() };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSdkValidationError(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.issues);
}
