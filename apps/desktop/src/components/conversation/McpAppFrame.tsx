import { useEffect, useMemo, useRef, useState } from "react";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DesktopMcpTransportHandle } from "../../lib/mcp-transport-contract";
import {
  McpAppHostSession,
  srcDocForMcpApp,
  type McpAppApprovalPreview,
  type McpAppSessionSnapshot,
} from "../../lib/mcp-app-host";
import "./mcp-app-frame.css";

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
  requestApproval?: (preview: McpAppApprovalPreview) => Promise<import("@mivlet/protocol").ApprovalResolutionRequest | null>;
  onMessage?: (message: Parameters<NonNullable<import("../../lib/mcp-app-host").McpAppHostOptions["onMessage"]>>[0]) => void;
  onContextUpdate?: (update: Parameters<NonNullable<import("../../lib/mcp-app-host").McpAppHostOptions["onContextUpdate"]>>[0]) => void;
  onOpenLink?: (url: string, owner: McpAppApprovalPreview["owner"]) => Promise<boolean>;
  onResize?: (size: { width?: number; height?: number }) => void;
  onRequestTeardown?: () => void;
  listTools?: () => Promise<readonly Tool[]>;
  listResources?: () => Promise<readonly { uri: string; name: string; description?: string; mimeType?: string }[]>;
  grantedPermissions?: McpUiResourcePermissions;
  hostContext?: import("@modelcontextprotocol/ext-apps/app-bridge").McpUiHostContext;
  title?: string;
}

type ViewState = { status: "loading" | "ready" | "error" | "stale"; message?: string };

/**
 * Production conversation slot for one MCP App result. The host controls the
 * iframe lifecycle; the guest only receives the official AppBridge protocol.
 */
export function McpAppFrame(props: McpAppFrameProps) {
  const sessionRef = useRef<McpAppHostSession | undefined>(undefined);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [resourceDoc, setResourceDoc] = useState<string>();
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [snapshot, setSnapshot] = useState<McpAppSessionSnapshot>({ status: "loading" });

  const identity = `${props.workspaceId}:${props.conversationId}:${props.resultId}:${props.generation}`;
  const session = useMemo(() => new McpAppHostSession({
    workspaceId: props.workspaceId,
    conversationId: props.conversationId,
    resultId: props.resultId,
    generation: props.generation,
    transport: props.transport,
    tool: props.tool,
    isCurrent: props.isCurrent,
    requestApproval: props.requestApproval,
    onMessage: props.onMessage,
    onContextUpdate: props.onContextUpdate,
    onOpenLink: props.onOpenLink,
    onResize: props.onResize,
    onRequestTeardown: props.onRequestTeardown,
    listTools: props.listTools,
    listResources: props.listResources,
    grantedPermissions: props.grantedPermissions,
    hostContext: props.hostContext,
  }), [identity]);

  useEffect(() => {
    sessionRef.current = session;
    let active = true;
    setView({ status: "loading" });
    setResourceDoc(undefined);
    void session.loadResource().then((resource) => {
      if (!active) return;
      setResourceDoc(srcDocForMcpApp(resource));
      setSnapshot(session.snapshot());
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "MCP App could not be loaded.";
      setView({ status: message.includes("stale") ? "stale" : "error", message });
      setSnapshot(session.snapshot());
    });
    return () => {
      active = false;
      if (sessionRef.current === session) sessionRef.current = undefined;
      void session.dispose();
    };
  }, [session]);

  useEffect(() => {
    return props.transport.subscribeClose(() => {
      setView({ status: "error", message: "The MCP connection closed; reconnect before reopening this result." });
      setSnapshot(session.snapshot());
    });
  }, [props.transport, session]);

  useEffect(() => {
    if (!resourceDoc || !iframeRef.current) return;
    let active = true;
    void session.attach(iframeRef.current).then(() => {
      if (!active) return;
      setView({ status: "ready" });
      setSnapshot(session.snapshot());
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "MCP App handshake failed.";
      setView({ status: message.includes("stale") ? "stale" : "error", message });
      setSnapshot(session.snapshot());
    });
    return () => { active = false; };
  }, [resourceDoc, session]);

  useEffect(() => {
    if (view.status !== "ready" || !props.toolInput) return;
    void session.sendToolInput(props.toolInput).catch(() => undefined);
  }, [view.status, props.toolInput, session]);

  useEffect(() => {
    if (view.status !== "ready" || !props.toolResult) return;
    void session.sendToolResult(props.toolResult).catch(() => undefined);
  }, [view.status, props.toolResult, session]);

  return <section className="mcp-app-frame" aria-label={props.title ?? "Interactive MCP App"} data-status={view.status}>
    {view.status === "loading" && <p className="mcp-app-frame__status" role="status">Loading interactive result…</p>}
    {(view.status === "error" || view.status === "stale") && <div className="mcp-app-frame__status mcp-app-frame__status--error" role="alert">
      <strong>{view.status === "stale" ? "This result is no longer current" : "Interactive result unavailable"}</strong>
      <span>{view.message}</span>
    </div>}
    {resourceDoc && (view.status === "loading" || view.status === "ready") && <iframe
      ref={iframeRef}
      className="mcp-app-frame__iframe"
      title={props.title ?? snapshot.appName ?? "Interactive MCP App"}
      srcDoc="<!doctype html><html><body></body></html>"
      sandbox="allow-scripts"
      allow={snapshot.resource?.allow}
      referrerPolicy="no-referrer"
      onLoad={() => setSnapshot(session.snapshot())}
    />}
  </section>;
}
