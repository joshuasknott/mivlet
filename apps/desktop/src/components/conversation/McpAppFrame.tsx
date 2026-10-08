import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DesktopMcpTransportHandle } from "../../lib/mcp-transport-contract";
import {
  McpAppHostSession,
  type McpAppApprovalPreview,
  type McpAppHostOptions,
  type McpAppResource,
  type McpAppSessionSnapshot,
} from "../../lib/mcp-app-host";
import "./mcp-app-frame.css";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export interface McpAppFrameProps {
  workspaceId: string;
  conversationId: string;
  resultId: string;
  generation: number;
  transport: DesktopMcpTransportHandle;
  tool: Tool;
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult;
  isCurrent?: () => boolean;
  requestApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<import("@mivlet/protocol").ApprovalResolutionRequest | null>;
  onMessage?: (
    message: Parameters<
      NonNullable<
        import("../../lib/mcp-app-host").McpAppHostOptions["onMessage"]
      >
    >[0],
  ) => void;
  onContextUpdate?: (
    update: Parameters<
      NonNullable<
        import("../../lib/mcp-app-host").McpAppHostOptions["onContextUpdate"]
      >
    >[0],
  ) => void;
  onOpenLink?: (
    url: string,
    owner: McpAppApprovalPreview["owner"],
  ) => Promise<boolean>;
  onResize?: (size: { width?: number; height?: number }) => void;
  onRequestTeardown?: () => void;
  registerResource: (
    resource: McpAppResource,
  ) => Promise<string | null>;
  releaseResource?: () => Promise<void>;
  listTools?: () => Promise<readonly Tool[]>;
  listResources?: () => Promise<
    readonly {
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }[]
  >;
  grantedPermissions?: McpUiResourcePermissions;
  hostContext?: import("@modelcontextprotocol/ext-apps/app-bridge").McpUiHostContext;
  title?: string;
}

type ViewState = {
  status: "loading" | "ready" | "error" | "stale";
  message?: string;
};

/**
 * Production conversation slot for one MCP App result. The host controls the
 * iframe lifecycle; the guest only receives the official AppBridge protocol.
 */
