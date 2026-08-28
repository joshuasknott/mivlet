import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile } from "@fable/protocol";
import { AgentEditor } from "../components/agents/AgentEditor";
import {
  AgentLearningDialog,
  type AgentLearningSource
} from "../components/agents/AgentLearningDialog";
import { AgentSidebar, type AgentSidebarPreview } from "../components/agents/AgentSidebar";
import { AgentWelcome } from "../components/agents/AgentWelcome";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";
import { ProfileAgentAvatar, nextAgentColor } from "../components/agents/agent-icons";
import { LiveWorkRail } from "../components/agents/LiveWorkRail";
import { Composer } from "../components/Composer";
import { buildAgentRequest, PERMISSION_PROFILES, validateModelSelection } from "../lib/agent-run";
import { agentExecutionInstructions } from "../lib/agent-learning";
import { insertDictation } from "../lib/insert-dictation";
import { tabs as settingsTabs, type SettingsTab } from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { useShellAgentController } from "./useShellAgentController";

const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((module) => ({ default: module.ApprovalPanel }))
);
const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((module) => ({ default: module.OnboardingPage }))
);
const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((module) => ({ default: module.SettingsPage }))
);

interface QueuedPrompt {
  threadId: string;
  prompt: string;
}

function compactTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The Fable desktop product: named teammates, one durable conversation, and bounded tools. */
export function ChatWorkspace() {
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem("fable-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [learningDialog, setLearningDialog] = useState<{
    mode: "manage" | "teach";
    source: AgentLearningSource | null;
  } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");
  const [submissionError, setSubmissionError] = useState("");
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const wasRunningRef = useRef(false);

  const controller = useShellAgentController({
    threadId: selectedThreadId,
    onDictation: addDictationToComposer,
    onVoiceCancel: focusComposer
  });
  const {
    runtime,
    agent,
    durableConversation,
    voice,
    localComputer,
    hostedComputer,
    hostedBrowser,
    stopCurrentWork,
    resetCancellation
  } = controller;
  const activeAgent = runtime.agents.find((candidate) => candidate.id === runtime.activeAgentId)
    ?? runtime.agents[0];

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!activeAgent) return;
    runtime.selectModel(activeAgent.modelId);
    runtime.selectPermissionLabel(activeAgent.permissionLabel);
  }, [activeAgent?.id, activeAgent?.modelId, activeAgent?.permissionLabel]);

  useEffect(() => {
    if (!activeAgent) return;
    setSelectedThreadId(activeAgent.threadId);
    setOptimisticUserMessage("");
    setSubmissionError("");
  }, [activeAgent?.id]);

  useEffect(() => {
    if (runtime.openApprovals.length > 0) setWorkPanelOpen(true);
  }, [runtime.openApprovals.length]);

  useEffect(() => {
    const draft = durableConversation.state.draft;
    if (!draft || draft.draftKey !== durableConversation.draftKey) return;
    if (!runtime.composerValue) runtime.setComposerValue(draft.content);
  }, [durableConversation.draftKey, durableConversation.state.draft?.draftKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = runtime.composerValue;
      const saved = durableConversation.state.draft?.content ?? "";
      if (current === saved) return;
      if (current) void durableConversation.saveDraft(current);
      else void durableConversation.deleteDraft();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    durableConversation.deleteDraft,
    durableConversation.saveDraft,
    durableConversation.state.draft?.content,
    runtime.composerValue
  ]);

  useEffect(() => {
    if (wasRunningRef.current && !agent.state.running) {
      void durableConversation.refresh();
      setOptimisticUserMessage("");
    }
    wasRunningRef.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

  useEffect(() => {
    conversationScrollRef.current?.scrollTo({
      top: conversationScrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [
    agent.state.transcript,
    durableConversation.state.conversation?.messages.length,
    optimisticUserMessage
  ]);

  const composerModels = useMemo(
    () => composerModelsFor(runtime.connectedAgentBackend?.id, runtime.modelOptions),
    [runtime.connectedAgentBackend?.id, runtime.modelOptions]
  );
  const selectedModelOptionId = useMemo(() => {
    if (
      runtime.selectedModelId
      && composerModels.some((candidate) => candidate.id === runtime.selectedModelId)
    ) {
      return runtime.selectedModelId;
    }
    return composerModels[0]?.id ?? runtime.resolvedModelOptionId;
  }, [composerModels, runtime.resolvedModelOptionId, runtime.selectedModelId]);
  const selectedModelId = useMemo(
    () => composerModels.find((candidate) => candidate.id === selectedModelOptionId)?.modelId
      ?? runtime.resolvedSelectedModelId,
    [composerModels, runtime.resolvedSelectedModelId, selectedModelOptionId]
  );
  const selectedModelLabel = composerModels.find(
    (candidate) => candidate.id === selectedModelOptionId
  )?.label ?? "Choose model";
  const connectedConnectors = useMemo(
    () => runtime.connectorManifests
      .filter((connector) => connector.status === "connected" && connector.id !== "local-files")
      .map((connector) => ({ id: connector.id, name: connector.name, status: connector.status })),
    [runtime.connectorManifests]
  );

  const executePrompt = useCallback(async (prompt: string) => {
    if (!activeAgent || !selectedThreadId || agent.state.running) return;
    const connected = runtime.connectedAgentBackend;
    if (!connected) {
      setSettingsTab("providers");
      setSettingsOpen(true);
      setSubmissionError("Connect a model provider before sending a message.");
      return;
    }
    const validation = validateModelSelection(
      connected.id,
      selectedModelId,
      runtime.selectableModels,
      2_048
    );
    if (!validation.ok) {
      const message = validation.error ?? "The selected model is unavailable.";
      agent.reportError(message);
      setSubmissionError(message);
      return;
    }
    setSubmissionError("");
    setOptimisticUserMessage(prompt);
    runtime.setComposerValue("");
    await durableConversation.deleteDraft().catch(() => undefined);
    resetCancellation();
    try {
      const instructions = agentExecutionInstructions(activeAgent);
      const executionPrompt = instructions
        ? `Teammate instructions:\n${instructions}\n\nUser request:\n${prompt}`
        : prompt;
      const preparedContext = await runtime.assembleKnowledgeContext(prompt, {
        allowedConnectorIds: activeAgent.connectorIds,
        allowedKnowledgeSourceIds: activeAgent.knowledgeSourceIds
      });
      await agent.run(
        buildAgentRequest({
          model: selectedModelId,
          prompt: executionPrompt,
          maxTokens: validation.maxTokens
        }),
        preparedContext,
        runtime.permissionMode
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not complete that response.";
      agent.reportError(message);
      setSubmissionError(message);
    } finally {
      await durableConversation.refresh();
      setOptimisticUserMessage("");
    }
  }, [
    activeAgent,
    agent.reportError,
    agent.run,
    agent.state.running,
    durableConversation.deleteDraft,
    durableConversation.refresh,
    resetCancellation,
    runtime.assembleKnowledgeContext,
    runtime.connectedAgentBackend,
    runtime.permissionMode,
    runtime.selectableModels,
    runtime.setComposerValue,
    selectedModelId,
    selectedThreadId
  ]);

  useEffect(() => {
    if (!queuedPrompt || queuedPrompt.threadId !== selectedThreadId) return;
    setQueuedPrompt(null);
    void executePrompt(queuedPrompt.prompt);
  }, [executePrompt, queuedPrompt, selectedThreadId]);

  if (!activeAgent) {
    return <main className="og-frame"><p role="alert">Fable could not load a teammate.</p></main>;
  }

  const localWorkspaceReady = runtime.accountWorkspaceStatus.activeWorkspace.source === "local"
    && runtime.accountWorkspaceStatus.accountBound
    && runtime.accountWorkspaceStatus.state === "ready";
  if (!localWorkspaceReady || runtime.onboardingRequired) {
    return (
      <Suspense fallback={<main className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          accountWorkspaceStatus={runtime.accountWorkspaceStatus}
          accountWorkspacePending={runtime.accountWorkspacePending}
          onConnect={(providerId, secret) => void runtime.connectBackend(providerId, secret)}
          onConnectWithVerify={runtime.connectBackendWithVerify}
          onCheckConnection={runtime.checkBackendConnection}
          onStartBrowserLogin={runtime.startBackendBrowserLogin}
          initialTeammateName={activeAgent.name}
          initialTeammatePurpose={activeAgent.instructions}
          onConfigureTeammate={({ name, purpose }) => {
            runtime.updateAgent(activeAgent.id, { name, instructions: purpose });
          }}
          onComplete={runtime.dismissOnboarding}
        />
      </Suspense>
    );
  }

  const submitComposer = async () => {
    const prompt = runtime.composerValue.trim();
    if (!prompt || agent.state.running || queuedPrompt) return;
    if (!selectedThreadId) {
      const thread = await durableConversation.createThread({
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "current-member" as never
        },
        title: prompt.slice(0, 72)
      });
      runtime.updateAgent(activeAgent.id, { threadId: thread.id });
      setSelectedThreadId(thread.id);
      setQueuedPrompt({ threadId: thread.id, prompt });
      return;
    }
    await executePrompt(prompt);
  };

  const selectAgent = (profile: FableAgentProfile) => {
    if (agent.state.running) {
      runtime.setLastAction("Stop the current response before switching teammates.");
      return;
    }
    runtime.selectAgent(profile.id);
    setSelectedThreadId(profile.threadId);
    runtime.setComposerValue("");
    setSubmissionError("");
  };
  const createTeammate = () => {
    setEditingAgentId(null);
    setAgentEditorOpen(true);
  };
  const editTeammate = (profile: FableAgentProfile) => {
    setEditingAgentId(profile.id);
    setAgentEditorOpen(true);
  };
  const startNewConversation = () => {
    if (agent.state.running) return;
    runtime.updateAgent(activeAgent.id, { threadId: undefined });
    setSelectedThreadId(undefined);
    runtime.setComposerValue("");
    setSubmissionError("");
    setOptimisticUserMessage("");
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  };

  const threadById = new Map(
    durableConversation.state.threads.map((thread) => [thread.id as string, thread])
  );
  const previews = Object.fromEntries(runtime.agents.map((profile) => {
    const thread = profile.threadId ? threadById.get(profile.threadId) : undefined;
    const status: AgentSidebarPreview["status"] = profile.id === activeAgent.id && agent.state.running
      ? "running"
      : profile.id === activeAgent.id && runtime.openApprovals.length
        ? "attention"
        : "idle";
    return [profile.id, {
      message: thread?.title ?? "Start a conversation",
      time: compactTime(thread?.updatedAt),
      status
    } satisfies AgentSidebarPreview];
  }));
  const verifiedDisplay = runtime.identityStatus.authentication?.verifiedDisplayAttributes;
  const profileName = verifiedDisplay?.displayName ?? verifiedDisplay?.email ?? "Local workspace";
  const conversation = durableConversation.state.conversation;
  const messages = conversation?.messages ?? [];
  const screenPreviewUrl = localComputer.snapshot?.previewDataUrl
    ?? hostedBrowser.snapshot?.previewDataUrl;
  const approvalPanel = runtime.openApprovals.length ? (
    <Suspense fallback={null}>
      <ApprovalPanel
        approvals={runtime.openApprovals}
        audit={runtime.approvalAudit}
        sessionGrants={runtime.sessionApprovalGrants}
        approvalRules={runtime.approvalRules}
        editingApprovalId={runtime.editingApprovalId}
        modificationDraft={runtime.approvalModificationDraft}
        pendingConfirmation={runtime.pendingApprovalConfirmation}
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
    </Suspense>
  ) : undefined;

  return (
    <main
      className={`desktop-frame desktop-frame--agents${workPanelOpen ? "" : " desktop-frame--live-closed"}`}
      data-theme={theme}
    >
      <AgentSidebar
        agents={runtime.agents}
        activeAgentId={activeAgent.id}
        previews={previews}
        profileName={profileName}
        onSelectAgent={selectAgent}
        onCreateAgent={createTeammate}
        onEditAgent={editTeammate}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <section className="agent-workspace">
        <AgentWorkspaceHeader
          agent={activeAgent}
          learnedCount={activeAgent.learnedTasks?.length ?? 0}
          learnedOpen={learningDialog !== null}
          onOpenLearned={() => setLearningDialog({ mode: "manage", source: null })}
          attentionCount={runtime.openApprovals.length}
          panelOpen={workPanelOpen}
          onTogglePanel={() => setWorkPanelOpen((open) => !open)}
        />
        <button
          type="button"
          className="agent-workspace__new-conversation"
          onClick={startNewConversation}
          disabled={agent.state.running}
        >
          New conversation
        </button>

        <div className="workspace-center workspace-center--composer workspace-center--conversation">
          <div ref={conversationScrollRef} className="conversation-scroll" aria-live="polite">
            {messages.length === 0 && !optimisticUserMessage && !agent.state.running ? (
              <AgentWelcome
                agent={activeAgent}
                onChoose={(prompt) => {
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              />
            ) : null}
            {messages.map((entry, index) => {
              const revision = entry.currentRevision;
              const content = revision.state === "redacted"
                ? "This message was removed."
                : revision.content;
              const role = entry.message.kind === "user" ? "user" : "assistant";
              if (!["user", "assistant", "tool", "approval", "interruption", "error"].includes(entry.message.kind)) {
                return null;
              }
              const priorUser = [...messages.slice(0, index)].reverse().find(
                (candidate) => candidate.message.kind === "user"
              )?.currentRevision;
              return (
                <article
                  key={entry.message.id}
                  className={`conversation-message conversation-message--${role}`}
                >
                  <div className="conversation-message__author">
                    {role === "assistant" ? (
                      <ProfileAgentAvatar agent={activeAgent} iconSize={36} />
                    ) : (
                      <span className="conversation-message__user-avatar">
                        {profileName.trim().slice(0, 1).toUpperCase() || "F"}
                      </span>
                    )}
                    <strong>{role === "assistant" ? activeAgent.name : profileName}</strong>
                  </div>
                  <p>{content}</p>
                  {entry.message.kind === "assistant" && revision.state !== "redacted" ? (
                    <div className="conversation-message-actions">
                      <button
                        type="button"
                        className="conversation-message-action"
                        onClick={() => void navigator.clipboard?.writeText(content)}
                      >
                        Copy
                      </button>
                      {priorUser?.state !== "redacted" ? (
                        <button
                          type="button"
                          className="conversation-message-action"
                          onClick={() => setLearningDialog({
                            mode: "teach",
                            source: {
                              prompt: priorUser?.content ?? "",
                              response: content
                            }
                          })}
                        >
                          Teach this
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
            {optimisticUserMessage ? (
              <article className="conversation-message conversation-message--user">
                <div className="conversation-message__author">
                  <span className="conversation-message__user-avatar">
                    {profileName.trim().slice(0, 1).toUpperCase() || "F"}
                  </span>
                  <strong>{profileName}</strong>
                </div>
                <p>{optimisticUserMessage}</p>
              </article>
            ) : null}
            {agent.state.running ? (
              <article className="conversation-message conversation-message--assistant conversation-message--working">
                <div className="conversation-message__author">
                  <ProfileAgentAvatar agent={activeAgent} iconSize={36} />
                  <strong>{activeAgent.name}</strong>
                </div>
                <p>{agent.state.transcript || "Thinking…"}</p>
              </article>
            ) : null}
            {submissionError || agent.state.lastError ? (
              <p className="conversation-status conversation-status--error" role="alert">
                {submissionError || agent.state.lastError}
              </p>
            ) : null}
            {durableConversation.state.error ? (
              <p className="conversation-status conversation-status--error" role="alert">
                {durableConversation.state.error}
              </p>
            ) : null}
            {agent.state.recoverableAttempts.slice(0, 2).map((attempt) => (
              <section className="agent-panel__recovery" key={attempt.id}>
                <p>A previous response was interrupted. Retry it from its original prompt?</p>
                <button
                  type="button"
                  onClick={() => {
                    setOptimisticUserMessage(
                      attempt.exchanges?.filter((exchange) => exchange.role === "user").at(-1)?.content ?? ""
                    );
                    resetCancellation();
                    void agent.retry(attempt).finally(() => durableConversation.refresh());
                  }}
                >
                  Retry response
                </button>
              </section>
            ))}
          </div>

          <div className="conversation-composer-dock">
            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                void submitComposer();
              }}
              voiceStatus={voice.state.status}
              voiceMessage={voice.state.message}
              voiceCanStart={voice.canStart}
              voiceDisclosure={voice.processingDisclosure}
              onStartVoice={() => void voice.start()}
              onStopVoice={voice.stop}
              onCancelVoice={voice.cancel}
              onDismissVoice={voice.dismiss}
              onAttach={runtime.triggerAttach}
              addMenuOpen={addMenuOpen}
              permissionsOpen={permissionsOpen}
              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
                setPermissionsOpen(false);
              }}
              onTogglePermissions={() => {
                setPermissionsOpen((open) => !open);
                setAddMenuOpen(false);
              }}
              onOpenTool={(tool) => {
                setSettingsTab(tool === "Connectors" ? "connections" : "general");
                setSettingsOpen(true);
                setAddMenuOpen(false);
              }}
              onRunCommand={(command) => runtime.setComposerValue(command)}
              onFileChange={runtime.handleComposerAttachmentChange}
              importStatus={runtime.importStatus}
              models={composerModels}
              selectedModelId={selectedModelOptionId}
              selectedModelLabel={selectedModelLabel}
              onSelectModel={(modelId) => {
                runtime.selectModel(modelId);
                runtime.updateAgent(activeAgent.id, { modelId });
              }}
              permissionLabel={runtime.permissionLabel}
              permissionProfiles={PERMISSION_PROFILES}
              onSelectPermissionLabel={(label) => {
                runtime.selectPermissionLabel(label);
                runtime.updateAgent(activeAgent.id, {
                  permissionLabel: label as FableAgentProfile["permissionLabel"]
                });
              }}
              inThread={Boolean(selectedThreadId)}
              isWorking={agent.state.running}
              onStop={() => void stopCurrentWork()}
              connectedConnectors={connectedConnectors}
              knowledgeSources={runtime.workspaceKnowledgeSources}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
            />
          </div>
        </div>
      </section>

      {workPanelOpen ? (
        <LiveWorkRail
          agentName={activeAgent.name}
          approvalPanel={approvalPanel}
          localComputer={{
            available: localComputer.available,
            status: localComputer.node?.lifecycle,
            browserAvailable: localComputer.node?.browserAvailable ?? false,
            browserActive: localComputer.node?.browserActive ?? false,
            browserProduct: localComputer.node?.browserProduct,
            canGoBack: localComputer.snapshot?.canGoBack ?? false,
            canGoForward: localComputer.snapshot?.canGoForward ?? false,
            filesAvailable: Boolean(
              localComputer.node
              && localComputer.node.lifecycle !== "unprovisioned"
              && localComputer.node.capabilities.includes("persistent-files")
            ),
            files: localComputer.files,
            filesLoading: localComputer.filesLoading,
            filesError: localComputer.filesError,
            filePreview: localComputer.filePreview,
            filePreviewLoading: localComputer.filePreviewLoading,
            filePreviewError: localComputer.filePreviewError,
            controller: localComputer.snapshot?.controller ?? localComputer.node?.controller ?? "agent",
            loading: localComputer.loading,
            provisioning: localComputer.provisioning,
            busy: localComputer.browserBusy,
            recoveryNeeded: localComputer.recoveryNeeded,
            error: localComputer.error,
            browserUrl: localComputer.snapshot?.currentUrl,
            browserTitle: localComputer.snapshot?.title,
            generation: localComputer.snapshot?.generation ?? 0,
            viewport: localComputer.snapshot?.viewport,
            onProvision: localComputer.provision,
            onOpenBrowser: localComputer.navigate,
            onRefreshBrowser: localComputer.refresh,
            onGoBack: localComputer.goBack,
            onGoForward: localComputer.goForward,
            onRefreshFiles: localComputer.refreshFiles,
            onPreviewFile: localComputer.previewFile,
            onCloseFilePreview: localComputer.closeFilePreview,
            onTakeControl: localComputer.takeControl,
            onReturnControl: localComputer.returnControl,
            onClick: localComputer.click,
            onScroll: localComputer.scroll,
            onKey: localComputer.key
          }}
          hostedComputer={{
            available: hostedComputer.available,
            status: hostedComputer.node?.status,
            runtimeActive: hostedComputer.node?.runtimeActive ?? false,
            keepAlive: hostedComputer.node?.keepAlive ?? false,
            loading: hostedComputer.loading,
            provisioning: hostedComputer.provisioning,
            error: hostedComputer.error,
            onProvision: hostedComputer.provision,
            browserOpening: hostedBrowser.opening,
            browserPhase: hostedBrowser.phase,
            browserError: hostedBrowser.error,
            browserUrl: hostedBrowser.snapshot?.currentUrl,
            browserTitle: hostedBrowser.snapshot?.title,
            liveViewUrl: hostedBrowser.snapshot?.liveViewUrl,
            browserDownload: hostedBrowser.snapshot?.lastDownload,
            onOpenBrowser: hostedBrowser.open,
            onRefreshBrowser: hostedBrowser.refresh
          }}
          screenPreviewUrl={screenPreviewUrl}
          onClose={() => setWorkPanelOpen(false)}
        />
      ) : null}

      <AgentEditor
        open={agentEditorOpen}
        agent={editingAgentId
          ? runtime.agents.find((profile) => profile.id === editingAgentId) ?? null
          : null}
        models={runtime.modelOptions}
        connectors={runtime.connectorManifests}
        knowledgeSources={runtime.workspaceKnowledgeSources}
        suggestedColor={nextAgentColor(runtime.agents.map((profile) => profile.iconColor))}
        canDelete={runtime.agents.length > 1}
        onClose={() => {
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
        onSave={(draft) => {
          if (editingAgentId) {
            runtime.updateAgent(editingAgentId, draft);
          } else {
            const created = runtime.createAgent(draft);
            runtime.selectAgent(created.id);
            setSelectedThreadId(undefined);
          }
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
        onDelete={() => {
          if (editingAgentId) runtime.removeAgent(editingAgentId);
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
      />

      <AgentLearningDialog
        open={learningDialog !== null}
        agent={activeAgent}
        source={learningDialog?.mode === "teach" ? learningDialog.source : null}
        onClose={() => setLearningDialog(null)}
        onChange={(learnedTasks) => runtime.updateAgent(activeAgent.id, { learnedTasks })}
        onRun={(task) => {
          setLearningDialog(null);
          runtime.setComposerValue(task.instruction);
          window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
        }}
      />

      {settingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section
            ref={settingsRef}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            tabIndex={-1}
          >
            <aside className="settings-modal__nav" aria-label="Settings sections">
              <nav className="settings-modal__tab-list" aria-label="Settings">
                {settingsTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={settingsTab === tab.id
                      ? "settings-modal__tab settings-modal__tab--active"
                      : "settings-modal__tab"}
                    aria-current={settingsTab === tab.id ? "page" : undefined}
                    onClick={() => setSettingsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            </aside>
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={settingsTab}
                  workspaceName={
                    runtime.accountWorkspaceStatus.activeWorkspace.name || "Fable workspace"
                  }
                  dictationCapability={voice.capability}
                  titleId="settings-modal-title"
                />
              </Suspense>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );

  function focusComposer() {
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  }

  function addDictationToComposer(transcript: string) {
    const composer = runtime.composerRef.current;
    const insertion = insertDictation(
      runtime.composerValue,
      transcript,
      composer?.selectionStart ?? runtime.composerValue.length,
      composer?.selectionEnd ?? runtime.composerValue.length
    );
    runtime.setComposerValue(insertion.value);
    window.requestAnimationFrame(() => {
      runtime.composerRef.current?.focus();
      runtime.composerRef.current?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }
}
