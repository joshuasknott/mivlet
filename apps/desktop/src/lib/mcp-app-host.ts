import {
  AppBridge,
  buildAllowAttribute,
  getToolUiResourceUri,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourceMeta,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  Implementation,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";
import type { DesktopMcpTransportHandle } from "./mcp-transport-contract";
import { McpAppTransport } from "./mcp-app-transport";

const MAX_HTML_CHARACTERS = 5 * 1024 * 1024;
const MAX_DOMAIN_ENTRIES = 32;
const MAX_DOMAIN_CHARACTERS = 2_048;
const MAX_APP_MESSAGE_CHARACTERS = 256 * 1024;
const MAX_IN_FLIGHT_APP_ACTIONS = 8;
const MAX_IN_FLIGHT_APP_RESOURCE_READS = 4;
const SAFE_EXTERNAL_SCHEMES = new Set(["https:"]);

type McpAppHostStatus =
  "loading" | "ready" | "stale" | "closed" | "error";

export interface McpAppApprovalPreview {
  /** Exact workspace/conversation/result fence for every app-originated request. */
  owner: {
    workspaceId: string;
    conversationId: string;
    resultId: string;
    generation: number;
  };
  request: import("@mivlet/protocol").ApprovalRequest;
  toolName: string;
  arguments: Record<string, unknown>;
  source: "mcp-app";
  /** Renderer-only cancellation fence. Never serialize into native approval state. */
  abortSignal?: AbortSignal;
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
  requestApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<ApprovalResolutionRequest | null>;
  onMessage?: (message: {
    owner: McpAppApprovalPreview["owner"];
    content: CallToolResult["content"];
  }) => void;
  onContextUpdate?: (update: {
    owner: McpAppApprovalPreview["owner"];
    update: Record<string, unknown>;
  }) => void;
  onOpenLink?: (
    url: string,
    owner: McpAppApprovalPreview["owner"],
  ) => Promise<boolean>;
  onResize?: (size: { width?: number; height?: number }) => void;
  onDisplayMode?: (mode: "inline" | "fullscreen") => void;
  onRequestTeardown?: () => void;
  /** Discovery snapshots from the already-open MCP client, when available. */
  listTools?: () => Promise<readonly Tool[]>;
  listResources?: () => Promise<
    readonly {
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }[]
  >;
  /** Permissions granted by Mivlet policy; resource requests alone never grant these. */
  grantedPermissions?: McpUiResourcePermissions;
  hostContext?: McpUiHostContext;
}

export type McpAppStateListener = (snapshot: McpAppSessionSnapshot) => void;

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
  /** Renderer-safe metadata. The untrusted HTML remains transient/native-only. */
  resource?: Omit<McpAppResource, "html">;
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
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_DOMAIN_CHARACTERS
    ) {
      throw new Error(`MCP App ${field} contains an invalid domain.`);
    }
    const candidate = value.replace(/^([a-z]+):\/\/\*\./iu, "$1://wildcard.");
    const url = new URL(candidate);
    if (!SAFE_EXTERNAL_SCHEMES.has(url.protocol) && url.protocol !== "wss:") {
      throw new Error(`MCP App ${field} only supports HTTPS origins.`);
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `MCP App ${field} must contain origins without credentials or paths.`,
      );
    }
    if (
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    ) {
      throw new Error("MCP App cannot access local or native service origins.");
    }
    return value;
  });
}

function resourceCsp(metadata: McpUiResourceMeta | undefined): string {
  const csp: McpUiResourceCsp = metadata?.csp ?? {};
  const connect = normalizeDomainList(csp.connectDomains, "connectDomains");
  const resources = normalizeDomainList(csp.resourceDomains, "resourceDomains");
  const frames = normalizeDomainList(csp.frameDomains, "frameDomains");
  if (frames.length > 0) {
    throw new Error(
      "MCP App nested frames are unavailable in this desktop host; remove frameDomains and retry.",
    );
  }
  const base = normalizeDomainList(csp.baseUriDomains, "baseUriDomains");
  // The iframe remains opaque-origin because it is sandboxed without
  // allow-same-origin. Inline script/style support self-contained app bundles;
  // network origins are still restricted to the server's declared allowlist.
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
    "navigate-to 'none'",
  ].join("; ");
}

