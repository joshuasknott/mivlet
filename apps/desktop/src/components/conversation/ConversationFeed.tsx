import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AssistantMessageActions } from "./AssistantMessageActions";
import { displayWorkspaceMentions } from "../../lib/collaboration-mentions";
import type {
  ConnectorManifest,
  MivletAgentProfile,
  ProjectFact,
  Spine,
} from "@mivlet/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import type { ConversationMessageView } from "../../lib/conversation-runtime";
import {
  conversationTurns,
  toolActivity,
  type ConversationTurn,
} from "../../lib/conversation-presentation";
import type { McpAppApprovalPreview } from "../../lib/mcp-app-host";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import {
  agentPresence,
  isPresenceScopeCurrent,
  type AgentPresence,
} from "../../lib/agent-presence";
import { ConnectorMentionText } from "../ConnectorMention";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { MessageMarkdown } from "./MessageMarkdown";
import { CopyButton } from "../CopyButton";
import { MessageAttachments } from "./MessageAttachments";
import {
  branchHeads,
  branchHasMissingAncestor,
  visibleConversationBranch,
} from "../../lib/conversation-branches";
import { ResponseSelection } from "./ResponseSelection";
import { GeneratedResponse } from "./generated/GeneratedResponse";
import {
  ConversationFeedMessageTime,
  ConversationFeedPart,
} from "./ConversationFeedParts";
import "./conversation.css";

interface Props {
  messages: ConversationMessageView[];
  agent: MivletAgentProfile;
  authors?: Record<string, MivletAgentProfile>;
  requireAuthor?: boolean;
  showAuthor?: boolean;
  suppressLivePrompt?: boolean;
  state: NativeAgentState;
  liveStates?: {
    state: NativeAgentState;
    agent: MivletAgentProfile;
    suppressPrompt: boolean;
  }[];
  presence?: AgentPresence;
  threadId?: string;
  profileName: string;
  connectors: ConnectorManifest[];
  optimisticPrompt: string;
  pendingTurns?: ConversationTurn[];
  decisionEvents?: ProjectFact[];
  optimisticAttachments?: readonly Spine.Conversations.ConversationAttachmentMetadata[];
  workspaceId: string;
  generation?: number;
  selectedHeadId?: string;
  onSelectBranch?: (headId: string) => void;
  branchSelectionPending?: boolean;
  hasOlderMessages?: boolean;
  branchHeadIds?: readonly string[];
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  approval?: ReactNode;
  awaitingApprovalRunIds?: readonly string[];
  interruption?: ReactNode;
  onPreviewArtifact?: (
    output: string,
    authorId?: string,
    messageId?: string,
  ) => void;
  onOpenConnector?: (connectorId: string) => void;
  /** Places an interactive response revision or selected passage in the composer. */
  onDraftResponse?: (text: string) => void;
  /** Saves a deliberately selected response passage through the native memory boundary. */
  onSaveMemory?: (title: string, value: string) => Promise<void>;
  /** Opens a confirmed decision at its durable conversation source. */
  onOpenDecision?: (fact: ProjectFact) => void;
  onPinResponse?: (
    text: string,
    source: { messageId?: string; sourceRevisionId?: string },
    runId: string,
    agentId: string,
  ) => Promise<void>;
  /** Routes MCP App resource/tool requests into the existing approval UI. */
  appGeneration?: number;
  isMcpRunCurrent?: (runId: string) => boolean;
  onMcpAppApproval?: (
    preview: McpAppApprovalPreview,
  ) => Promise<import("@mivlet/protocol").ApprovalResolutionRequest | null>;
  onMcpAppResourceRegister?: (
    resource: import("../../lib/mcp-app-host").McpAppResource | undefined,
    owner: { resultId: string; sessionId: string },
  ) => Promise<string | null>;
  onMcpAppResourceRelease?: (owner: {
    resultId: string;
    sessionId: string;
  }) => Promise<void>;
  onOpenWorkspaceFiles?: (agentId: string) => void;
}

