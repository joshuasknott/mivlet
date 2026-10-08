import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  getToolUiResourceUri,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourceMeta,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";
import type { DesktopMcpTransportHandle } from "./mcp-transport-contract";

const MAX_HTML_CHARACTERS = 5 * 1024 * 1024;
const MAX_DOMAIN_ENTRIES = 32;
const MAX_DOMAIN_CHARACTERS = 2_048;
const MAX_APP_MESSAGE_CHARACTERS = 256 * 1024;
const SAFE_EXTERNAL_SCHEMES = new Set(["https:"]);

export type McpAppHostStatus = "loading" | "ready" | "stale" | "closed" | "error";

export interface McpAppApprovalPreview {
  owner: { conversationId: string; resultId: string; generation: number };
  request: import("@mivlet/protocol").ApprovalRequest;
  toolName: string;
  arguments: Record<string, unknown>;
  source: "mcp-app";
}

export interface McpAppHostOptions {
  workspaceId: string;
  conversationId: string;
  resultId: string;
  generation: number;
  transport: DesktopMcpTransportHandle;
  tool: Tool;
  /** A host-owned freshness fence. False invalidates the app and all requests. */
  isCurrent?: () => boolean;
  requestApproval?: (preview: McpAppApprovalPreview) => Promise<ApprovalResolutionRequest | null>;
  onMessage?: (message: { owner: McpAppApprovalPreview["owner"]; content: CallToolResult["content"] }) => void;
  onContextUpdate?: (update: { owner: McpAppApprovalPreview["owner"]; update: Record<string, unknown> }) => void;
  onOpenLink?: (url: string, owner: McpAppApprovalPreview["owner"]) => Promise<boolean>;
  onResize?: (size: { width?: number; height?: number }) => void;
  onRequestTeardown?: () => void;
  /** Discovery snapshots from the already-open MCP client, when available. */
  listTools?: () => Promise<readonly Tool[]>;
  listResources?: () => Promise<readonly { uri: string; name: string; description?: string; mimeType?: string }[]>;
  /** Permissions granted by Mivlet policy; resource requests alone never grant these. */
  grantedPermissions?: McpUiResourcePermissions;
  hostContext?: McpUiHostContext;
}

export interface McpAppResource {
  uri: string;
  html: string;
  mimeType: string;
  metadata: McpUiResourceMeta;
  allow: string;
  csp: string;
}

export interface McpAppSessionSnapshot {
  status: McpAppHostStatus;
  resourceUri?: string;
  resource?: McpAppResource;
  appName?: string;
  appVersion?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDomainList(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_DOMAIN_ENTRIES) {
    throw new Error(`MCP App ${field} exceeds the supported domain limit.`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_DOMAIN_CHARACTERS) {
      throw new Error(`MCP App ${field} contains an invalid domain.`);
    }
    const candidate = value.replace(/^([a-z]+):\/\/\*\./iu, "$1://wildcard.");
    const url = new URL(candidate);
    if (!SAFE_EXTERNAL_SCHEMES.has(url.protocol) && url.protocol !== "wss:") {
      throw new Error(`MCP App ${field} only supports HTTPS origins.`);
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`MCP App ${field} must contain origins without credentials or paths.`);
    }
    return value;
  });
}

function resourceCsp(metadata: McpUiResourceMeta | undefined): string {
  const csp: McpUiResourceCsp = metadata?.csp ?? {};
  const connect = normalizeDomainList(csp.connectDomains, "connectDomains");
  const resources = normalizeDomainList(csp.resourceDomains, "resourceDomains");
  const frames = normalizeDomainList(csp.frameDomains, "frameDomains");
  const base = normalizeDomainList(csp.baseUriDomains, "baseUriDomains");
  // The iframe remains opaque-origin because it is sandboxed without allow-same-origin.
  // Inline script/style are required for srcdoc bundles; network origins are still
  // restricted to the server's declared allowlist.
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources.join(" ")}`,
    `style-src 'unsafe-inline' ${resources.join(" ")}`,
    `img-src data: blob: ${resources.join(" ")}`,
    `font-src data: ${resources.join(" ")}`,
    `media-src data: blob: ${resources.join(" ")}`,
    `connect-src ${connect.join(" ") || "'none'"}`,
    `frame-src ${frames.join(" ") || "'none'"}`,
    `base-uri ${base.join(" ") || "'self'"}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

