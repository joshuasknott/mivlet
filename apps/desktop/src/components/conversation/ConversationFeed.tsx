import { useLayoutEffect, useMemo, useRef } from "react";
import type { MivletAgentProfile, ProjectFact } from "@mivlet/protocol";
import { conversationTurns } from "../../lib/conversation-history";
import type { ConversationTurn } from "../../lib/conversation-presentation-types";
import { isPresenceScopeCurrent } from "../../lib/agent-presence";
import {
  branchHeads,
  branchHasMissingAncestor,
  visibleConversationBranch,
} from "../../lib/conversation-branches";
import type { ConversationFeedProps as Props } from "./conversation-feed-types";
import { ConversationFeedMessageTime } from "./ConversationFeedParts";
import {
  ConversationTurnView,
  ConversationUserMessage,
} from "./ConversationTurn";
import "./conversation.css";

// Event identity can stay stable while the committed handler and authority change.
function useTurnCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | undefined,
  scope: string,
) {
  const latest = useMemo(() => ({ callback }), [scope]);
  useLayoutEffect(() => {
    latest.callback = callback;
    return () => {
      latest.callback = undefined;
    };
  }, [callback, latest]);
  const available = Boolean(callback);
  return useMemo(
    () =>
      available
        ? (...args: Args): Result => {
            const current = latest.callback;
            if (!current)
              throw new Error(
                "This conversation action is no longer available.",
              );
            return current(...args);
          }
        : undefined,
    [available, latest],
  );
}

function useMcpResourceRelease(
  callback: Props["onMcpAppResourceRelease"],
  scope: string,
) {
  const owner = useMemo(() => ({ callback }), [scope]);
  useLayoutEffect(() => {
    if (callback) owner.callback = callback;
  }, [callback, owner]);
  // Teardown must survive parent unmount and late native registration. Each
  // scope keeps its own release-only callback; it can never acquire a new scope.
  return useMemo<NonNullable<Props["onMcpAppResourceRelease"]>>(
    () => (resourceOwner) =>
      owner.callback?.(resourceOwner) ?? Promise.resolve(),
    [owner],
  );
}

function sameAuthor(
  left: MivletAgentProfile | undefined,
  right: MivletAgentProfile,
) {
  if (!left) return false;
  const keys = Object.keys(right) as (keyof MivletAgentProfile)[];
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
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
  const callbackScope = JSON.stringify([
    props.workspaceId,
    threadId,
    props.generation,
    props.appGeneration,
  ]);
  const isMcpRunCurrent = useTurnCallback(props.isMcpRunCurrent, callbackScope);
  const onOpenConnector = useTurnCallback(props.onOpenConnector, callbackScope);
  const onPreviewArtifact = useTurnCallback(
    props.onPreviewArtifact,
    callbackScope,
  );
  const onDraftResponse = useTurnCallback(props.onDraftResponse, callbackScope);
  const onDraftPreview = useTurnCallback(props.onDraftPreview, callbackScope);
  const onSaveMemory = useTurnCallback(props.onSaveMemory, callbackScope);
  const onPinResponse = useTurnCallback(props.onPinResponse, callbackScope);
  const onMcpAppApproval = useTurnCallback(
    props.onMcpAppApproval,
    callbackScope,
  );
  const onMcpAppResourceRegister = useTurnCallback(
    props.onMcpAppResourceRegister,
    callbackScope,
  );
  const onMcpAppResourceRelease = useMcpResourceRelease(
    props.onMcpAppResourceRelease,
    callbackScope,
  );
  const onOpenWorkspaceFiles = useTurnCallback(
    props.onOpenWorkspaceFiles,
    callbackScope,
  );
  const previousAuthors = useRef<Record<string, MivletAgentProfile>>({});
  const authors = useMemo(() => {
    const next: Record<string, MivletAgentProfile> = {};
    for (const [id, author] of Object.entries(props.authors ?? {})) {
      const previous = previousAuthors.current[id];
      next[id] = sameAuthor(previous, author) ? previous : author;
    }
    previousAuthors.current = next;
    return next;
  }, [props.authors]);
  const redactedRuns = useMemo(
    () =>
      new Set<string | undefined>(
        visibleMessages
          .filter((view) => view.currentRevision.state === "redacted")
          .map((view) => view.message.runId),
      ),
    [visibleMessages],
  );
  const unavailableAuthor = useMemo(
    () => ({
      ...props.agent,
      id: "unavailable-author",
      name: "Agent",
      avatarSeed: "blob-v1:unavailable-author",
      iconImageDataUrl: undefined,
    }),
    [props.agent],
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
    const redacted = redactedRuns.has(state.currentAttemptId);
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
  const branchUnavailable = useMemo(
    () => branchHasMissingAncestor(props.messages, props.selectedHeadId),
    [props.messages, props.selectedHeadId],
  );
  const availableBranchHeads = useMemo(
    () => [
      ...new Set([
        ...branchHeads(props.messages),
        ...(props.branchHeadIds ?? []),
      ]),
    ],
    [props.messages, props.branchHeadIds],
  );
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
            {props.loadingOlderMessages
              ? "Loading earlier messages…"
              : "Load earlier messages"}
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
                  {fact.messageId || fact.branchId
                    ? " · Exact source saved"
                    : ""}
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
        const author = authors[turn.id];
        const liveEntry = liveStates.find(
          (entry) =>
            entry.state.currentAttemptId === turn.id &&
            entry.state.progressThreadId === threadId,
        );
        return (
          <ConversationTurnView
            key={turn.id}
            turn={turn}
            state={liveEntry?.state}
            receipt={
              (liveEntry?.state ?? props.state).progressReceipts?.[turn.id]
            }
            awaitingApproval={
              Boolean(liveEntry && props.approval) ||
              Boolean(props.awaitingApprovalRunIds?.includes(turn.id))
            }
            profileName={props.profileName}
            connectors={props.connectors}
            workspaceId={props.workspaceId}
            threadId={threadId}
            showAuthor={props.showAuthor}
            requireAuthor={props.requireAuthor}
            presence={liveEntry ? props.presence : undefined}
            approval={liveEntry ? props.approval : undefined}
            interruption={liveEntry ? props.interruption : undefined}
            appGeneration={props.appGeneration}
            isMcpRunCurrent={isMcpRunCurrent}
            onOpenConnector={onOpenConnector}
            onDraftResponse={onDraftResponse}
            onDraftPreview={onDraftPreview}
            onSaveMemory={onSaveMemory}
            onPinResponse={onPinResponse}
            onMcpAppApproval={onMcpAppApproval}
            onMcpAppResourceRegister={onMcpAppResourceRegister}
            onMcpAppResourceRelease={onMcpAppResourceRelease}
            onOpenWorkspaceFiles={onOpenWorkspaceFiles}
            agent={
              author ??
              (props.requireAuthor
                ? unavailableAuthor
                : (liveEntry?.agent ?? props.agent))
            }
            onPreviewArtifact={
              props.requireAuthor && !author ? undefined : onPreviewArtifact
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
        <ConversationUserMessage
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
