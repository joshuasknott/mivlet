import { ArrowDown } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRoom,
  MivletAgentProfile,
  LocalProject,
  WorkspaceView,
} from "@mivlet/protocol";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import { useScopedComposer } from "../hooks/useScopedComposer";
import { useComposerVoice } from "../hooks/useComposerVoice";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { useLocalComputer } from "../hooks/useLocalComputer";
import {
  activeWork,
  type WorkspaceExecution,
  type WorkspaceExecutionState,
} from "../lib/workspace-execution";
import { insertDictation } from "../lib/insert-dictation";
import { prepareComposerImage } from "../lib/composer-images";
import { prepareReadableComposerAttachment, composerSubmissionText } from "../lib/composer-attachments";
import { builtinPluginMentions } from "../lib/builtin-plugins";
import { composerModelsFor } from "./composer-models";
import { Composer } from "../components/Composer";
import { RecipientPicker } from "../components/conversation/RecipientPicker";
import type { ComposerInputHandle } from "../components/ComposerInput";
import type { ComposerAttachment } from "../lib/types";
import { ConversationFeed } from "../components/conversation/ConversationFeed";
import { ConversationIdentity } from "./ConversationIdentity";
import { agentPresence } from "../lib/agent-presence";
import { resolveWorkspaceMentions } from "../lib/collaboration-mentions";
import { ContextRecoveryPanel } from "../components/conversation/ContextRecoveryPanel";
import { buildConversationHandoff } from "../lib/conversation-handoff";
import { mentionedBuiltinPlugins } from "../lib/builtin-plugins";
import type { ConversationTurn } from "../lib/conversation-presentation";
import { SideChatContextNotice } from "../components/conversation/SideChats";

const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((module) => ({
    default: module.ApprovalPanel,
  })),
);
const ArtifactPreview = lazy(() =>
  import("../components/conversation/ArtifactPreview").then((module) => ({
    default: module.ArtifactPreview,
  })),
);

const idleAgentState: NativeAgentState = {
  transcript: "",
  usage: null,
  running: false,
  lastError: null,
  status: "idle",
  recoverableAttempts: [],
  contextReceipts: {},
  providerRoutes: {},
  usageReceipts: {},
  currentAttemptId: null,
  noTransport: false,
};

