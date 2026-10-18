import { memo, useEffect, useMemo, useState } from "react";
import type {
  ConnectorManifest,
  MivletAgentProfile,
  Spine,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import type { ConversationTurn } from "../../lib/conversation-presentation-types";
import { displayWorkspaceMentions } from "../../lib/collaboration-mentions";
import { toolActivity } from "../../lib/conversation-presentation";
import { publishedArtifactParts } from "../../lib/conversation-artifacts";
import { agentPresence } from "../../lib/agent-presence";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { ConnectorMentionText } from "../ConnectorMention";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { CopyButton } from "../CopyButton";
import { AssistantMessageActions } from "./AssistantMessageActions";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageAttachments } from "./MessageAttachments";
import { ResponseSelection } from "./ResponseSelection";
import { GeneratedResponse } from "./generated/GeneratedResponse";
import {
  ConversationFeedMessageTime,
  ConversationFeedPart,
} from "./ConversationFeedParts";
import type { ConversationFeedProps as Props } from "./conversation-feed-types";

export function ConversationUserMessage({
  content,
  profileName,
  connectors,
  attachments,
  timestamp,
  workspaceId,
  agent,
  threadId,
  messageId,
}: {
  content: string;
  profileName: string;
  connectors: ConnectorManifest[];
  attachments?: readonly Spine.Conversations.ConversationAttachmentMetadata[];
  timestamp?: string;
  workspaceId: string;
  agent: MivletAgentProfile;
  threadId?: string;
  messageId?: string;
}) {
  return (
    <article
      className="conversation-message conversation-message--user"
      aria-label={`${profileName}'s message`}
      data-conversation-message-id={messageId}
    >
      <p>
        <ConnectorMentionText
          text={displayWorkspaceMentions(content)}
          connectors={connectors}
        />
      </p>
      {attachments?.length ? (
        <MessageAttachments
          key={`${workspaceId}:${agent.id}:${threadId}`}
          attachments={attachments}
          workspaceId={workspaceId}
          agentId={agent.id}
          threadId={threadId}
        />
      ) : null}
      <footer className="message-actions">
        <ConversationFeedMessageTime value={timestamp} />
        {!messageId ? (
          <CopyButton text={content} label="Copy message" iconOnly />
        ) : null}
      </footer>
      {messageId ? <AssistantMessageActions messageId={messageId} /> : null}
    </article>
  );
}

type TurnProps = Pick<
  Props,
  | "agent"
  | "profileName"
  | "connectors"
  | "workspaceId"
  | "threadId"
  | "showAuthor"
  | "requireAuthor"
  | "presence"
  | "approval"
  | "interruption"
  | "generation"
  | "appGeneration"
  | "isMcpRunCurrent"
  | "onOpenConnector"
  | "onPreviewArtifact"
  | "onDraftResponse"
  | "onSaveMemory"
  | "onPinResponse"
  | "onDraftPreview"
  | "onMcpAppApproval"
  | "onMcpAppResourceRegister"
  | "onMcpAppResourceRelease"
  | "onOpenWorkspaceFiles"
> & {
  turn: ConversationTurn;
  live: boolean;
  state?: NativeAgentState;
  receipt?: NonNullable<NativeAgentState["progressReceipts"]>[string];
  awaitingApproval: boolean;
};