function readResourceMetadata(value: unknown): McpUiResourceMeta {
  if (!isRecord(value)) return {};
  const csp = value.csp;
  const permissions = value.permissions;
  const metadata: McpUiResourceMeta = {};
  if (isRecord(csp)) metadata.csp = csp as McpUiResourceCsp;
  if (isRecord(permissions)) metadata.permissions = permissions as McpUiResourcePermissions;
  if (typeof value.domain === "string") metadata.domain = value.domain;
  if (typeof value.prefersBorder === "boolean") metadata.prefersBorder = value.prefersBorder;
  return metadata;
}

function extractResourceMetadata(content: Record<string, unknown>): McpUiResourceMeta {
  // MCP resource metadata is carried in `_meta.ui`; accept the flat key for
  // interoperability with older servers, but never trust arbitrary metadata.
  const meta = isRecord(content.metadata) ? content.metadata : (isRecord(content._meta) ? content._meta : undefined);
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  return readResourceMetadata(ui ?? (meta?.["ui/resource"] as unknown));
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Convert Mivlet's bounded untrusted result back to the standard MCP shape
 * expected by AppBridge. Media bytes stay redacted at this boundary. */
function toAppToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) return errorResult("MCP App returned an invalid tool result.");
  const content = value.content.map((item) => {
    if (!isRecord(item)) return { type: "text" as const, text: "[Invalid MCP content omitted]" };
    if (item.kind === "text") return { type: "text" as const, text: typeof item.text === "string" ? item.text : "" };
    if (item.kind === "resource-link") return {
      type: "resource_link" as const,
      uri: typeof item.uri === "string" ? item.uri : "ui://invalid",
      name: typeof item.name === "string" ? item.name : "MCP resource",
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    };
    if (item.kind === "embedded-text") return {
      type: "resource" as const,
      resource: {
        uri: typeof item.uri === "string" ? item.uri : "ui://invalid",
        text: typeof item.text === "string" ? item.text : "",
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
      },
    };
    return { type: "text" as const, text: "[Media content omitted by Mivlet's bounded MCP boundary]" };
  });
  const structured = typeof value.structuredJson === "string" ? (() => {
    try {
      const parsed: unknown = JSON.parse(value.structuredJson);
      return isRecord(parsed) ? parsed : undefined;
    } catch { return undefined; }
  })() : undefined;
  return {
    isError: value.isError === true,
    content,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function boundedClone(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > MAX_APP_MESSAGE_CHARACTERS) {
    throw new Error(`MCP App ${label} exceeds the supported size.`);
  }
  return JSON.parse(encoded) as unknown;
}

function owner(options: McpAppHostOptions): McpAppApprovalPreview["owner"] {
  return { conversationId: options.conversationId, resultId: options.resultId, generation: options.generation };
}

/**
 * Mivlet's host-side MCP Apps session. It owns one untrusted iframe and one
 * exact MCP result. No app request bypasses the existing native transport or
 * approval boundary.
 */
export class McpAppHostSession {
  private readonly options: McpAppHostOptions;
  private readonly snapshotState: McpAppSessionSnapshot = { status: "loading" };
  private bridge?: AppBridge;
  private messageTransport?: PostMessageTransport;
  private iframe?: HTMLIFrameElement;
  private unsubscribeTransportClose?: () => void;
  private resource?: McpAppResource;
  private disposed = false;
  private initialized = false;
  private disposePromise?: Promise<void>;

  constructor(options: McpAppHostOptions) {
    this.options = options;
    this.snapshotState.resourceUri = getToolUiResourceUri(options.tool);
  }

  snapshot(): McpAppSessionSnapshot {
    return { ...this.snapshotState, ...(this.resource ? { resource: this.resource } : {}) };
  }