export function ConversationPane({
  view,
  room,
  project,
  runtime,
  service,
  state,
  active,
  profileName,
  onClose,
  onArtifact,
  onEdit,
  onAgentSettings,
  onNew,
  onComputer,
  onPlugins,
  onProviders,
  onProjectUpdate,
  onDraftReady,
}: {
  view: WorkspaceView;
  room: ConversationRoom;
  project?: LocalProject;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  active: boolean;
  profileName: string;
  onClose: () => void;
  onArtifact: (output: string, agentId: string) => void;
  onEdit: () => void;
  onAgentSettings: (agentId: string) => void;
  onNew: (draft?: string) => Promise<string | void>;
  onComputer: (agentId: string) => void;
  onPlugins: (id?: string) => void;
  onProviders: () => void;
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  onDraftReady: (append: (text: string) => void) => void;
}) {
  const owner = runtime.accountWorkspaceStatus.activeContextOwner;
  const composer = useScopedComposer({
    workspaceId: service.workspaceId,
    accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
    agentId: room.facilitatorId ?? "unavailable",
    projectId: room.projectId,
    threadId: room.id,
  });
  const recipient = composer.recipientId ?? room.facilitatorId ?? "";
  const recipientId =
    recipient === "discussion" ? (room.facilitatorId ?? "") : recipient;
  const profile = runtime.agents.find((agent) => agent.id === recipientId);
  const displayAgent: MivletAgentProfile = profile ?? {
    ...(runtime.agents[0] ?? {
      instructions: "",
      modelId: "",
      permissionLabel: "Ask Me",
      icon: "sparkle",
    }),
    id: recipientId || "unavailable",
    name:
      room.participants.find((member) => member.agentId === recipientId)
        ?.name ?? "Unavailable teammate",
  };
  const localComputer = useLocalComputer({
    workspaceId: service.workspaceId,
    agentId: view.kind === "artifact" ? view.agentId : displayAgent.id,
    executionOwner: false,
  });
  const composerRef = useRef<ComposerInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const submission = useRef(false);
  const currentComposer = useRef(composer);
  currentComposer.current = composer;
  const focus = () => requestAnimationFrame(() => composerRef.current?.focus());
  const voice = useComposerVoice(
    runtime,
    `${service.workspaceId}:${view.id}`,
    (text) => {
      const handle = composerRef.current;
      const draft = currentComposer.current;
      const insertion = insertDictation(
        draft.text,
        text,
        handle?.selectionStart,
        handle?.selectionEnd,
      );
      draft.setText(insertion.value);
      requestAnimationFrame(() => {
        handle?.focus();
        handle?.setSelectionRange(insertion.caret, insertion.caret);
      });
    },
    () => {
      if (active) focus();
    },
  );
  useEffect(() => {
    if (!active && voice.isBusy) voice.cancel();
  }, [active]);
  useEffect(() => {
    if (active && composer.ready)
      onDraftReady((text) => {
        const draft = currentComposer.current;
        draft.setText(
          `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${text}`,
        );
        focus();
      });
  }, [active, composer.ready, room.id]);
  useEffect(() => {
    void service.loadHistory(room.id).catch((error) => service.report(error));
  }, [room.id, service]);
  const history = state.histories[room.id];
  const sideChat = room.chat?.role === "side";
  const sessions = state.sessions.filter(
    (session) => session.work.conversationId === room.id && !session.cancelled,
  );
  const work = state.data.work.filter(
    (work) => work.conversationId === room.id,
  );
  const running = work.filter(activeWork);
  const pendingTurns: ConversationTurn[] = work.filter(item => !item.parentId && !item.runIds.length).map(item => ({
    id: item.id, prompt: item.userRequest || item.prompt, startedAt: item.createdAt, endedAt: item.updatedAt,
    parts: item.status === "failed" ? [{ id: `${item.id}-error`, kind: "notice", error: true, content: item.reason || "This request could not start." }] : [],
  }));
  pendingTurns.push(...work.flatMap(item => (item.steering ?? []).map(event => ({
    id: event.id, prompt: event.text, startedAt: event.createdAt, endedAt: event.createdAt, parts: [],
  }))));
  const liveStates = sessions
    .filter((session) => session.state)
    .map((session) => ({
      state: session.state!,
      agent: session.profile,
      suppressPrompt: Boolean(
        session.work.parentId || session.work.runIds.length > 0,
      ),
    }));
  const baseState = liveStates[0]?.state ?? idleAgentState;

  const scroll = useConversationScroll(
    `${service.workspaceId}:${view.id}`,
    `${state.revision}:${history?.messages.length}`,
    true,
  );
  const models = useMemo(
    () => composerModelsFor(undefined, runtime.modelOptions),
    [runtime.modelOptions],
  );
  const model = models.find((model) => model.id === profile?.modelId);
  const approvals = active
    ? runtime.openApprovals.filter((approval) =>
        sessions.some((session) => session.approvalIds.has(approval.id)),
      )
    : [];
  const authors: Record<string, MivletAgentProfile> = Object.fromEntries(
    state.data.authors
      .filter((author) => author.conversationId === room.id)
      .map((author) => [
        author.runId,
        {
          ...(runtime.agents.find((agent) => agent.id === author.agentId) ??
            displayAgent),
          id: author.agentId,
          name: author.name,
          avatarSeed:
            runtime.agents.find((agent) => agent.id === author.agentId)
              ?.avatarSeed ?? `blob-v1:${author.agentId}`,
        },
      ]),
  );
  for (const item of work) {
    authors[item.id] = { ...(runtime.agents.find(agent => agent.id === item.agentId) ?? displayAgent), id: item.agentId, name: item.agentName };
  }
  const connected = [
    // Capability mentions are inserted only from the current native snapshot.
    ...builtinPluginMentions(localComputer.node?.plugins),
    ...runtime.connectorManifests
      .filter(
        (connector) =>
          connector.status === "connected" && connector.id !== "local-files",
      )
      .map((connector) => ({
        id: connector.id,
        name: connector.name,
        status: connector.status,
      })),
  ];
  const workspaceMentions = resolveWorkspaceMentions(composer.text, runtime.agents, connected.flatMap(item => [item.id, item.name]));
  const mentions = workspaceMentions.shouldExecute ? workspaceMentions : null;
  const effortIds = new Set(state.data.work.filter(item => item.conversationId === room.id && !item.parentId).map(item => item.rootId));
  const effortWork = state.data.work.filter(item => effortIds.has(item.rootId));
  const replyTarget = composer.replyWorkId ? effortWork.find(item => item.id === composer.replyWorkId) : undefined;
  const responder = runtime.agents.find((agent) => agent.id === (mentions?.recipientIds[0] ?? replyTarget?.agentId ?? recipientId));
  const send = async () => {
    const prompt = composerSubmissionText(composer.text, composer.attachments);
    if (!composer.ready || !prompt || submission.current || voice.isBusy)
      return;
    if (workspaceMentions.errors.length) {
      setError(workspaceMentions.errors.join(" ") + " Choose an agent from the @ picker.");
      return;
    }
    if (workspaceMentions.recipientIds.length && !workspaceMentions.assignment) {
      setError("Add an assignment after the agent mention before sending.");
      return;
    }
    if (composer.replyWorkId && !replyTarget) {
      setError("The assignment for this follow-up is unavailable. Choose a current assignment or send a new request.");
      return;
    }
    if (replyTarget && (composer.attachments.length || (mentions && (mentions.recipientIds.length !== 1 || mentions.recipientIds[0] !== replyTarget.agentId)))) {
      setError("This follow-up belongs to the selected assignment. Choose New request to change recipients or attach new files.");
      return;
    }
    if (
      recipient === "discussion" &&
      !room.facilitatorId
    ) {
      setError("Choose a coordinator before requesting a team discussion.");
      return;
    }
    if (
      !responder
    ) {
      setError(
        mentions
          ? "That mentioned participant is unavailable. Pick a current participant."
          : "Choose an available participant before sending.",
      );
      return;
    }
    if (
      composer.attachments.some(
        (attachment) =>
          !attachment.imageInput &&
          !attachment.sourceId &&
          !attachment.transientBytes,
      )
    ) {
      setError("Reattach the unavailable file or remove it before sending.");
      return;
    }
    if (!composer.beginSubmission()) return;
    submission.current = true;
    setPending(true);
    setError("");
    try {
      await runtime.flushSnapshot();
      await service.refresh();
      if (mentionedBuiltinPlugins(prompt).length) await localComputer.prepareForTool("read-file");
      if (project) {
        const sourceIds = composer.attachments.flatMap((attachment) =>
          attachment.sourceId ? [attachment.sourceId] : [],
        );
        if (sourceIds.some((id) => !project.knowledgeSourceIds.includes(id)))
          await onProjectUpdate(project, {
            name: project.name,
            instructions: project.instructions,
            knowledgeSourceIds: [
              ...new Set([...project.knowledgeSourceIds, ...sourceIds]),
            ],
          });
      }
      if (replyTarget) {
        await service.reply(replyTarget.id, replyTarget.generation, prompt);
      } else {
        await service.submit(room.id, responder.id, prompt, recipient === "discussion", composer.attachments, mentions?.recipientIds);
      }
      await composer.consume(composer.revision);
      scroll.toLatest();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not send this message.",
      );
    } finally {
      submission.current = false;
      composer.endSubmission();
      setPending(false);
    }
  };
  const importFiles = (files: File[]) => {
    const target = composer;
    for (const file of files.slice(
      0,
      Math.max(0, 12 - composer.attachments.length),
    )) {
      const id = `attachment-${crypto.randomUUID()}`;
      const item: ComposerAttachment = {
        id,
        name: file.name,
        type: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "Preparing…",
      };
      target.setAttachments((current) => [...current, item]);
      const preparation = file.type.startsWith("image/")
        ? prepareComposerImage(file, id).then((imageInput) => ({
            imageInput,
            previewUrl: imageInput.dataUrl,
            status: "Image input · transient",
          }))
        : prepareReadableComposerAttachment(file, runtime.importKnowledgeFile);
      void preparation
        .then((result) =>
          target.setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id ? { ...attachment, ...result } : attachment,
            ),
          ),
        )
        .catch((error) =>
          target.setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? {
                    ...attachment,
                    status:
                      error instanceof Error
                        ? error.message
                        : "Could not read file",
                  }
                : attachment,
            ),
          ),
        );
    }
  };
  const contextFailure = sessions.find(
    (session) => session.state?.contextFailure,
  )?.state?.contextFailure;
  const empty = history !== undefined && !history?.messages.length && !liveStates.length && !work.length && !approvals.length && !sideChat;
  const approvalPanel = approvals.length ? (
            <Suspense fallback={null}>
              <div
                className="conversation-approvals"
                aria-label={`Approvals for ${room.title}`}
              >
                <ApprovalPanel
                  compact
                  previews={runtime.approvalPreviews}
                  approvals={approvals}
                  audit={runtime.approvalAudit}
                  sessionGrants={runtime.sessionApprovalGrants}
                  approvalRules={runtime.approvalRules}
                  editingApprovalId={
                    approvals.some(
                      (approval) => approval.id === runtime.editingApprovalId,
                    )
                      ? runtime.editingApprovalId
                      : null
                  }
                  modificationDraft={runtime.approvalModificationDraft}
                  pendingConfirmation={
                    runtime.pendingApprovalConfirmation &&
                    approvals.some(
                      (approval) =>
                        approval.id ===
                        runtime.pendingApprovalConfirmation?.request.id,
                    )
                      ? runtime.pendingApprovalConfirmation
                      : null
                  }
                  confirmationText={runtime.approvalConfirmationText}
                  onDecision={runtime.requestApprovalDecision}
                  onStartModify={runtime.startApprovalModify}
                  onUpdateModification={runtime.setApprovalModificationDraft}
                  onSaveModify={runtime.saveApprovalModify}
                  onCancelModify={runtime.clearApprovalInteraction}
                  onUpdateConfirmation={runtime.setApprovalConfirmationText}
                  onConfirmDecision={runtime.confirmApprovalDecision}
                  onCancelConfirmation={runtime.clearApprovalInteraction}
                />
              </div>
            </Suspense>
          ) : null;
  if (view.kind === "artifact")
    return (
      <Suspense fallback={<p role="status">Loading file…</p>}>
        <ArtifactPreview
          embedded
          output={view.output}
          workspaceId={service.workspaceId}
          agentId={view.agentId}
          generation={
            localComputer.node?.agentId === view.agentId
              ? localComputer.node.generation
              : undefined
          }
          onClose={onClose}
        />
      </Suspense>
    );
  return (
    <div className={`conversation-pane-content${empty ? " conversation-pane-content--empty" : ""}`}>
      <header className="team-conversation-header">
        <ConversationIdentity
          agent={displayAgent}
          presence={agentPresence(baseState, approvals.length > 0)}
          name={project ? project.name : room.kind === "direct" && !sideChat ? displayAgent.name : room.title}
          settingsLabel={project ? `Project settings for ${project.name}` : room.kind === "group" ? `Conversation settings for ${room.title}` : `Agent settings for ${displayAgent.name}`}
          disabled={!project && room.kind === "direct" && !profile}
          sideChat={sideChat}
          onOpen={() => project || room.kind === "group" ? onEdit() : onAgentSettings(displayAgent.id)}
        />
      </header>
      <div
        className="conversation-pane-scroll"
        ref={scroll.scrollRef}
        onScroll={scroll.onScroll}
        onWheel={scroll.pauseFollowing}
      >
        <div className="conversation-pane-messages" ref={scroll.contentRef}>
          {sideChat ? <SideChatContextNotice compact /> : null}
          {history === undefined ? (
            <p className="team-empty" role="status">
              Loading conversation…
            </p>
          ) : null}
          <ConversationFeed
            messages={history?.messages ?? []}
            agent={displayAgent}
            authors={authors}
            requireAuthor
            showAuthor={room.kind === "group" || work.some(item => item.agentId !== room.facilitatorId)}
            state={idleAgentState}
            liveStates={liveStates}
            threadId={room.id}
            profileName={profileName}
            connectors={runtime.connectorManifests}
            optimisticPrompt=""
            pendingTurns={pendingTurns}
            onOpenWorkspaceFiles={onComputer}
            decisionEvents={state.data.facts.filter(fact => fact.projectId === room.projectId && fact.conversationId === room.id && fact.confidence === "confirmed" && fact.status !== "forgotten")}
            workspaceId={service.workspaceId}
            generation={localComputer.node?.generation}
            onPreviewArtifact={(output, authorId) =>
              onArtifact(output, authorId ?? displayAgent.id)
            }
            onOpenConnector={onPlugins}
            onReusePrompt={(prompt, intent) => {
              composer.setText(prompt);
              setError(intent === "retry" ? "Review this request before sending again. Check any previous external actions and reattach files if needed." : "Editing a new message. The original and any actions already taken remain in the conversation; reattach files if needed.");
              focus();
            }}
          />
          {running
            .filter(
              (item) =>
                item.status === "queued" &&
                !sessions.some((session) => session.work.id === item.id),
            )
            .map((item) => (
              <p className="conversation-attention" key={item.id} role="status">
                Queued for {item.agentName}. It starts when this teammate and
                its provider have capacity.
              </p>
            ))}
          {approvalPanel}
          {contextFailure && history ? (
            <ContextRecoveryPanel
              failure={contextFailure}
              onPrepareHandoff={() => {
                const text = buildConversationHandoff({
                  thread: history.thread,
                  messages: history.messages,
                  failedPrompt: contextFailure.requestPrompt,
                });
                void onNew(text);
              }}
            />
          ) : null}
          {error || composer.error ? (
            <p className="conversation-attention" role="alert">
              {error || composer.error}
            </p>
          ) : null}
          {mentions ? (
            <p className="conversation-attention" role="status">
              Assigning to {mentions.recipientIds.map(id => runtime.agents.find(agent => agent.id === id)?.name ?? id).join(", ")}. Each agent uses its own model and permissions.
            </p>
          ) : null}
        </div>
      </div>
      <div className="conversation-pane-composer">
        {composer.replyWorkId ? <p className="conversation-attention" role="status">Following up with {replyTarget?.agentName ?? "an unavailable agent"} in this effort. <button type="button" onClick={() => composer.setReplyWork(undefined)}>New request</button></p> : null}
        {empty ? <div className="team-conversation-welcome"><h1>What would you like to work on?</h1></div> : null}
        {scroll.showLatest ? (
          <button
            type="button"
            className="conversation-jump"
            aria-label="Jump to latest"
            title="Jump to latest"
            onClick={scroll.toLatest}
          >
            <ArrowDown size={20} weight="regular" aria-hidden="true" />
          </button>
        ) : null}
        <Composer
          agentMentions={runtime.agents}
          onConnectProvider={onProviders}
          composerRef={composerRef}
          fileInputRef={fileInput}
          composerValue={composer.text}
          onComposerChange={composer.setText}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          voiceStatus={voice.state.status}
          voiceMessage={voice.state.message}
          voiceCanStart={voice.canStart}
          voiceDisclosure={voice.processingDisclosure}
          voiceReview={voice.review}
          onAuthorizeVoice={() => void voice.authorize()}
          onStartVoice={() => void voice.start()}
          onStopVoice={() => void voice.stop()}
          onCancelVoice={voice.cancel}
          onDismissVoice={voice.dismiss}
          onAttach={() => fileInput.current?.click()}
          addMenuOpen={addOpen}
          onToggleAddMenu={() => setAddOpen(!addOpen)}
          onOpenTool={() => onPlugins()}
          onRunCommand={composer.setText}
          onFileChange={(event) => {
            importFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
          models={models}
          selectedModelId={model?.id ?? profile?.modelId ?? ""}
          selectedModelLabel={model?.label ?? "Choose model"}
          modelScope={recipient === "discussion" ? `${displayAgent.name} leads this discussion using this model. Other participants use their own saved models if invited.` : `Model for ${displayAgent.name}. Changes apply to this agent's future requests.`}
          selectedReasoningEffort={profile?.reasoningEffort}
          onSelectReasoningEffort={(effort) => {
            if (profile)
              runtime.updateAgent(profile.id, { reasoningEffort: effort });
          }}
          onSelectModel={(modelId) => {
            if (profile) runtime.updateAgent(profile.id, { modelId, reasoningEffort: undefined });
          }}
          placeholder="Message…"
          inThread
          isWorking={running.length > 0}
          allowQueue
          onStop={() => {
            const item =
              [...running].reverse().find((item) => !item.parentId) ??
              running.at(-1);
            if (item)
              void service
                .stop(item.id)
                .catch((error) => service.report(error));
          }}
          connectedConnectors={connected}
          attachments={composer.attachments}
          onRemoveAttachment={(id) =>
            composer.setAttachments((current) =>
              current.filter((item) => item.id !== id),
            )
          }
          importStatus={pending ? "Saving message and context…" : undefined}
          recipientControl={
            room.kind === "group" ? (
              <RecipientPicker
                value={recipient}
                onChange={composer.setRecipient}
                options={[
                  ...room.participants.map((member) => ({
                    id: member.agentId,
                    name:
                      member.name +
                      (member.agentId === room.facilitatorId
                        ? " · Coordinator"
                        : ""),
                    disabled: !runtime.agents.some(
                      (agent) => agent.id === member.agentId,
                    ),
                  })),
                  ...(room.facilitatorId
                    ? [
                        {
                          id: "discussion",
                          name: "Team discussion",
                          description:
                            "The coordinator invites relevant contributions; each teammate uses its own model.",
                        },
                      ]
                    : []),
                ]}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