export function ConversationFeed(props: Props) {
  const { state, threadId } = props;
  const live = Boolean(
    state.currentAttemptId &&
    state.progressThreadId === threadId &&
    isPresenceScopeCurrent(state, { agentId: props.agent.id, threadId }),
  );
  const liveStates = props.liveStates ?? [
    {
      state,
      agent: props.agent,
      suppressPrompt: Boolean(props.suppressLivePrompt),
    },
  ];
  const visibleMessages = useMemo(
    () =>
      props.selectedHeadId
        ? visibleConversationBranch(props.messages, props.selectedHeadId)
        : props.messages,
    [props.messages, props.selectedHeadId],
  );
  const turns = useMemo(
    () => conversationTurns(visibleMessages),
    [visibleMessages],
  );
  const presented = [...turns];
  for (const liveEntry of liveStates) {
    const state = liveEntry.state;
    if (
      !state.currentAttemptId ||
      state.progressThreadId !== threadId ||
      !isPresenceScopeCurrent(state, { agentId: liveEntry.agent.id, threadId })
    )
      continue;
    const index = presented.findIndex(
      (turn) => turn.id === state.currentAttemptId,
    );
    const canonical = presented[index];
    const redacted = visibleMessages.some(
      (entry) =>
        entry.message.runId === state.currentAttemptId &&
        entry.currentRevision.state === "redacted",
    );
    const canonicalReady =
      canonical &&
      !state.running &&
      (redacted ||
        canonical.parts
          .filter((part) => part.kind === "text")
          .map((part) => part.content)
          .join("") === state.transcript);
    const turn: ConversationTurn = {
      id: state.currentAttemptId!,
      prompt: liveEntry.suppressPrompt
        ? undefined
        : (state.progressPrompt ?? props.optimisticPrompt),
      attachments: canonical?.attachments ?? props.optimisticAttachments,
      parts: canonicalReady
        ? canonical.parts
        : (state.responseParts ??
          (state.transcript
            ? [{ id: "text", kind: "text", content: state.transcript }]
            : [])),
      startedAt: state.startedAt,
      endedAt: state.endedAt,
    };
    if (index < 0) presented.push(turn);
    else
      presented[index] = { ...turn, prompt: canonical.prompt ?? turn.prompt };
  }
  for (const turn of props.pendingTurns ?? []) {
    if (presented.some((entry) => entry.id === turn.id)) continue;
    const index = presented.findIndex(
      (entry) =>
        entry.startedAt && turn.startedAt && entry.startedAt > turn.startedAt,
    );
    if (index < 0) presented.push(turn);
    else presented.splice(index, 0, turn);
  }
  const entries: ({ turn: ConversationTurn } | { fact: ProjectFact })[] =
    presented.map((turn) => ({ turn }));
  const branchUnavailable = branchHasMissingAncestor(
    props.messages,
    props.selectedHeadId,
  );
  const availableBranchHeads = [
    ...new Set([
      ...branchHeads(props.messages),
      ...(props.branchHeadIds ?? []),
    ]),
  ];
  for (const fact of props.decisionEvents ?? []) {
    const index = entries.findIndex(
      (entry) =>
        "turn" in entry &&
        entry.turn.startedAt &&
        entry.turn.startedAt > fact.createdAt,
    );
    if (index < 0) entries.push({ fact });
    else entries.splice(index, 0, { fact });
  }
  return (
    <>
      {props.hasOlderMessages && props.onLoadOlderMessages ? (
        <div className="conversation-history-older">
          <button
            type="button"
            onClick={props.onLoadOlderMessages}
            disabled={props.loadingOlderMessages}
          >
            {props.loadingOlderMessages ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
        </div>
      ) : null}
      {branchUnavailable ? (
        <p className="conversation-branch-status" role="status">
          The selected branch is not fully loaded yet. Load earlier messages
          before continuing.
        </p>
      ) : null}
      {entries.map((entry) => {
        if ("fact" in entry) {
          const fact = entry.fact;
          return (
            <aside
              key={`fact-${fact.id}`}
              className="conversation-context-event"
              aria-label={`Confirmed project ${fact.kind}`}
            >
              <details>
                <summary>
                  {fact.kind === "decision"
                    ? "Decision confirmed"
                    : "Fact confirmed"}
                  {fact.status !== "current" ? ` · ${fact.status}` : ""}{" "}
                  <ConversationFeedMessageTime value={fact.createdAt} />
                </summary>
                <p>{fact.text}</p>
                <small>
                  {fact.source}
                  {fact.pinned ? " · Pinned" : ""}
                  {fact.messageId || fact.branchId ? " · Exact source saved" : ""}
                </small>
                {props.onOpenDecision &&
                (fact.messageId || fact.branchId || fact.sourceRevisionId) ? (
                  <button
                    type="button"
                    className="conversation-context-event__source"
                    onClick={() => props.onOpenDecision?.(fact)}
                  >
                    View source
                  </button>
                ) : null}
              </details>
            </aside>
          );
        }
        const { turn } = entry;
        const author = props.authors?.[turn.id];
        const liveEntry = liveStates.find(
          (entry) =>
            entry.state.currentAttemptId === turn.id &&
            entry.state.progressThreadId === threadId,
        );
        return (
          <Turn
            key={turn.id}
            turn={turn}
            {...props}
            state={liveEntry?.state ?? props.state}
            agent={
              author ??
              (props.requireAuthor
                ? {
                    ...props.agent,
                    id: "unavailable-author",
                    name: "Agent",
                    avatarSeed: "blob-v1:unavailable-author",
                    iconImageDataUrl: undefined,
                  }
                : (liveEntry?.agent ?? props.agent))
            }
            onPreviewArtifact={
              props.requireAuthor && !author
                ? undefined
                : props.onPreviewArtifact
            }
            generation={
              props.requireAuthor && !author ? undefined : props.generation
            }
            live={Boolean(liveEntry)}
          />
        );
      })}
      {props.optimisticPrompt &&
      (!live || props.optimisticPrompt !== state.progressPrompt) ? (
        <UserMessage
          content={props.optimisticPrompt}
          attachments={props.optimisticAttachments}
          {...props}
        />
      ) : null}
      {!live && (props.approval || props.interruption) ? (
        <div className="conversation-attention">
          {props.approval}
          {props.interruption}
        </div>
      ) : null}
      {availableBranchHeads.length > 1 && props.onSelectBranch ? (
        <nav
          className="conversation-branch-picker"
          aria-label="Conversation alternatives"
        >
          <span>Alternative responses</span>
          {availableBranchHeads.map((headId, index) => (
            <button
              type="button"
              key={headId}
              disabled={props.branchSelectionPending}
              aria-pressed={headId === props.selectedHeadId}
              onClick={() => props.onSelectBranch!(headId)}
            >
              Option {index + 1}
            </button>
          ))}
        </nav>
      ) : null}
    </>
  );
}

function UserMessage({
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

function Turn({
  turn,
  live,
  ...props
}: Props & { turn: ConversationTurn; live: boolean }) {
  const running = live && props.state.running;
  const [disclosure, setDisclosure] = useState({ running, open: false });
  const expanded = disclosure.running === running && disclosure.open;
  const [clock, setClock] = useState(Date.now());
  const [savedSummary, setSavedSummary] = useState("");
  const receipt = props.state.progressReceipts?.[turn.id];
  const summary = live
    ? Object.values(props.state.reasoningSummaries ?? {}).join("\n\n")
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
      (!live || (!props.state.lastError && props.state.status !== "cancelled")),
  );
  const failed = work.filter(
    (part) => part.kind === "tool" && part.state === "failed" && !part.terminalStatus,
  ).length;
  const outputs = turn.parts.filter(
    (part) =>
      part.kind === "tool" &&
      part.state === "succeeded" &&
      parseComputerArtifact(part.content),
  );
  const files = outputs.filter(
    (part, index) =>
      outputs.findIndex(
        (other) =>
          parseComputerArtifact(other.content)?.id ===
          parseComputerArtifact(part.content)?.id,
      ) === index,
  );
  const savedFile = turn.parts.some(
    (part) =>
      part.kind === "tool" &&
      part.state === "succeeded" &&
      ["write-file", "create-document", "create-spreadsheet"].includes(
        part.tool,
      ),
  );
  const stopped = live && props.state.status === "cancelled";
  const cancelled =
    turn.parts.some(
      (part) => (part.kind === "tool" && part.terminalStatus === "cancelled") ||
        (part.kind === "notice" && part.status === "cancelled"),
    ) || stopped;
  const danglingTool =
    !live && !cancelled &&
    turn.parts.some((part) => part.kind === "tool" && part.state === "running");
  const interrupted =
    turn.parts.some(
      (part) =>
        (part.kind === "notice" && part.status === "interrupted") ||
        (part.kind === "tool" && part.terminalStatus === "interrupted"),
    ) ||
    (live && props.state.status === "interrupted") ||
    danglingTool;
  const recoveredToolFailure =
    Boolean(final?.kind === "text" && final.content.trim()) ||
    work.some((part) => part.kind === "tool" && part.state === "succeeded");
  const failedTerminal =
    (live && props.state.status === "failed") ||
    turn.parts.some((part) => part.kind === "notice" && part.error) ||
    (work.some(
      (part) =>
        part.kind === "tool" &&
        part.state === "failed" &&
        !part.terminalStatus,
    ) && !recoveredToolFailure);
  const awaitingApproval = Boolean(props.approval) || props.awaitingApprovalRunIds?.includes(turn.id);
  const label = running
    ? awaitingApproval
      ? "Waiting for your approval"
      : "Working"
    : interrupted
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
    props.state.activity ||
    (currentTool?.kind === "tool"
      ? toolActivity(currentTool.tool, "running")
      : "");
  if (!turn.parts.length && !running && !live)
    return turn.prompt ? (
      <UserMessage
        content={turn.prompt}
        attachments={turn.attachments}
        timestamp={turn.startedAt}
        {...props}
      />
    ) : null;
  return (
    <section className="conversation-turn">
      {turn.prompt ? (
        <UserMessage
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
                    agentPresence(props.state, Boolean(props.approval)))
                  : "idle"
              }
              activityKey={`${props.agent.id}:${turn.id}`}
            />
            <strong>{props.agent.name}</strong>
          </header>
        ) : null}
        {hasActivity ? (
          <details className="turn-activity" open={expanded}>
            <summary
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
            {expanded ? (
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
                    conversationId={props.threadId ?? turn.id}
                    generation={props.appGeneration}
                    isCurrent={() => props.isMcpRunCurrent?.(turn.id) !== false}
                    onDraft={props.onDraftResponse}
                    onMcpAppApproval={props.onMcpAppApproval}
                    onMcpAppResourceRegister={props.onMcpAppResourceRegister}
                    onMcpAppResourceRelease={props.onMcpAppResourceRelease}
                  />
                ))}
              </div>
            ) : null}
          </details>
        ) : null}
        {running && activity && !awaitingApproval && !expanded ? (
          <p className="turn-current" role="status">
            {activity}
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
              onDraft={
                props.onDraftResponse ?? (() => undefined)
              }
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
                onDraft={
                  props.onDraftResponse ?? (() => undefined)
                }
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
}