  async loadResource(): Promise<McpAppResource> {
    this.ensureCurrent();
    const uri = this.snapshotState.resourceUri;
    if (!uri) throw new Error("This MCP tool does not provide an interactive UI resource.");
    if (!uri.startsWith("ui://") || uri.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(uri)) {
      throw new Error("The MCP App resource URI is invalid.");
    }
    const { proposal, prepared } = await this.options.transport.prepareResourceRead(uri);
    this.ensureCurrent();
    const resolution = await this.approve({ request: prepared.approval, toolName: "resources/read", arguments: { uri } });
    if (!resolution) throw new Error("MCP App resource access was denied.");
    const permit = await this.options.transport.authorizeToolCall(proposal, resolution);
    const result = await this.options.transport.executeAuthorizedToolCall(proposal, permit.permitId);
    this.ensureCurrent();
    if (!isRecord(result) || !Array.isArray(result.content)) throw new Error("MCP App resource returned invalid content.");
    const item = result.content.find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && (candidate.kind === "embedded-text" || candidate.kind === "text"));
    if (!item || typeof item.text !== "string") throw new Error("MCP App resource is not a text HTML document.");
    if (item.text.length === 0 || item.text.length > MAX_HTML_CHARACTERS) throw new Error("MCP App resource exceeds the supported size.");
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : "text/html;profile=mcp-app";
    if (!mimeType.toLowerCase().startsWith("text/html")) throw new Error("MCP App resource is not HTML.");
    const metadata = extractResourceMetadata(item);
    const allow = buildAllowAttribute(this.allowedPermissions(metadata.permissions));
    const csp = resourceCsp(metadata);
    this.resource = { uri, html: item.text, mimeType, metadata, allow, csp };
    this.snapshotState.status = "loading";
    this.snapshotState.error = undefined;
    return this.resource;
  }

  /** Sets the opaque sandbox iframe and performs the official ui/initialize handshake. */
  async attach(iframe: HTMLIFrameElement): Promise<void> {
    this.ensureCurrent();
    if (!this.resource) throw new Error("MCP App resource must load before attach.");
    if (!iframe.contentWindow) throw new Error("MCP App iframe is unavailable.");
    this.iframe = iframe;
    this.unsubscribeTransportClose = this.options.transport.subscribeClose(() => {
      if (this.disposed) return;
      this.snapshotState.status = "error";
      this.snapshotState.error = "The MCP connection closed; reopen the result after reconnecting.";
      void this.dispose("MCP connection closed");
    });
    this.messageTransport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
    this.bridge = new AppBridge(null, { name: "Mivlet", version: "0.1.0" } satisfies Implementation, {
      ...(this.options.listTools ? { serverTools: { listChanged: true } } : {}),
      ...(this.options.listResources ? { serverResources: { listChanged: true } } : {}),
      openLinks: {},
      message: { text: true },
      updateModelContext: { text: true },
      logging: {},
      sandbox: { permissions: this.allowedPermissions(this.resource.metadata.permissions), csp: this.resource.metadata.csp },
    }, {
      hostContext: {
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        platform: "desktop",
        userAgent: "Mivlet",
        ...this.options.hostContext,
      },
    });
    this.registerHandlers(this.bridge);
    // Start AppBridge's source-validated listener before releasing the
    // untrusted HTML. Otherwise a fast View can send ui/initialize before the
    // host is listening and leave the result stuck in Loading.
    const connected = this.bridge.connect(this.messageTransport);
    iframe.srcdoc = srcDocForMcpApp(this.resource);
    await connected;
    this.ensureCurrent();
    this.initialized = true;
    this.snapshotState.status = "ready";
    this.snapshotState.appName = this.bridge.getAppVersion()?.name;
    this.snapshotState.appVersion = this.bridge.getAppVersion()?.version;
  }

  async sendToolInput(input: Record<string, unknown>): Promise<void> {
    this.ensureReady();
    await this.bridge?.sendToolInput({ arguments: JSON.parse(JSON.stringify(input)) as Record<string, unknown> });
  }

  async sendToolResult(result: CallToolResult): Promise<void> {
    this.ensureReady();
    await this.bridge?.sendToolResult(result);
  }

  async sendToolCancelled(reason?: string): Promise<void> {
    if (!this.bridge || this.disposed) return;
    await this.bridge.sendToolCancelled({ reason });
  }

  async dispose(reason = "MCP App closed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.snapshotState.status = "closed";
    this.disposePromise = (async () => {
      try {
        // Teardown is cooperative, but Stop and pane close must remain
        // immediate when an untrusted app has stopped answering.
        if (this.bridge && this.initialized) await this.bridge.teardownResource({}, { timeout: 750 }).catch(() => undefined);
      } finally {
        await this.messageTransport?.close().catch(() => undefined);
        this.bridge = undefined;
        this.messageTransport = undefined;
        this.iframe = undefined;
        this.unsubscribeTransportClose?.();
        this.unsubscribeTransportClose = undefined;
        this.snapshotState.error = reason === "MCP App closed" ? undefined : reason;
      }
    })();
    return this.disposePromise;
  }

  private registerHandlers(bridge: AppBridge): void {
    bridge.oncalltool = async (params) => {
      if (!params || typeof params.name !== "string" || !isRecord(params.arguments)) return errorResult("MCP App requested an invalid tool call.");
      return this.runAppTool(params.name, params.arguments);
    };
    if (this.options.listTools) {
      bridge.onlisttools = async () => ({ tools: (await this.options.listTools?.() ?? []).map((tool) => ({ ...tool })) });
    }
    if (this.options.listResources) {
      bridge.onlistresources = async () => ({ resources: (await this.options.listResources?.() ?? []).map((resource) => ({ ...resource })) });
    }
    bridge.onreadresource = async (params) => {
      const uri = params?.uri;
      if (typeof uri !== "string" || uri.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(uri)) return { contents: [] };
      if (uri === this.resource?.uri) {
        return { contents: [{ uri, mimeType: this.resource.mimeType, text: this.resource.html, _meta: { ui: this.resource.metadata } }] };
      }
      try {
        const { proposal, prepared } = await this.options.transport.prepareResourceRead(uri);
        const resolution = await this.approve({ request: prepared.approval, toolName: "resources/read", arguments: { uri } });
        if (!resolution) return { contents: [] };
        const permit = await this.options.transport.authorizeToolCall(proposal, resolution);
        const result = await this.options.transport.executeAuthorizedToolCall(proposal, permit.permitId);
        return {
          contents: (isRecord(result) && Array.isArray(result.content) ? result.content : []).map((item) => ({
            uri,
            mimeType: isRecord(item) && typeof item.mimeType === "string" ? item.mimeType : "text/plain",
            text: isRecord(item) && typeof item.text === "string" ? item.text : "",
          })),
        };
      } catch {
        return { contents: [] };
      }
    };
    bridge.onmessage = async (params) => {
      this.ensureCurrent();
      if (!params?.content || !Array.isArray(params.content)) return {};
      const content = boundedClone(params.content, "message") as CallToolResult["content"];
      this.options.onMessage?.({ owner: owner(this.options), content });
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      this.ensureCurrent();
      this.options.onContextUpdate?.({ owner: owner(this.options), update: boundedClone(params ?? {}, "context update") as Record<string, unknown> });
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      if (typeof url !== "string") return { opened: false };
      let parsed: URL;
      try { parsed = new URL(url); } catch { return { opened: false }; }
      if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) return { opened: false };
      const opened = await this.options.onOpenLink?.(parsed.href, owner(this.options)) ?? false;
      return { isError: !opened };
    };
    bridge.onrequestdisplaymode = async ({ mode }) => ({ mode: mode === "fullscreen" ? "fullscreen" : "inline" });
    bridge.onrequestteardown = () => this.options.onRequestTeardown?.();
    bridge.onsizechange = (size) => this.options.onResize?.(size);
    bridge.onloggingmessage = () => undefined;
  }

  private async runAppTool(toolName: string, argumentsValue: Record<string, unknown>): Promise<CallToolResult> {
    try {
      this.ensureReady();
      if (!/^[a-zA-Z0-9_.-]{1,128}$/u.test(toolName)) return errorResult("MCP App requested an invalid tool name.");
      const { proposal, prepared } = await this.options.transport.prepareToolCall(toolName, argumentsValue);
      const resolution = await this.approve({ request: prepared.approval, toolName, arguments: argumentsValue });
      if (!resolution) return errorResult("Mivlet denied this MCP App action.");
      const permit = await this.options.transport.authorizeToolCall(proposal, resolution);
      const result = await this.options.transport.executeAuthorizedToolCall(proposal, permit.permitId);
      this.ensureCurrent();
      return toAppToolResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "MCP App action failed.");
    }
  }

  private async approve(input: { request: import("@mivlet/protocol").ApprovalRequest; toolName: string; arguments: Record<string, unknown> }): Promise<ApprovalResolutionRequest | null> {
    this.ensureCurrent();
    if (!this.options.requestApproval) return null;
    return this.options.requestApproval({ owner: owner(this.options), request: input.request, toolName: input.toolName, arguments: JSON.parse(JSON.stringify(input.arguments)) as Record<string, unknown>, source: "mcp-app" });
  }

  private allowedPermissions(requested?: McpUiResourcePermissions): McpUiResourcePermissions {
    const granted = this.options.grantedPermissions ?? {};
    if (!requested) return {};
    return Object.fromEntries(Object.keys(requested).filter((key) => key in granted).map((key) => [key, {}])) as McpUiResourcePermissions;
  }

  private ensureReady(): void {
    this.ensureCurrent();
    if (!this.initialized || !this.bridge) throw new Error("MCP App is not initialized.");
  }

  private ensureCurrent(): void {
    if (this.disposed) throw new Error("MCP App is closed.");
    if (this.options.isCurrent && !this.options.isCurrent()) {
      this.snapshotState.status = "stale";
      throw new Error("MCP App result is stale; reopen the current conversation result.");
    }
  }
}

export function srcDocForMcpApp(resource: McpAppResource): string {
  // The app remains in a unique opaque origin: no allow-same-origin, no parent
  // DOM, credentials, localStorage, native IPC, or direct parent navigation.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${resource.csp}">${resource.html}`;
}
