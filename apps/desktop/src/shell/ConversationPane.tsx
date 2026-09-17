import { WorkDetails } from "../components/work/WorkDetails";
import { promoteWorkOutputToMemory } from "../lib/work-memory";
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
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import { agentPresence } from "../lib/agent-presence";
import { selectResponder } from "../lib/collaboration-mentions";
import { ContextRecoveryPanel } from "../components/conversation/ContextRecoveryPanel";
import { buildConversationHandoff } from "../lib/conversation-handoff";
import { mentionedBuiltinPlugins } from "../lib/builtin-plugins";
import {
  conversationTurns,
  type ConversationTurn,
} from "../lib/conversation-presentation";
import {
  promoteConversationConclusion,
  runtimeMemoryPorts,
} from "../lib/conversation-service";
import {
  ConversationMemoryPromotion,
  type MemoryScopeOption,
} from "../components/conversation/ConversationMemoryPromotion";
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
  onOpenWork,
  selectedWorkId,
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
  onOpenWork?: (id: string | null) => void;
  selectedWorkId?: string | null;
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
  const [memoryOpen, setMemoryOpen] = useState(false);

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
  const latestConclusion = useMemo(() => {
    const turns = conversationTurns(history?.messages ?? []);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const text = turns[index].parts
        .filter((part) => part.kind === "text")
        .map((part) => part.content.trim())
        .filter(Boolean)
        .join("\n\n");
      if (text) return text.slice(0, 2_000);
    }
    return "";
  }, [history?.messages]);
  const memoryScopes: MemoryScopeOption[] = [
    {
      id: "thread",
      label: "This conversation",
      description: sideChat
        ? "Only this Side Chat inherits it."
        : "Only this Agent's main Chat inherits it.",
    },
    ...(room.projectId
      ? [
          {
            id: "project" as const,
            label: "This project",
            description: "Project chats and Work in this project inherit it.",
          },
        ]
      : []),
    ...(!room.projectId && room.participants.length === 1
      ? [
          {
            id: "agent" as const,
            label: room.participants[0].name,
            description: "This Agent's conversations inherit it.",
          },
        ]
      : []),
  ];
  const memoryScopeId = (level: MemoryScopeOption["id"]) =>
    level === "project"
      ? (room.projectId ?? room.id)
      : level === "agent"
        ? (room.participants[0]?.agentId ?? displayAgent.id)
        : room.id;
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

  const activityDetailsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedWorkId) {
      activityDetailsRef.current?.scrollIntoView({ block: "nearest" });
      activityDetailsRef.current?.focus({ preventScroll: true });
    }
  }, [selectedWorkId, room.id]);
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
  const selection = selectResponder(composer.text, room.participants, {
    selectedRecipientId: recipientId,
    coordinatorId: room.facilitatorId,
  });
  const mentions = selection?.source === "mention" ? selection : null;
  const responder = selection
    ? runtime.agents.find((agent) => agent.id === selection.responderId)
    : undefined;
  const send = async () => {
    const prompt = composerSubmissionText(composer.text, composer.attachments);
    if (!composer.ready || !prompt || submission.current || voice.isBusy)
      return;
    if (
      recipient === "discussion" &&
      !room.facilitatorId
    ) {
      setError("Choose a coordinator before requesting a team discussion.");
      return;
    }
    if (
      !responder ||
      !room.participants.some((member) => member.agentId === responder.id)
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
      await service.submit(
        room.id,
        responder.id,
        prompt,
        recipient === "discussion",
        composer.attachments,
      );
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
        <div className="team-conversation-identity">
          <button type="button" className="team-agent-settings-trigger" disabled={!profile} aria-label={`Agent settings for ${displayAgent.name}`} onClick={() => onAgentSettings(displayAgent.id)}>
          <ProfileAgentAvatar
            agent={displayAgent}
            iconSize={29}
            presence={agentPresence(baseState, approvals.length > 0)}
          />
          </button>
          <div className="team-conversation-title">
            <button type="button" className="team-agent-settings-trigger" disabled={!project && room.kind === "direct" && !profile}
              title={room.kind === "direct" && !project ? `Agent settings for ${displayAgent.name}` : undefined}
              onClick={() => project || room.kind === "group" ? onEdit() : onAgentSettings(displayAgent.id)}>
              <strong>{room.kind === "direct" && !sideChat ? displayAgent.name : room.title}</strong>
            </button>
            {sideChat ? (
              <small className="side-chat-marker">
                Side Chat · separate conversation
              </small>
            ) : null}
          </div>
        </div>
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
            showAuthor={room.kind === "group"}
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
          {work.filter(item => item.id === selectedWorkId).map(item => <section key={item.id} ref={activityDetailsRef} tabIndex={-1} className="conversation-attention" aria-label="Activity details">
            <button type="button" onClick={() => onOpenWork?.(null)}>Close details</button>
            <WorkDetails item={item} onOpen={() => onOpenWork?.(null)}
              onStop={id => service.stop(id)}
              onContinue={async (id, generation) => { await service.command({ action: "continue-work", id, expectedGeneration: generation, reconcile: true }); }}
              onSteer={async (id, generation, text) => { await service.steer(id, generation, text); }}
              onPromote={async (output, workItem, value) => { await promoteWorkOutputToMemory(workItem, output, value, runtime.memoryState); }} />
          </section>)}
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
              Addressing{" "}
              {runtime.agents.find(
                (agent) => agent.id === mentions.responderId,
              )?.name ?? "the mentioned participant"}
              {mentions.mentionedIds.length > 1
                ? ` · also mentioned: ${mentions.mentionedIds
                    .slice(1)
                    .map(
                      (id) =>
                        runtime.agents.find((agent) => agent.id === id)?.name ??
                        id,
                    )
                    .join(", ")}`
                : ""}
              . Each reply stays attributed to its author.
            </p>
          ) : null}
        </div>
      </div>
      <div className="conversation-pane-composer">
        {empty ? <div className="team-conversation-welcome"><h1>What would you like to work on?</h1></div> : null}
        {scroll.showLatest ? (
          <button
            type="button"
            className="conversation-jump"
            onClick={scroll.toLatest}
          >
            Jump to latest
          </button>
        ) : null}
        <Composer
          onConnectProvider={onProviders}
          onSaveConclusion={latestConclusion ? () => setMemoryOpen(true) : undefined}
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

      {memoryOpen ? (
        <ConversationMemoryPromotion
          chatTitle={room.title}
          defaultTitle={room.title}
          defaultValue={latestConclusion}
          scopes={memoryScopes}
          onSave={async (input) => {
            await promoteConversationConclusion(runtimeMemoryPorts, {
              conversation: room,
              title: input.title,
              value: input.value,
              scope: { level: input.scopeId, id: memoryScopeId(input.scopeId) },
              promotedAt: new Date().toISOString(),
            });
          }}
          onClose={() => setMemoryOpen(false)}
        />
      ) : null}
    </div>
  );
}