export function McpAppFrame(props: McpAppFrameProps) {
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Raw app HTML stays in the native ephemeral
  // resource registry and is never copied into renderer state or srcdoc.
  const [resourceUrl, setResourceUrl] = useState<string>();
  const [height, setHeight] = useState(240);
  const [expanded, setExpanded] = useState(false);
  const panelId = `mcp-app:${props.workspaceId}:${props.conversationId}:${props.resultId}:${props.generation}`;
  const [panelTarget, setPanelTarget] = useState<HTMLElement | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const frameRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ active: expanded, containerRef: frameRef, initialFocusRef: expandRef, onClose: () => setExpanded(false) });
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [snapshot, setSnapshot] = useState<McpAppSessionSnapshot>({
    status: "loading",
  });

  useEffect(() => {
    const onPanelReady = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const candidate = detail as Record<string, unknown>;
      if (
        candidate.id !== panelId ||
        !(candidate.target instanceof HTMLElement) ||
        candidate.target === panelTarget
      )
        return;
      setPanelTarget(candidate.target);
      // React recreates a portal subtree when its container changes. Dispose
      // and renegotiate explicitly so the guest never keeps a stale bridge or
      // silently replays a tool action after docking in the right panel.
      setSessionEpoch((epoch) => epoch + 1);
    };
    const onPanelClosed = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      if ((detail as Record<string, unknown>).id !== panelId) return;
      setPanelTarget(null);
      setExpanded(false);
    };
    window.addEventListener("mivlet:mcp-app-panel-ready", onPanelReady);
    window.addEventListener("mivlet:mcp-app-panel-closed", onPanelClosed);
    return () => {
      window.removeEventListener("mivlet:mcp-app-panel-ready", onPanelReady);
      window.removeEventListener("mivlet:mcp-app-panel-closed", onPanelClosed);
    };
  }, [panelId, panelTarget]);

  useEffect(() => {
    if (!expanded) {
      if (panelTarget) {
        setPanelTarget(null);
        setSessionEpoch((epoch) => epoch + 1);
      }
      return;
    }
    window.dispatchEvent(
      new CustomEvent("mivlet:mcp-app-expand", {
        detail: {
          id: panelId,
          workspaceId: props.workspaceId,
          conversationId: props.conversationId,
          resultId: props.resultId,
          generation: props.generation,
          title: props.title ?? "Interactive MCP App",
        },
      }),
    );
  }, [expanded, panelId, panelTarget, props.workspaceId, props.conversationId, props.resultId, props.generation, props.title]);

  useEffect(() => {
    if (!panelTarget) return;
    const observer = new MutationObserver(() => {
      if (!panelTarget.isConnected) {
        setPanelTarget(null);
        setSessionEpoch((epoch) => epoch + 1);
        setExpanded(false);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [panelTarget]);

  const identity = `${props.workspaceId}:${props.conversationId}:${props.resultId}:${props.generation}:${sessionEpoch}`;
  // Parent callbacks are intentionally inline and change as runtime state
  // updates. Keep those authority callbacks live without recreating the guest
  // session on every render. Capability shape changes still restart the host
  // so AppBridge cannot retain a capability that was just withdrawn.
  const capabilityShape = [
    props.requestApproval,
    props.onMessage,
    props.onContextUpdate,
    props.onOpenLink,
    props.onRequestTeardown,
    props.listTools,
    props.listResources,
  ]
    .map((callback) => (callback ? "1" : "0"))
    .join("");
  const [session, setSession] = useState<McpAppHostSession | null>(null);

  useEffect(() => {
    // A host session is disposable and cannot be reused after cleanup. Create
    // it inside the effect lifetime so React StrictMode's setup/cleanup replay
    // receives a fresh bridge instead of reusing the already-closed memoized
    // instance.
    // Advertise only present callbacks, but read their latest implementation
    // when invoked. Capability-shape changes recreate the session below.
    function live<K extends "requestApproval" | "onMessage" | "onContextUpdate" | "onOpenLink" | "listTools" | "listResources">(key: K): McpAppHostOptions[K] {
      if (!latestPropsRef.current[key]) return undefined;
      return ((...args: unknown[]) => {
        const callback = latestPropsRef.current[key];
        if (!callback) throw new Error("The MCP App capability is no longer available.");
        return Reflect.apply(callback, undefined, args);
      }) as McpAppHostOptions[K];
    }
    const nextSession = new McpAppHostSession({
      workspaceId: props.workspaceId,
      conversationId: props.conversationId,
      resultId: props.resultId,
      generation: props.generation,
      transport: props.transport,
      tool: props.tool,
      isCurrent: () => latestPropsRef.current.isCurrent?.() ?? true,
      requestApproval: live("requestApproval"),
      onMessage: live("onMessage"),
      onContextUpdate: live("onContextUpdate"),
      onOpenLink: live("onOpenLink"),
      onResize: (size) => {
        if (size.height) setHeight(size.height);
        latestPropsRef.current.onResize?.(size);
      },
      onDisplayMode: (mode) => setExpanded(mode === "fullscreen"),
      onRequestTeardown: () => latestPropsRef.current.onRequestTeardown?.(),
      listTools: live("listTools"),
      listResources: live("listResources"),
      grantedPermissions: props.grantedPermissions,
      hostContext: props.hostContext,
    });
    setSession(nextSession);
    return () => {
      void nextSession.dispose();
    };
  }, [identity, props.transport, props.tool, props.grantedPermissions, props.hostContext, capabilityShape]);

  useEffect(() => {
    let active = true;
    if (!session) return;
    const unsubscribe = session.subscribeState((next) => {
      if (!active) return;
      setSnapshot(next);
      if (next.status === "error" || next.status === "stale") {
        setView({
          status: next.status,
          message: next.error ?? "The interactive result is no longer available.",
        });
      } else if (next.status === "ready") {
        setView({ status: "ready" });
      } else if (next.status === "loading") {
        setView({ status: "loading" });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    // Keep the resource token paired with the callbacks that created it. A
    // later render may belong to another runtime scope, so cleanup must never
    // release through a newer callback.
    const registerResource = props.registerResource;
    const releaseResource = props.releaseResource;
    setView({ status: "loading" });
    setResourceUrl(undefined);
    void session
      .loadResource()
      .then(async (resource) => {
        if (!active) return;
        if (latestPropsRef.current.isCurrent && !latestPropsRef.current.isCurrent())
          throw new Error("MCP App result is stale; reopen the current conversation result.");
        const url = await registerResource(resource);
        if (!url)
          throw new Error(
            "The dedicated MCP App sandbox is unavailable in this desktop runtime.",
          );
        if (!active) {
          // The pane may have closed while the native registration was in
          // flight. Release the late resource instead of leaving a live token
          // behind until its TTL.
          await releaseResource?.();
          return;
        }
        if (latestPropsRef.current.isCurrent && !latestPropsRef.current.isCurrent()) {
          await releaseResource?.();
          throw new Error("MCP App result is stale; reopen the current conversation result.");
        }
        setResourceUrl(url);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message =
          error instanceof Error
            ? error.message
            : "MCP App could not be loaded.";
        setView({
          status: message.includes("stale") ? "stale" : "error",
          message,
        });
      });
    return () => {
      active = false;
      void releaseResource?.();
    };
  }, [session]);

  useEffect(() => {
    if (!session || !resourceUrl || !iframeRef.current) return;
    let active = true;
    void session
      .attach(iframeRef.current, resourceUrl)
      .then(() => {
        if (!active) return;
        setView({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message =
          error instanceof Error ? error.message : "MCP App handshake failed.";
        setView({
          status: message.includes("stale") ? "stale" : "error",
          message,
        });
      });
    return () => {
      active = false;
    };
  }, [resourceUrl, session]);

  const inputKey = JSON.stringify(props.toolInput);
  const resultKey = JSON.stringify(props.toolResult);
  useEffect(() => {
    if (!session || view.status !== "ready" || !props.toolInput) return;
    void session.sendToolInput(props.toolInput).catch(() => undefined);
  }, [view.status, inputKey, session]);

  useEffect(() => {
    if (!session || view.status !== "ready" || !props.toolResult) return;
    void session.sendToolResult(props.toolResult).catch(() => undefined);
  }, [view.status, resultKey, session]);

  const frame = (
    <section
      ref={frameRef}
      role={expanded && !panelTarget ? "dialog" : undefined}
      aria-modal={(expanded && !panelTarget) || undefined}
      className={`mcp-app-frame${expanded ? " mcp-app-frame--expanded" : ""}${panelTarget ? " mcp-app-frame--panel" : ""}`}
      aria-label={props.title ?? "Interactive MCP App"}
      data-status={view.status}
    >
      <div className="mcp-app-frame__controls">
      <button
        ref={expandRef}
        type="button"
        className="mcp-app-frame__expand"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? "Return to conversation" : "Expand interactive result"}
      </button>
      {props.onRequestTeardown ? (
        <button type="button" className="mcp-app-frame__expand" onClick={props.onRequestTeardown}>
          Close interactive result
        </button>
      ) : null}
      </div>
      {view.status === "loading" && (
        <p className="mcp-app-frame__status" role="status">
          Loading interactive result…
        </p>
      )}
      {(view.status === "error" || view.status === "stale") && (
        <div
          className="mcp-app-frame__status mcp-app-frame__status--error"
          role="alert"
        >
          <strong>
            {view.status === "stale"
              ? "This result is no longer current"
              : "Interactive result unavailable"}
          </strong>
          <span>{view.message}</span>
          {props.onRequestTeardown ? <button type="button" onClick={props.onRequestTeardown}>Close and reconnect</button> : null}
        </div>
      )}
      {resourceUrl &&
        (view.status === "loading" || view.status === "ready") && (
          <iframe
            ref={iframeRef}
            className="mcp-app-frame__iframe"
            title={props.title ?? snapshot.appName ?? "Interactive MCP App"}
            // Keep the initial document inert. McpAppHostSession installs the
            // AppBridge listener first, then assigns the isolated loopback URL.
            src="about:blank"
            style={{ height: expanded ? "calc(100dvh - 120px)" : height }}
            sandbox="allow-scripts"
            allow={snapshot.resource?.allow}
            referrerPolicy="no-referrer"
          />
      )}
    </section>
  );
  return panelTarget ? createPortal(frame, panelTarget) : frame;
}
