import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
  WorkspaceView,
} from "@fable/protocol";
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
import { prepareReadableComposerAttachment } from "../lib/composer-attachments";
import { builtinPluginMentions } from "../lib/builtin-plugins";
import { importRuntimeRepository } from "../runtime/domains/local-computer";
import { composerModelsFor } from "./composer-models";
import { Composer } from "../components/Composer";
import type { ComposerInputHandle } from "../components/ComposerInput";
import type { ComposerAttachment } from "../lib/types";
import { ConversationFeed } from "../components/conversation/ConversationFeed";
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import { ProjectContextPanel } from "../components/projects/ProjectContextPanel";
import { WorkItems } from "../components/projects/WorkItems";
import { agentPresence } from "../lib/agent-presence";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { ContextRecoveryPanel } from "../components/conversation/ContextRecoveryPanel";
import { buildConversationHandoff } from "../lib/conversation-handoff";

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

export const idleAgentState: NativeAgentState = {
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
  onOpen,
  onClose,
  onArtifact,
  onEdit,
  onPlace,
  onNew,
  onSchedules,
  onComputer,
  onPlugins,
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
  onOpen: (id: string) => void;
  onClose: () => void;
  onArtifact: (output: string, agentId: string) => void;
  onEdit: () => void;
  onPlace: () => void;
  onNew: (draft?: string) => Promise<string | void>;
  onSchedules: () => void;
  onComputer: (agentId: string) => void;
  onPlugins: (id?: string) => void;
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
  const displayAgent: FableAgentProfile = profile ?? {
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
  const sessions = state.sessions.filter(
    (session) => session.work.conversationId === room.id && !session.cancelled,
  );
  const work = state.data.work.filter(
    (work) => work.conversationId === room.id,
  );
  const running = work.filter(activeWork);
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
  const authors = Object.fromEntries(
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
  const connected = [
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
  const send = async () => {
    const prompt = composer.text.trim();
    if (!composer.ready || !prompt || submission.current || voice.isBusy)
      return;
    if (
      !profile ||
      !room.participants.some((member) => member.agentId === profile.id)
    ) {
      setError("Choose an available participant before sending.");
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
        profile.id,
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
  const importRepository = async () => {
    if (pending || !profile) return;
    setPending(true);
    setError("");
    const draft = composer;
    try {
      const node = await localComputer.prepareForTool("read-file");
      const receipt = await importRuntimeRepository(
        { workspaceId: service.workspaceId, agentId: profile.id },
        node.generation,
      );
      if (receipt)
        draft.setText(
          `${draft.text}${draft.text ? "\n\n" : ""}I imported a repository snapshot into Workspace/${receipt.relativePath} (${receipt.files} files; ${receipt.skipped} excluded entries). Inspect its structure and instructions before editing. This private snapshot is not connected to an execution runtime. Do not claim to run builds, tests or Git commands without a separately configured and approved execution environment.`,
        );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not import this repository.",
      );
    } finally {
      setPending(false);
    }
  };
  const contextFailure = sessions.find(
    (session) => session.state?.contextFailure,
  )?.state?.contextFailure;
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
    <div className="conversation-pane-content">
      <header className="team-conversation-header">
        <div className="team-conversation-identity">
          <ProfileAgentAvatar
            agent={displayAgent}
            iconSize={29}
            presence={agentPresence(baseState, approvals.length > 0)}
          />
          <span>
            <strong>{room.title}</strong>
            <small>
              {project ? `${project.name} · ` : ""}
              {room.kind === "direct"
                ? displayAgent.name
                : `${room.participants.length} participants · ${runtime.agents.find((agent) => agent.id === room.facilitatorId)?.name ?? "Choose a facilitator"} facilitates`}
            </small>
          </span>
        </div>
        <div className="team-conversation-actions">
          <button
            type="button"
            aria-label={`Open ${displayAgent.name}'s computer`}
            onClick={() => onComputer(displayAgent.id)}
          >
            <Desktop size={18} />
          </button>
          <details>
            <summary aria-label="Conversation options">
              <DotsThree size={22} />
            </summary>
            <div>
              <button type="button" onClick={() => void onNew()}>
                New conversation
              </button>
              <button type="button" onClick={onEdit}>
                Edit{" "}
                {project
                  ? "project"
                  : room.kind === "group"
                    ? "participants and title"
                    : "conversation"}
              </button>
              {!project ? (
                <button type="button" onClick={onPlace}>
                  Place in project…
                </button>
              ) : null}
              <button type="button" onClick={onSchedules}>
                Schedules
              </button>
            </div>
          </details>
        </div>
      </header>
      {project ? (
        <ProjectContextPanel
          project={project}
          room={room}
          data={state.data}
          runtime={runtime}
          service={service}
          onOpen={onOpen}
          onNewConversation={() => void onNew()}
          onEdit={onEdit}
          onSchedules={onSchedules}
          onUpdate={onProjectUpdate}
        />
      ) : work.length ? (
        <details className="conversation-work">
          <summary>
            Activity{" "}
            <small>
              {running.length
                ? `${running.length} active`
                : `${work.length} recorded`}
            </small>
          </summary>
          <WorkItems work={work} service={service} onOpen={onOpen} />
        </details>
      ) : null}
      <div
        className="conversation-pane-scroll"
        ref={scroll.scrollRef}
        onScroll={scroll.onScroll}
        onWheel={scroll.pauseFollowing}
      >
        <div className="conversation-pane-messages" ref={scroll.contentRef}>
          {history === undefined ? (
            <p className="team-empty" role="status">
              Loading conversation…
            </p>
          ) : !history?.messages.length && !liveStates.length ? (
            <div className="team-conversation-welcome">
              <h1>
                {project
                  ? "What should we move forward?"
                  : room.kind === "group"
                    ? "Give this group an outcome"
                    : `Work with ${displayAgent.name}`}
              </h1>
              <p>
                {room.kind === "group"
                  ? "Address a participant, ask for a discussion, or let the facilitator organise the work."
                  : "Each conversation keeps its own history and draft."}
              </p>
            </div>
          ) : null}
          <ConversationFeed
            messages={history?.messages ?? []}
            agent={displayAgent}
            authors={authors}
            requireAuthor
            showAuthor
            state={idleAgentState}
            liveStates={liveStates}
            threadId={room.id}
            profileName={profileName}
            connectors={runtime.connectorManifests}
            optimisticPrompt=""
            workspaceId={service.workspaceId}
            generation={localComputer.node?.generation}
            onPreviewArtifact={(output, authorId) =>
              onArtifact(output, authorId ?? displayAgent.id)
            }
            onOpenConnector={onPlugins}
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
          {approvals.length ? (
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
          ) : null}
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
        </div>
      </div>
      <div className="conversation-pane-composer">
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
          onImportRepository={() => void importRepository()}
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
          selectedReasoningEffort={profile?.reasoningEffort}
          onSelectReasoningEffort={(effort) => {
            if (profile)
              runtime.updateAgent(profile.id, { reasoningEffort: effort });
          }}
          onSelectModel={(modelId) => {
            if (profile) runtime.updateAgent(profile.id, { modelId });
          }}
          placeholder={
            room.kind === "group"
              ? "Message the group…"
              : `Message ${displayAgent.name}…`
          }
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
              <label className="team-recipient">
                <span>To</span>
                <select
                  aria-label="Message recipient"
                  value={recipient}
                  onChange={(event) =>
                    composer.setRecipient(event.target.value)
                  }
                >
                  <option value={room.facilitatorId ?? ""}>
                    {runtime.agents.find(
                      (agent) => agent.id === room.facilitatorId,
                    )?.name ?? "Choose facilitator"}{" "}
                    · facilitator
                  </option>
                  {room.participants
                    .filter((member) => member.agentId !== room.facilitatorId)
                    .map((member) => (
                      <option
                        value={member.agentId}
                        key={member.agentId}
                        disabled={
                          !runtime.agents.some(
                            (agent) => agent.id === member.agentId,
                          )
                        }
                      >
                        {member.name}
                        {!runtime.agents.some(
                          (agent) => agent.id === member.agentId,
                        )
                          ? " · unavailable"
                          : ""}
                      </option>
                    ))}
                  <option value="discussion">Wider discussion</option>
                </select>
              </label>
            ) : undefined
          }
        />
        {room.kind === "group" ? (
          <p className="conversation-sharing">
            Shared with this conversation’s participants. Each agent uses its
            own model.
          </p>
        ) : null}
      </div>
    </div>
  );
}
