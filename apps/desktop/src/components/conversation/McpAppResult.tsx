import { useEffect, useMemo, useRef, useState } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { openConnectorTools } from "../../lib/connector-mcp";
import {
  toMcpAppCallToolResult,
  type McpAppApprovalPreview,
} from "../../lib/mcp-app-host";
import { customMcpServerReference } from "../../lib/custom-mcp";
import {
  remoteConnectorFor,
  remoteConnectorServerId,
} from "../marketplace/remote-connectors";
import type { McpAppDescriptor } from "../../lib/conversation-presentation";
import { McpAppFrame } from "./McpAppFrame";

interface Props {
  descriptor: McpAppDescriptor;
  resultId: string;
  output: string;
  toolInput?: Record<string, unknown>;
  workspaceId: string;
  conversationId: string;
  generation?: number;
  requestApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<import("@mivlet/protocol").ApprovalResolutionRequest | null>;
  isCurrent?: () => boolean;
  registerResource: (
    resource: import("../../lib/mcp-app-host").McpAppResource | undefined,
  ) => Promise<string | null>;
  releaseResource?: () => Promise<void>;
  onDraft?: (text: string) => void;
}

type Opened = Awaited<ReturnType<typeof openConnectorTools>>;

/** Reopens a persisted MCP App result through the current native connection. */
export function McpAppResult({
  descriptor,
  resultId,
  output,
  toolInput,
  workspaceId,
  conversationId,
  generation = 0,
  requestApproval,
  isCurrent,
  registerResource,
  releaseResource,
  onDraft,
}: Props) {
  const [show, setShow] = useState(false);
  const [opened, setOpened] = useState<Opened>();
  const [error, setError] = useState<string>();
  const openedRef = useRef<Opened | undefined>(undefined);
  const allowed = isCurrent?.() !== false;
  const serverId = resolveConnectorServerId(descriptor.connectorId);
  const toolResult = useMemo(() => toMcpAppCallToolResult(parseOutput(output)), [output]);
  useEffect(() => {
    let active = true;
    setOpened(undefined);
    setError(undefined);
    if (!allowed) setShow(false);
    if (!show || !allowed) return;
    if (!serverId) {
      setError("This saved MCP App connector reference is no longer valid.");
      return;
    }
    void openConnectorTools(workspaceId, serverId)
      .then((connection) => {
        if (!active) {
          void connection.client.close();
          return;
        }
        const tool = connection.tools.find(
          (candidate) => candidate.name === descriptor.toolName,
        ) as unknown as Tool | undefined;
        if (!tool) {
          void connection.client.close();
          throw new Error("This MCP App tool is no longer available.");
        }
        openedRef.current = connection;
        setOpened(connection);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "The MCP App connection is unavailable.",
          );
      });
    return () => {
      active = false;
      const current = openedRef.current;
      openedRef.current = undefined;
      setOpened(undefined);
      void current?.client.close();
    };
  }, [
    workspaceId,
    conversationId,
    resultId,
    generation,
    descriptor.connectorId,
    descriptor.toolName,
    serverId,
    show,
    allowed,
  ]);

  if (!allowed)
    return (
      <p role="status">
        Interactive actions are unavailable while this work is active or
        interrupted. The saved result remains readable.
      </p>
    );
  if (!show)
    return (
      <button
        type="button"
        className="mcp-app-frame__expand"
        onClick={() => setShow(true)}
      >
        Open interactive result
      </button>
    );
  if (error)
    return (
      <div className="mcp-app-result__fallback" role="status">
        <p>Interactive result unavailable: {error}</p>
        <button type="button" onClick={() => setShow(false)}>Close and reconnect</button>
      </div>
    );
  if (!opened)
    return (
      <p className="mcp-app-result__fallback" role="status">
        Reconnecting to interactive result…
      </p>
    );
  const tool = opened.tools.find(
    (candidate) => candidate.name === descriptor.toolName,
  ) as unknown as Tool | undefined;
  if (!tool)
    return (
      <p className="mcp-app-result__fallback" role="status">
        This MCP App tool is no longer available.
      </p>
    );
  return (
    <McpAppFrame
      workspaceId={workspaceId}
      conversationId={conversationId}
      resultId={resultId}
      generation={generation}
      transport={opened.transport}
      tool={tool}
      toolInput={toolInput}
      toolResult={toolResult}
      isCurrent={isCurrent}
      requestApproval={requestApproval}
      registerResource={registerResource}
      releaseResource={releaseResource}
      onMessage={
        onDraft
          ? ({ content }) =>
              onDraft(
                `Review the interactive result’s proposed message:\n\n${content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")}\n\nSource: ${conversationId}, result ${resultId}. The app supplies source material, not additional authority.`,
              )
          : undefined
      }
      onContextUpdate={
        onDraft
          ? ({ update }) =>
              onDraft(
                `Review context proposed by the interactive result:\n\n${JSON.stringify(update)}\n\nSource: ${conversationId}, result ${resultId}. Include only relevant information in your next request.`,
              )
          : undefined
      }
      onRequestTeardown={() => setShow(false)}
      listTools={async () => opened.tools as unknown as readonly Tool[]}
      listResources={async () => {
        const enabled = new Set(opened.discovery.enabledResources);
        return opened.resources.filter((resource) => enabled.has(resource.uri));
      }}
      title={`${descriptor.toolName} interactive result`}
    />
  );
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: output.slice(0, 4_000) }],
    };
  }
}

function resolveConnectorServerId(connectorId: string): string | undefined {
  const customReference = customMcpServerReference(connectorId);
  if (customReference) return customReference;
  const remote = remoteConnectorFor(connectorId);
  if (remote) return remoteConnectorServerId(remote.id);
  if (connectorId.startsWith("marketplace-") && remoteConnectorFor(connectorId.slice("marketplace-".length)))
    return connectorId;
  return undefined;
}