function readResourceMetadata(value: unknown): McpUiResourceMeta {
  if (!isRecord(value)) return {};
  const csp = value.csp;
  const permissions = value.permissions;
  const metadata: McpUiResourceMeta = {};
  if (isRecord(csp)) metadata.csp = csp as McpUiResourceCsp;
  if (isRecord(permissions))
    metadata.permissions = permissions as McpUiResourcePermissions;
  if (typeof value.domain === "string") metadata.domain = value.domain;
  if (typeof value.prefersBorder === "boolean")
    metadata.prefersBorder = value.prefersBorder;
  return metadata;
}

function extractResourceMetadata(
  content: Record<string, unknown>,
): McpUiResourceMeta {
  // MCP resource metadata is carried in `_meta.ui`; accept the flat key for
  // interoperability with older servers, but never trust arbitrary metadata.
  const meta = isRecord(content.metadata)
    ? content.metadata
    : isRecord(content._meta)
      ? content._meta
      : undefined;
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  return readResourceMetadata(ui ?? (meta?.["ui/resource"] as unknown));
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Convert Mivlet's bounded untrusted result back to the standard MCP shape
 * expected by AppBridge. Media bytes stay redacted at this boundary. */
export function toMcpAppCallToolResult(value: unknown): CallToolResult {
  const payload = isRecord(value)
    && value.jsonrpc === "2.0"
    && isRecord(value.result)
    ? value.result
    : value;
  if (!isRecord(payload) || !Array.isArray(payload.content))
    return errorResult("MCP App returned an invalid tool result.");
  const content = payload.content.map((item) => {
    if (!isRecord(item))
      return { type: "text" as const, text: "[Invalid MCP content omitted]" };
    if (item.kind === "text" || item.type === "text")
      return {
        type: "text" as const,
        text: typeof item.text === "string" ? item.text : "",
      };
    if (item.kind === "resource-link" || item.type === "resource_link")
      return {
        type: "resource_link" as const,
        uri: typeof item.uri === "string" ? item.uri : "ui://invalid",
        name: typeof item.name === "string" ? item.name : "MCP resource",
        ...(typeof item.mimeType === "string"
          ? { mimeType: item.mimeType }
          : {}),
      };
    const embedded = isRecord(item.resource) ? item.resource : item;
    if (item.kind === "embedded-text" || item.type === "resource")
      return {
        type: "resource" as const,
        resource: {
          uri: typeof embedded.uri === "string" ? embedded.uri : "ui://invalid",
          text: typeof embedded.text === "string" ? embedded.text : "",
          ...(typeof embedded.mimeType === "string"
            ? { mimeType: embedded.mimeType }
            : {}),
        },
      };
    return {
      type: "text" as const,
      text: "[Media content omitted by Mivlet's bounded MCP boundary]",
    };
  });
  const structured =
    typeof payload.structuredJson === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(payload.structuredJson);
            return isRecord(parsed) ? parsed : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  return {
    isError: payload.isError === true,
    content,
    ...(
      structured
        ? { structuredContent: structured }
        : isRecord(payload.structuredContent)
          ? { structuredContent: payload.structuredContent }
          : {}
    ),
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
  return {
    workspaceId: options.workspaceId,
    conversationId: options.conversationId,
    resultId: options.resultId,
    generation: options.generation,
  };
}

/**
 * Mivlet's host-side MCP Apps session. It owns one untrusted iframe and one
 * exact MCP result. No app request bypasses the existing native transport or
 * approval boundary.
 */
export class McpAppHostSession {
  #options: McpAppHostOptions;
  #snapshotState: McpAppSessionSnapshot = { status: "loading" };
  #bridge?: AppBridge;
  #messageTransport?: McpAppTransport;
  #iframe?: HTMLIFrameElement;
  #unsubscribeTransportClose?: () => void;
  #resource?: McpAppResource;
  #disposed = false;
  #initialized = false;
  #cancelHandshake?: () => void;
  #disposePromise?: Promise<void>;
  #approvalAbortController = new AbortController();
  #inFlightAppActions = 0;
  #inFlightAppResourceReads = 0;
  #stateListeners = new Set<McpAppStateListener>();

  constructor(options: McpAppHostOptions) {
    this.#options = options;
    this.#snapshotState.resourceUri = getToolUiResourceUri(options.tool);
  }

  snapshot(): McpAppSessionSnapshot {
    const resource = this.#resource;
    const safeResource = resource
      ? (({ html: _html, ...metadata }) => metadata)(resource)
      : undefined;
    return {
      ...this.#snapshotState,
      ...(safeResource ? { resource: safeResource } : {}),
    };
  }

  subscribeState(listener: McpAppStateListener): () => void {
    this.#stateListeners.add(listener);
    listener(this.snapshot());
    return () => this.#stateListeners.delete(listener);
  }

  #publishState(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#stateListeners) listener(snapshot);
  }

  async loadResource(): Promise<McpAppResource> {
    this.#ensureCurrent();
    const uri = this.#snapshotState.resourceUri;
    if (!uri)
      throw new Error(
        "This MCP tool does not provide an interactive UI resource.",
      );
    if (
      !uri.startsWith("ui://") ||
      uri.length > 2_048 ||
      /[\u0000-\u001f\u007f]/u.test(uri)
    ) {
      throw new Error("The MCP App resource URI is invalid.");
    }
    const { proposal, prepared } =
      await this.#options.transport.prepareResourceRead(uri);
    this.#ensureCurrent();
    const resolution = await this.#approve({
      request: prepared.approval,
      toolName: "resources/read",
      arguments: { uri },
    });
    if (!resolution) throw new Error("MCP App resource access was denied.");
    const result = await this.#executeApproved(proposal, resolution);
    if (!isRecord(result) || !Array.isArray(result.content))
      throw new Error("MCP App resource returned invalid content.");
    const item = result.content.find(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        candidate.uri === uri &&
        (candidate.kind === "embedded-text" || candidate.kind === "text"),
    );
    if (!item || typeof item.text !== "string")
      throw new Error("MCP App resource response did not include the requested UI resource.");
    if (item.truncated === true)
      throw new Error(
        "MCP App resource was truncated before loading; use the ordinary tool result or ask the server for a smaller UI.",
      );
    if (item.text.length === 0 || item.text.length > MAX_HTML_CHARACTERS)
      throw new Error("MCP App resource exceeds the supported size.");
    const mimeType =
      typeof item.mimeType === "string"
        ? item.mimeType
        : "text/html;profile=mcp-app";
    if (!mimeType.toLowerCase().startsWith("text/html"))
      throw new Error("MCP App resource is not HTML.");
    const metadata = extractResourceMetadata(item);
    const allow = buildAllowAttribute(
      this.#allowedPermissions(metadata.permissions),
    );
    const csp = resourceCsp(metadata);
    this.#resource = { uri, html: item.text, mimeType, metadata, allow, csp };
    this.#snapshotState.status = "loading";
    this.#snapshotState.error = undefined;
    this.#publishState();
    return this.#resource;
  }

  /** Sets the opaque sandbox iframe and performs the official ui/initialize handshake. */
  async attach(iframe: HTMLIFrameElement, resourceUrl?: string): Promise<void> {
    this.#ensureCurrent();
    if (!this.#resource)
      throw new Error("MCP App resource must load before attach.");
    if (!iframe.contentWindow)
      throw new Error("MCP App iframe is unavailable.");
    this.#iframe = iframe;
    this.#unsubscribeTransportClose = this.#options.transport.subscribeClose(
      () => {
        if (this.#disposed) return;
        this.#snapshotState.status = "error";
        this.#snapshotState.error =
          "The MCP connection closed; reopen the result after reconnecting.";
        this.#publishState();
        void this.dispose("MCP connection closed");
      },
    );
    this.#messageTransport = new McpAppTransport(iframe.contentWindow);
    this.#bridge = new AppBridge(
      null,
      { name: "Mivlet", version: "0.1.0" } satisfies Implementation,
      {
        serverTools: {},
        ...(this.#options.listResources
          ? { serverResources: { listChanged: true } }
          : {}),
        ...(this.#options.onOpenLink ? { openLinks: {} } : {}),
        ...(this.#options.onMessage ? { message: { text: {} } } : {}),
        ...(this.#options.onContextUpdate
          ? { updateModelContext: { text: {} } }
          : {}),
        logging: {},
        sandbox: {
          permissions: this.#allowedPermissions(
            this.#resource.metadata.permissions,
          ),
          csp: this.#resource.metadata.csp,
        },
      },
      {
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: this.#options.onDisplayMode
            ? ["inline", "fullscreen"]
            : ["inline"],
          platform: "desktop",
          userAgent: "Mivlet",
          ...this.#options.hostContext,
        },
      },
    );
    this.#registerHandlers(this.#bridge);
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const initialized = new Promise<void>((resolve, reject) => {
      handshakeTimer = setTimeout(
        () =>
          reject(
            new Error(
              "The MCP App did not initialize. Reopen the result to retry.",
            ),
          ),
        15000,
      );
      this.#cancelHandshake = () =>
        reject(new Error("MCP App closed during initialization."));
      this.#bridge!.oninitialized = () => resolve();
    });
    // Start AppBridge's source-validated listener before releasing the
    // untrusted HTML. Otherwise a fast View can send ui/initialize before the
    // host is listening and leave the result stuck in Loading.
    const connected = this.#bridge.connect(this.#messageTransport);
    const transportError = (error?: Error) => {
      if (this.#disposed) return;
      this.#snapshotState.status = "error";
      this.#snapshotState.error =
        error?.message ?? "The MCP App channel closed; reopen the result.";
      this.#publishState();
      void this.dispose(this.#snapshotState.error);
    };
    const previousTransportError = this.#messageTransport.onerror;
    this.#messageTransport.onerror = (error) => {
      previousTransportError?.(error);
      transportError(error);
    };
    const previousTransportClose = this.#messageTransport.onclose;
    this.#messageTransport.onclose = () => {
      previousTransportClose?.();
      transportError();
    };
    if (!resourceUrl)
      throw new Error("The dedicated MCP App sandbox URL is required.");
    iframe.src = resourceUrl;
    try {
      await Promise.all([connected, initialized]);
    } finally {
      clearTimeout(handshakeTimer);
      this.#cancelHandshake = undefined;
    }
    this.#ensureCurrent();
    this.#initialized = true;
    this.#snapshotState.status = "ready";
    this.#snapshotState.appName = this.#bridge.getAppVersion()?.name;
    this.#snapshotState.appVersion = this.#bridge.getAppVersion()?.version;
    this.#publishState();
  }

  async sendToolInput(input: Record<string, unknown>): Promise<void> {
    this.#ensureReady();
    await this.#bridge?.sendToolInput({
      arguments: boundedClone(input, "tool input") as Record<string, unknown>,
    });
  }

  async sendToolResult(result: CallToolResult): Promise<void> {
    this.#ensureReady();
    await this.#bridge?.sendToolResult(
      boundedClone(result, "tool result") as CallToolResult,
    );
  }

  async sendToolCancelled(reason?: string): Promise<void> {
    if (!this.#bridge || this.#disposed) return;
    await this.#bridge.sendToolCancelled({ reason });
  }

  async dispose(reason = "MCP App closed"): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#approvalAbortController.abort();
    this.#cancelHandshake?.();
    this.#cancelHandshake = undefined;
    if (this.#iframe) this.#iframe.src = "about:blank";
    const hadFailure =
      this.#snapshotState.status === "error" ||
      this.#snapshotState.status === "stale";
    if (!hadFailure) this.#snapshotState.status = "closed";
    this.#disposePromise = (async () => {
      try {
        // Teardown is cooperative, but Stop and pane close must remain
        // immediate when an untrusted app has stopped answering.
        if (this.#bridge && this.#initialized)
          await this.#bridge
            .teardownResource({}, { timeout: 750 })
            .catch(() => undefined);
      } finally {
        await this.#messageTransport?.close().catch(() => undefined);
        this.#bridge = undefined;
        this.#messageTransport = undefined;
        this.#iframe = undefined;
        this.#unsubscribeTransportClose?.();
        this.#unsubscribeTransportClose = undefined;
        if (reason !== "MCP App closed") this.#snapshotState.error = reason;
        this.#publishState();
      }
    })();
    return this.#disposePromise;
  }

  #registerHandlers(bridge: AppBridge): void {
    bridge.oncalltool = async (params) => {
      if (
        !params ||
        typeof params.name !== "string" ||
        !isRecord(params.arguments)
      )
        return errorResult("MCP App requested an invalid tool call.");
      return this.#runAppTool(params.name, params.arguments);
    };
    if (this.#options.listResources) {
      bridge.onlistresources = async () => {
        this.#ensureCurrent();
        const resources = (await this.#options.listResources?.()) ?? [];
        this.#ensureCurrent();
        return {
          resources: resources.slice(0, 256).flatMap((resource) => {
            if (
              typeof resource.uri !== "string" ||
              resource.uri.length > 2_048 ||
              /[\u0000-\u001f\u007f]/u.test(resource.uri)
            )
              return [];
            return [
              {
                uri: resource.uri,
                name:
                  typeof resource.name === "string"
                    ? resource.name.slice(0, 256)
                    : "MCP resource",
                ...(typeof resource.description === "string"
                  ? { description: resource.description.slice(0, 2_048) }
                  : {}),
                ...(typeof resource.mimeType === "string"
                  ? { mimeType: resource.mimeType.slice(0, 128) }
                  : {}),
              },
            ];
          }),
        };
      };
    }
    bridge.onreadresource = async (params) => {
      this.#ensureCurrent();
      const uri = params?.uri;
      if (
        typeof uri !== "string" ||
        uri.length > 2_048 ||
        /[\u0000-\u001f\u007f]/u.test(uri)
      )
        return { contents: [] };
      if (uri === this.#resource?.uri) {
        return {
          contents: [
            {
              uri,
              mimeType: this.#resource.mimeType,
              text: this.#resource.html,
              _meta: { ui: this.#resource.metadata },
            },
          ],
        };
      }
      if (this.#inFlightAppResourceReads >= MAX_IN_FLIGHT_APP_RESOURCE_READS) {
        return { contents: [] };
      }
      this.#inFlightAppResourceReads += 1;
      try {
        const { proposal, prepared } =
          await this.#options.transport.prepareResourceRead(uri);
        const resolution = await this.#approve({
          request: prepared.approval,
          toolName: "resources/read",
          arguments: { uri },
        });
        if (!resolution) return { contents: [] };
        const result = await this.#executeApproved(proposal, resolution);
        const content =
          isRecord(result) && Array.isArray(result.content)
            ? result.content
            : [];
        return {
          contents: content.slice(0, 64).flatMap((item) => {
            if (!isRecord(item) || typeof item.text !== "string") return [];
            return [
              {
                uri,
                mimeType:
                  typeof item.mimeType === "string"
                    ? item.mimeType.slice(0, 128)
                    : "text/plain",
                text: item.text.slice(0, MAX_APP_MESSAGE_CHARACTERS),
              },
            ];
          }),
        };
      } catch {
        return { contents: [] };
      } finally {
        this.#inFlightAppResourceReads -= 1;
      }
    };
    bridge.onmessage = async (params) => {
      this.#ensureCurrent();
      if (!params?.content || !Array.isArray(params.content)) return {};
      const content = boundedClone(
        params.content,
        "message",
      ) as CallToolResult["content"];
      if (!this.#options.onMessage)
        throw new Error("Messages are unavailable in this host context.");
      this.#options.onMessage({ owner: owner(this.#options), content });
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      this.#ensureCurrent();
      if (!isRecord(params)) return {};
      if (!this.#options.onContextUpdate)
        throw new Error(
          "Context updates are unavailable in this host context.",
        );
      this.#options.onContextUpdate({
        owner: owner(this.#options),
        update: boundedClone(params ?? {}, "context update") as Record<
          string,
          unknown
        >,
      });
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      this.#ensureCurrent();
      if (typeof url !== "string") return { opened: false };
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { opened: false };
      }
      if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) return { opened: false };
      const opened =
        (await this.#options.onOpenLink?.(parsed.href, owner(this.#options))) ??
        false;
      return { isError: !opened };
    };
    bridge.onrequestdisplaymode = async ({ mode }) => {
      this.#ensureCurrent();
      const available =
        this.#options.hostContext?.availableDisplayModes ??
        (this.#options.onDisplayMode ? ["inline", "fullscreen"] : ["inline"]);
      const granted =
        mode === "fullscreen" && available.includes("fullscreen")
          ? "fullscreen"
          : "inline";
      this.#options.onDisplayMode?.(granted);
      return { mode: granted };
    };
    bridge.onrequestteardown = () => {
      this.#ensureCurrent();
      this.#options.onRequestTeardown?.();
      void this.dispose("MCP App requested teardown");
    };
    bridge.onsizechange = (size) => {
      this.#ensureCurrent();
      this.#options.onResize?.({
        ...(Number.isFinite(size.width)
          ? { width: Math.min(1600, Math.max(112, size.width!)) }
          : {}),
        ...(Number.isFinite(size.height)
          ? { height: Math.min(900, Math.max(112, size.height!)) }
          : {}),
      });
    };
    bridge.onloggingmessage = () => undefined;
  }

  async #runAppTool(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (this.#inFlightAppActions >= MAX_IN_FLIGHT_APP_ACTIONS)
      return errorResult(
        "MCP App has too many actions in progress; wait for one to finish.",
      );
    this.#inFlightAppActions += 1;
    try {
      this.#ensureReady();
      if (!/^[a-zA-Z0-9_.-]{1,128}$/u.test(toolName))
        return errorResult("MCP App requested an invalid tool name.");
      const boundedArguments = boundedClone(
        argumentsValue,
        "tool arguments",
      ) as Record<string, unknown>;
      const { proposal, prepared } =
        await this.#options.transport.prepareToolCall(
          toolName,
          boundedArguments,
        );
      const resolution = await this.#approve({
        request: prepared.approval,
        toolName,
        arguments: boundedArguments,
      });
      if (!resolution) return errorResult("Mivlet denied this MCP App action.");
      const result = await this.#executeApproved(proposal, resolution);
      return toMcpAppCallToolResult(result);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : "MCP App action failed.",
      );
    } finally {
      this.#inFlightAppActions -= 1;
    }
  }

  /** Every awaited authority transition rechecks the owning live session. */
  async #executeApproved(
    proposal: Parameters<DesktopMcpTransportHandle["authorizeToolCall"]>[0],
    resolution: ApprovalResolutionRequest,
  ): Promise<unknown> {
    this.#ensureCurrent();
    const permit = await this.#options.transport.authorizeToolCall(proposal, resolution);
    this.#ensureCurrent();
    const result = await this.#options.transport.executeAuthorizedToolCall(proposal, permit.permitId);
    this.#ensureCurrent();
    return result;
  }

  async #approve(input: {
    request: import("@mivlet/protocol").ApprovalRequest;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<ApprovalResolutionRequest | null> {
    this.#ensureCurrent();
    if (!this.#options.requestApproval) return null;
    return this.#options.requestApproval({
      owner: owner(this.#options),
      request: input.request,
      toolName: input.toolName,
      arguments: JSON.parse(JSON.stringify(input.arguments)) as Record<
        string,
        unknown
      >,
      source: "mcp-app",
      abortSignal: this.#approvalAbortController.signal,
    });
  }

  #allowedPermissions(
    requested?: McpUiResourcePermissions,
  ): McpUiResourcePermissions {
    const granted = this.#options.grantedPermissions ?? {};
    if (!requested) return {};
    return Object.fromEntries(
      Object.keys(requested)
        .filter((key) => key in granted)
        .map((key) => [key, {}]),
    ) as McpUiResourcePermissions;
  }

  #ensureReady(): void {
    this.#ensureCurrent();
    if (!this.#initialized || !this.#bridge)
      throw new Error("MCP App is not initialized.");
  }

  #ensureCurrent(): void {
    if (this.#disposed) throw new Error("MCP App is closed.");
    if (this.#options.isCurrent && !this.#options.isCurrent()) {
      if (this.#snapshotState.status !== "stale") {
        this.#snapshotState.status = "stale";
        this.#publishState();
      }
      throw new Error(
        "MCP App result is stale; reopen the current conversation result.",
      );
    }
  }
}
