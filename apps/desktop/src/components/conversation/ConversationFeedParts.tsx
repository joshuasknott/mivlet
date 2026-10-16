import { useState } from "react";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";
import {
  toolActivity,
  toolFailureSummary,
  type ResponsePart,
} from "../../lib/conversation-presentation";
import { MessageMarkdown } from "./MessageMarkdown";
import { McpAppResult } from "./McpAppResult";

export function ConversationFeedMessageTime({ value }: { value?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}

export function ConversationFeedPart({
  part,
  running,
  cancelled = false,
  onOpenConnector,
  workspaceId,
  conversationId,
  generation,
  isCurrent,
  onDraft,
  onMcpAppApproval,
  onMcpAppResourceRegister,
  onMcpAppResourceRelease,
}: {
  part: ResponsePart;
  running: boolean;
  cancelled?: boolean;
  onOpenConnector?: (connectorId: string) => void;
  workspaceId: string;
  conversationId: string;
  generation?: number;
  isCurrent?: () => boolean;
  onDraft?: (text: string) => void;
  onMcpAppApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<ApprovalResolutionRequest | null>;
  onMcpAppResourceRegister?: (
    resource: import("../../lib/mcp-app-host").McpAppResource | undefined,
    owner: { resultId: string; sessionId: string },
  ) => Promise<string | null>;
  onMcpAppResourceRelease?: (owner: {
    resultId: string;
    sessionId: string;
  }) => Promise<void>;
}) {
  const [appSessionId] = useState(() => crypto.randomUUID());
  if (part.kind === "text") return <MessageMarkdown content={part.content} />;
  if (part.kind === "notice")
    return (
      <p className={part.error ? "turn-warning" : "turn-notice"}>
        {part.content}
      </p>
    );
  const pending = part.state === "running" && !running;
  const halted = part.terminalStatus ?? (pending ? cancelled ? "cancelled" : "interrupted" : undefined);
  const failed = part.state === "failed" && !halted;
  return (
    <div
      className={`turn-tool${failed ? " turn-tool--failed" : ""}`}
    >
      <span aria-hidden="true">
        {part.state === "succeeded"
          ? "✓"
          : part.state === "failed" || pending
            ? "!"
            : "·"}
      </span>
      {halted
        ? halted === "cancelled" ? "Action cancelled" : "Action interrupted"
        : toolActivity(part.tool, part.state, part.connectorId)}
      {halted && part.content ? <p className="turn-notice">{toolFailureSummary(part.content)}</p> : null}
      {failed ? (
        <p className="turn-tool__error">
          {toolFailureSummary(part.content)}
          {part.connectorId &&
          onOpenConnector &&
          /connect|sign.in|permission|authoriz|access|expired/i.test(
            part.content,
          ) ? (
            <button
              type="button"
              onClick={() => onOpenConnector(part.connectorId!)}
            >
              Reconnect
            </button>
          ) : null}
        </p>
      ) : null}
      {part.state === "succeeded" && part.mcpApp && part.connectorId && part.resultRevisionId ? (
        <McpAppResult
          descriptor={part.mcpApp}
          resultId={part.resultRevisionId}
          output={part.content}
          toolInput={part.toolInput}
          isCurrent={isCurrent}
          onDraft={onDraft}
          workspaceId={workspaceId}
          conversationId={conversationId}
          generation={generation}
          requestApproval={onMcpAppApproval}
          registerResource={(resource) =>
            onMcpAppResourceRegister?.(resource, {
              resultId: part.resultRevisionId!,
              sessionId: appSessionId,
            }) ?? Promise.resolve(null)
          }
          releaseResource={() =>
            onMcpAppResourceRelease?.({
              resultId: part.resultRevisionId!,
              sessionId: appSessionId,
            }) ?? Promise.resolve()
          }
        />
      ) : null}
    </div>
  );
}