// Completed turns receive only their own receipt, never the changing live state.
export const ConversationTurnView = memo(function ConversationTurnView({
  turn,
  live,
  receipt,
  awaitingApproval,
  ...props
}: TurnProps) {
  const running = Boolean(live && props.state?.running);
  const [disclosure, setDisclosure] = useState({ running, open: false });
  const expanded = disclosure.running === running && disclosure.open;
  const [clock, setClock] = useState(Date.now());
  const [savedSummary, setSavedSummary] = useState("");
  const summary = live
    ? Object.values(props.state?.reasoningSummaries ?? {}).join("\n\n")
    : Object.values(receipt?.summaries ?? {}).join("\n\n") || savedSummary;
  useEffect(() => {
    if (live && summary) setSavedSummary(summary);
  }, [live, summary]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const startedAt = receipt?.startedAt ?? turn.startedAt;
  const endedAt = receipt?.endedAt ?? turn.endedAt;
  const elapsed = startedAt
    ? Math.max(
        0,
        Math.floor(
          ((running ? clock : Date.parse(endedAt ?? startedAt)) -
            Date.parse(startedAt)) /
            1000,
        ),
      )
    : 0;
  const duration =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;
  const lastText = turn.parts.reduce(
    (last, part, index) => (part.kind === "text" ? index : last),
    -1,
  );
  const lastTool = turn.parts.reduce(
    (last, part, index) => (part.kind === "tool" ? index : last),
    -1,
  );
  const final =
    !running && lastText >= 0 && lastText > lastTool
      ? turn.parts[lastText]
      : undefined;
  const work = turn.parts.filter(
    (part, index) => part.kind !== "notice" && (!final || index !== lastText),
  );
  const notices = turn.parts.filter(
    (part) =>
      part.kind === "notice" &&
      (!live ||
        (!props.state?.lastError && props.state?.status !== "cancelled")),
  );
  const failed = work.filter(
    (part) =>
      part.kind === "tool" && part.state === "failed" && !part.terminalStatus,
  ).length;
  const files = useMemo(() => publishedArtifactParts(turn.parts), [turn.parts]);
  const savedFile = turn.parts.some(
    (part) =>
      part.kind === "tool" &&
      part.state === "succeeded" &&
      ["write-file", "create-document", "create-spreadsheet"].includes(
        part.tool,
      ),
  );
  const stopped = live && props.state?.status === "cancelled";
  const cancelled =
    turn.parts.some(
      (part) =>
        (part.kind === "tool" && part.terminalStatus === "cancelled") ||
        (part.kind === "notice" && part.status === "cancelled"),
    ) || stopped;
  const danglingTool =
    !live &&
    !cancelled &&
    turn.parts.some((part) => part.kind === "tool" && part.state === "running");
  const interrupted =
    turn.parts.some(
      (part) =>
        (part.kind === "notice" && part.status === "interrupted") ||
        (part.kind === "tool" && part.terminalStatus === "interrupted"),
    ) ||
    (live && props.state?.status === "interrupted") ||
    danglingTool;
  const recoveredToolFailure =
    Boolean(final?.kind === "text" && final.content.trim()) ||
    work.some((part) => part.kind === "tool" && part.state === "succeeded");
  const failedTerminal =
    (live && props.state?.status === "failed") ||
    turn.parts.some((part) => part.kind === "notice" && part.error) ||
    (work.some(
      (part) =>
        part.kind === "tool" && part.state === "failed" && !part.terminalStatus,
    ) &&
      !recoveredToolFailure);
  const label = interrupted
    ? `Interrupted${elapsed > 0 ? ` · ${duration}` : ""}`
    : failedTerminal
      ? `Failed${elapsed > 0 ? ` · ${duration}` : ""}`
      : cancelled
        ? `Cancelled${elapsed > 0 ? ` · ${duration}` : ""}`
        : elapsed > 0
          ? `Worked for ${duration}`
          : "Worked";
  const hasActivity =
    work.length > 0 ||
    Boolean(summary) ||
    running ||
    interrupted ||
    failedTerminal ||
    cancelled;
  const currentTool = [...turn.parts]
    .reverse()
    .find((part) => part.kind === "tool" && part.state === "running");
  const activity =
    props.state?.activity ||
    (currentTool?.kind === "tool"
      ? toolActivity(currentTool.tool, "running")
      : "");
  if (!turn.parts.length && !running && !live)
    return turn.prompt ? (
      <ConversationUserMessage
        content={turn.prompt}
        attachments={turn.attachments}
        timestamp={turn.startedAt}
        {...props}
      />
    ) : null;
  return (
    <section className="conversation-turn">
      {turn.prompt ? (
        <ConversationUserMessage
          content={turn.prompt}
          messageId={turn.promptMessageId}
          attachments={turn.attachments}
          timestamp={turn.startedAt}
          {...props}
        />
      ) : null}
      <article
        className="conversation-response"
        aria-label={`${props.agent.name}'s response`}
        data-conversation-message-id={turn.responseMessageId}
        data-conversation-revision-id={turn.responseRevisionId}
      >
        {props.showAuthor !== false || props.requireAuthor ? (
          <header className="conversation-response__author">
            <ProfileAgentAvatar
              agent={props.agent}
              iconSize={28}
              motion={live ? "expressive" : "quiet"}
              presence={
                live
                  ? (props.presence ??
                    (props.state
                      ? agentPresence(props.state, Boolean(props.approval))
                      : "idle"))
                  : "idle"
              }
              activityKey={`${props.agent.id}:${turn.id}`}
            />
            <strong>{props.agent.name}</strong>
          </header>
        ) : null}
        {hasActivity ? (
          <details className="turn-activity" open={running || expanded}>
            <summary
              hidden={running}
              onClick={(event) => {
                event.preventDefault();
                setDisclosure({ running, open: !expanded });
              }}
            >
              <span>{label}</span>
              <svg
                className="turn-chevron"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="m4.5 2.5 3.5 3.5-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {failed ? (
                <span className="turn-warning">
                  {" "}
                  · {failed} failed {failed === 1 ? "attempt" : "attempts"}
                </span>
              ) : null}
            </summary>
            {running || expanded ? (
              <div className="turn-activity__body">
                {summary ? <MessageMarkdown content={summary} /> : null}
                {work.map((part) => (
                  <ConversationFeedPart
                    key={`${part.kind}:${part.id}`}
                    part={part}
                    running={running}
                    cancelled={cancelled}
                    onOpenConnector={props.onOpenConnector}
                    workspaceId={props.workspaceId}
                    agentId={props.agent.id}
                    conversationId={props.threadId ?? turn.id}
                    generation={props.appGeneration}
                    isCurrent={() => props.isMcpRunCurrent?.(turn.id) !== false}
                    onDraft={props.onDraftResponse}
                    sourceRunId={turn.id}
                    onDraftPreview={props.onDraftPreview}
                    onMcpAppApproval={props.onMcpAppApproval}
                    onMcpAppResourceRegister={props.onMcpAppResourceRegister}
                    onMcpAppResourceRelease={props.onMcpAppResourceRelease}
                  />
                ))}
              </div>
            ) : null}
          </details>
        ) : null}
        {running && (awaitingApproval || (!work.length && !summary)) ? (
          <p className="turn-current" role="status">
            {awaitingApproval
              ? "Waiting for your approval"
              : activity || "Thinking…"}
          </p>
        ) : null}
        {final?.kind === "text" ? (
          <div className="turn-answer">
            <ResponseSelection
              text={final.content}
              workspaceId={props.workspaceId}
              conversationId={props.threadId ?? ""}
              runId={turn.id}
              agentId={props.agent.id}
              responseMessageId={turn.responseMessageId}
              responseRevisionId={turn.responseRevisionId}
              source={turn.responseSource}
              streaming={running}
              onDraft={props.onDraftResponse ?? (() => undefined)}
              onSaveMemory={
                props.onSaveMemory ??
                (async () => {
                  throw new Error(
                    "Memory is unavailable for this conversation.",
                  );
                })
              }
              onPin={
                props.onPinResponse
                  ? (selection, source) =>
                      props.onPinResponse!(
                        selection,
                        source,
                        turn.id,
                        props.agent.id,
                      )
                  : undefined
              }
            >
              <GeneratedResponse
                text={final.content}
                streaming={running}
                workspaceId={props.workspaceId}
                conversationId={props.threadId ?? ""}
                runId={turn.id}
                agentId={props.agent.id}
                generation={props.generation}
                source={turn.responseSource}
                responseRevisionId={turn.responseRevisionId}
                onDraft={props.onDraftResponse ?? (() => undefined)}
              />
            </ResponseSelection>
          </div>
        ) : null}
        {notices.map((part) => (
          <ConversationFeedPart
            key={`${part.kind}:${part.id}`}
            part={part}
            running={false}
            workspaceId={props.workspaceId}
            agentId={props.agent.id}
            conversationId={props.threadId ?? turn.id}
            generation={props.appGeneration}
            isCurrent={() => props.isMcpRunCurrent?.(turn.id) !== false}
            onDraft={props.onDraftResponse}
            onMcpAppApproval={props.onMcpAppApproval}
            onMcpAppResourceRegister={props.onMcpAppResourceRegister}
            onMcpAppResourceRelease={props.onMcpAppResourceRelease}
          />
        ))}
        {files.length ? (
          <div className="turn-files" aria-label="Files from this response">
            {files.map((part) => (
              <ComputerArtifacts
                key={part.id}
                output={part.content}
                workspaceId={props.workspaceId}
                agentId={props.agent.id}
                expectedGeneration={props.generation}
                onPreview={
                  props.onPreviewArtifact
                    ? (output) =>
                        props.onPreviewArtifact!(
                          output,
                          props.agent.id,
                          part.id,
                        )
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
        {savedFile &&
        !files.length &&
        props.onOpenWorkspaceFiles &&
        props.agent.id !== "unavailable-author" ? (
          <p className="turn-notice">
            A file was saved in this agent's workspace.{" "}
            <button
              type="button"
              onClick={() => props.onOpenWorkspaceFiles!(props.agent.id)}
            >
              Open workspace files
            </button>
          </p>
        ) : null}
        {!running ? (
          <footer className="message-actions">
            <ConversationFeedMessageTime value={endedAt ?? startedAt} />
            {!turn.responseMessageId &&
            turn.parts.some((part) => part.kind === "text") ? (
              <CopyButton
                text={turn.parts
                  .filter((part) => part.kind === "text")
                  .map((part) => part.content)
                  .join("\n\n")}
                label="Copy response"
                iconOnly
              />
            ) : null}
          </footer>
        ) : null}
        {!running && turn.responseMessageId ? (
          <AssistantMessageActions messageId={turn.responseMessageId} />
        ) : null}
        {live ? (
          <>
            {props.approval ? (
              <div className="conversation-attention">{props.approval}</div>
            ) : null}
            {props.interruption}
          </>
        ) : null}
      </article>
    </section>
  );
});
