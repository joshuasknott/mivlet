import { ConversationFeed } from "../components/conversation/ConversationFeed";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { CONVERSATION_STYLE_INSTRUCTIONS } from "../lib/conversation-presentation";
import { ArtifactPreview } from "../components/conversation/ArtifactPreview";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { agentPresence, presenceLabel } from "../lib/agent-presence";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile } from "@fable/protocol";
import { AgentEditor } from "../components/agents/AgentEditor";
import { AccountDialog } from "../components/agents/AccountDialog";
import { SettingsModal } from "../components/settings/SettingsModal";
import {
  AgentSidebar,
  type AgentSidebarPreview,
} from "../components/agents/AgentSidebar";
import { AgentWelcome } from "../components/agents/AgentWelcome";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";

import { LiveWorkRail } from "../components/agents/LiveWorkRail";
import { Composer } from "../components/Composer";


import {
  buildAgentRequest,
  validateModelSelection,
} from "../lib/agent-run";
import { agentExecutionInstructions } from "../lib/agent-learning";
import { insertDictation } from "../lib/insert-dictation";
import { conversationToolsForModel, COMPUTER_WORK_INSTRUCTIONS } from "../lib/computer-tools";
import {
  type SettingsTab,
} from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { useShellAgentController } from "./useShellAgentController";

const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((module) => ({
    default: module.ApprovalPanel,
  })),
);
const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((module) => ({
    default: module.OnboardingPage,
  })),
);
const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const MarketplacePage = lazy(() =>
  import("../components/pages/MarketplacePage").then((module) => ({
    default: module.MarketplacePage,
  })),
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
  const [accountDialog, setAccountDialog] = useState<"usage" | "sign-out" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [marketplaceTab, setMarketplaceTab] = useState<"plugins" | null>(
    null,
  );
  const [marketplaceConnectorId, setMarketplaceConnectorId] = useState<string>();
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const isPhone = useMediaQuery("(max-width: 650px)");
  const [mobileConversation, setMobileConversation] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const navigationPending = useRef(false);
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");
  const [submissionError, setSubmissionError] = useState("");
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<string | null>(null);
  const artifactTrigger = useRef<HTMLElement | null>(null);

  const wasRunningRef = useRef(false);

  const controller = useShellAgentController({
    threadId: selectedThreadId,
    thumbnailEnabled: workPanelOpen && pageVisible,
    onDictation: addDictationToComposer,
    onVoiceCancel: focusComposer,
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
    resetCancellation,
    beginConnectorTurn,
    endConnectorTurn,
  } = controller;
  const activeAgent =
    runtime.agents.find(
      (candidate) => candidate.id === runtime.activeAgentId,
    ) ?? runtime.agents[0];

  useEffect(() => { setArtifactPreview(null); }, [activeAgent?.id, selectedThreadId, runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId, localComputer.node?.generation]);

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!activeAgent) return;
    runtime.selectModel(activeAgent.modelId);
  }, [activeAgent?.id, activeAgent?.modelId]);

  useEffect(() => {
    if (!activeAgent) return;
    setSelectedThreadId(activeAgent.threadId);
    setOptimisticUserMessage("");
    setSubmissionError("");
  }, [activeAgent?.id]);


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
    runtime.composerValue,
  ]);

  useEffect(() => {
    if (wasRunningRef.current && !agent.state.running) {
      void durableConversation.refresh();
      setOptimisticUserMessage("");
    }
    wasRunningRef.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

  const conversationScroll = useConversationScroll(
    `${runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}:${activeAgent?.id}:${selectedThreadId}`,
    `${agent.state.transcript}:${agent.state.activity}:${agent.state.running}:${durableConversation.state.conversation?.messages.length}:${optimisticUserMessage}:${runtime.openApprovals.length}`,
  );

  const composerModels = useMemo(
    // The composer is the provider switcher. Passing no provider filter keeps
    // every connected provider selectable instead of trapping the user on the
    // provider that owns the currently persisted model.
    () => composerModelsFor(undefined, runtime.modelOptions),
    [runtime.modelOptions],
  );
  const selectedModelOptionId = useMemo(() => {
    if (
      runtime.selectedModelId &&
      composerModels.some(
        (candidate) => candidate.id === runtime.selectedModelId,
      )
    ) {
      return runtime.selectedModelId;
    }
    return runtime.resolvedModelOptionId;
  }, [composerModels, runtime.resolvedModelOptionId, runtime.selectedModelId]);
  const selectedModelId = useMemo(
    () =>
      composerModels.find((candidate) => candidate.id === selectedModelOptionId)
        ?.modelId ?? runtime.resolvedSelectedModelId,
    [composerModels, runtime.resolvedSelectedModelId, selectedModelOptionId],
  );
  const selectedModelLabel =
    composerModels.find((candidate) => candidate.id === selectedModelOptionId)
      ?.label ?? "Choose model";
  const selectedReasoning = composerModels.find((model) => model.id === selectedModelOptionId)?.reasoning;
  const selectedReasoningEffort = activeAgent?.reasoningEffort && selectedReasoning?.supportedEfforts.includes(activeAgent.reasoningEffort)
    ? activeAgent.reasoningEffort : undefined;
  const connectedConnectors = useMemo(
    () =>
      runtime.connectorManifests
        .filter(
          (connector) =>
            connector.status === "connected" && connector.id !== "local-files",
        )
        .map((connector) => ({
          id: connector.id,
          name: connector.name,
          status: connector.status,
        })),
    [runtime.connectorManifests],
  );

  const submissionPending = useRef(false);
  const executePrompt = useCallback(
    async (prompt: string) => {
      if (!activeAgent || !selectedThreadId || agent.state.running || submissionPending.current || !runtime.runtimeSnapshotReady || runtime.runtimeSnapshotError) return;
      const connected = runtime.connectedAgentBackend;
      if (!connected) {
        setSettingsTab("providers");
        setSettingsOpen(true);
        setSubmissionError(
          "Connect a model provider before sending a message.",
        );
        return;
      }
      const validation = validateModelSelection(
        connected.id,
        selectedModelId,
        runtime.selectableModels,
        2_048,
      );
      if (!validation.ok) {
        const message =
          validation.error ?? "The selected model is unavailable.";
        agent.reportError(message);
        setSubmissionError(message);
        return;
      }
      submissionPending.current = true;
      setSubmissionError("");
      setOptimisticUserMessage(prompt);
      runtime.setComposerValue("");
      await durableConversation.deleteDraft().catch(() => undefined);
      resetCancellation();
      try {
        const { ids: connectorIds, tools: connectorTools } = await beginConnectorTurn();
        const instructions = [agentExecutionInstructions(activeAgent), CONVERSATION_STYLE_INSTRUCTIONS, COMPUTER_WORK_INSTRUCTIONS].join("\n\n");
        const preparedContext = await runtime.assembleConversationContext(prompt, {
          allowedConnectorIds: connectorIds,
          allowedKnowledgeSourceIds: runtime.composerAttachments.flatMap((attachment) => attachment.sourceId ? [attachment.sourceId] : []),
        });
        await agent.run(
          buildAgentRequest({
            model: selectedModelId,
            reasoningEffort: selectedReasoningEffort,
            prompt,
            instructions,
            tools: conversationToolsForModel(connectorTools, localComputer.node?.lifecycle === "ready",
              connected, composerModels.find((model) => model.id === selectedModelOptionId)),
            maxTokens: validation.maxTokens,
          }),
          preparedContext,
          runtime.permissionMode,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Fable could not complete that response.";
        agent.reportError(message);
        setSubmissionError(message);
      } finally {
        submissionPending.current = false;
        endConnectorTurn();
        await Promise.allSettled([runtime.refreshConnectorStatuses(), durableConversation.refresh()]);
        setOptimisticUserMessage("");
      }
    },
    [
      activeAgent,
      agent.reportError,
      agent.run,
      agent.state.running,
      durableConversation.deleteDraft,
      durableConversation.refresh,
      durableConversation.state.conversation,
      resetCancellation,
      beginConnectorTurn,
      endConnectorTurn,
      runtime.assembleConversationContext,
      runtime.connectedAgentBackend,
      runtime.connectorManifests,
      runtime.refreshConnectorStatuses,
      runtime.permissionMode,
      runtime.selectableModels,
      runtime.runtimeSnapshotError,
      runtime.runtimeSnapshotReady,
      runtime.setComposerValue,
      selectedModelId,
      selectedModelOptionId,
      composerModels,
      localComputer.node?.lifecycle,
      selectedReasoningEffort,
      selectedThreadId,
    ],
  );

  useEffect(() => {
    if (!queuedPrompt || queuedPrompt.threadId !== selectedThreadId) return;
    setQueuedPrompt(null);
    void executePrompt(queuedPrompt.prompt);
  }, [executePrompt, queuedPrompt, selectedThreadId]);

  if (runtime.runtimeSnapshotError || !runtime.runtimeSnapshotReady) {
    return (
      <main className="og-frame">
        <section className="empty-state" role={runtime.runtimeSnapshotError ? "alert" : "status"} aria-busy={!runtime.runtimeSnapshotError}>
          <p>{runtime.runtimeSnapshotError ?? "Loading your workspace…"}</p>
          {runtime.runtimeSnapshotError && <button type="button" disabled={runtime.accountWorkspacePending} onClick={() => void runtime.reconcileAccountWorkspace()}>Retry</button>}
        </section>
      </main>
    );
  }

  if (!activeAgent) {
    return (
      <main className="og-frame">
        <p role="alert">Fable could not load a agent.</p>
      </main>
    );
  }

  const localWorkspaceReady =
    runtime.accountWorkspaceStatus.activeWorkspace.source === "local" &&
    runtime.accountWorkspaceStatus.accountBound &&
    runtime.accountWorkspaceStatus.state === "ready";
  if (!localWorkspaceReady || runtime.onboardingRequired) {
    return (
      <Suspense fallback={<main className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          connectors={runtime.connectorManifests}
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          identityStatus={runtime.identityStatus}
          identityPending={runtime.identityPending}
          onSignIn={() => runtime.signInIdentity()}
          onConnectWithVerify={runtime.connectBackendWithVerify}
          onCheckConnection={runtime.checkBackendConnection}
          onStartBrowserLogin={runtime.startBackendBrowserLogin}

          connectorStatus={runtime.connectorStatus}
          onConnectConnector={runtime.connectConnector}
          onComplete={runtime.dismissOnboarding}
        />
      </Suspense>
    );
  }

  const submitComposer = async () => {
    const prompt = runtime.composerValue.trim();
    if (!prompt || agent.state.running || queuedPrompt || deletingConversation || !runtime.runtimeSnapshotReady || runtime.runtimeSnapshotError) return;
    if (!selectedThreadId) {
      const thread = await durableConversation.createThread({
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "current-member" as never,
        },
        title: prompt.slice(0, 72),
      });
      runtime.updateAgent(activeAgent.id, { threadId: thread.id });
      setSelectedThreadId(thread.id);
      setQueuedPrompt({ threadId: thread.id, prompt });
      return;
    }
    await executePrompt(prompt);
  };

  const selectAgent = async (profile: FableAgentProfile) => {
    if (navigationPending.current) return false;
    // Returning to the current chat is navigation, even while a tool or an
    // approval is pending. Keep its response and draft intact.
    if (profile.id === activeAgent.id) {
      setMarketplaceTab(null);
      setMobileConversation(true);
      focusConversationBack();
      return true;
    }
    if (deletingConversation) return false;
    if (agent.state.running) {
      runtime.setLastAction(
        "Stop the current response before switching agents.",
      );
      return false;
    }
    navigationPending.current = true;
    try {
      // Flush before changing scope: a quick navigation must not discard the debounce's draft.
      await durableConversation.saveDraft(runtime.composerValue);
    } catch {
      runtime.setLastAction("Your draft could not be saved. Try again before switching agents.");
      return false;
    } finally { navigationPending.current = false; }
    runtime.selectAgent(profile.id);
    setMobileConversation(true);
    setWorkPanelOpen(false);
    focusConversationBack();
    setMarketplaceTab(null);
    setSelectedThreadId(profile.threadId);
    runtime.setComposerValue("");
    setSubmissionError("");
    return true;
  };
  const createTeammate = () => {
    setMarketplaceTab(null);
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
    durableConversation.state.threads.map((thread) => [
      thread.id as string,
      thread,
    ]),
  );
  const computerToolActive = agent.state.responseParts?.some((part) => part.kind === "tool" && part.state === "running" && (part.tool.startsWith("local-") || part.tool === "run-shell"));
  const activePresence = agentPresence(agent.state, runtime.openApprovals.length > 0, Boolean(queuedPrompt), {
    computerController: localComputer.node?.browserActive && (computerToolActive || (!agent.state.running && localComputer.controller === "human")) ? localComputer.controller : undefined,
    providerUnavailable: runtime.runtimeSnapshotReady && !runtime.connectedAgentBackend,
    listening: voice.state.status === "listening",
  });
  const previews = Object.fromEntries(
    runtime.agents.map((profile) => {
      const thread = profile.threadId
        ? threadById.get(profile.threadId)
        : undefined;
      const presence = profile.id === activeAgent.id ? activePresence : "idle";
      const status: AgentSidebarPreview["status"] = ["waiting", "input", "blocked", "unavailable"].includes(presence) ? "attention" : ["received", "working", "thinking", "service"].includes(presence) ? "running" : "idle";
      return [
        profile.id,
        {
          message: presence !== "idle" && presence !== "done" ? presenceLabel(presence, agent.state.activity) : thread?.title ?? "Start a conversation",
          time: compactTime(thread?.updatedAt),
          status,
          presence,
          completionId: presence === "done" ? agent.state.currentAttemptId ?? undefined : undefined,
        } satisfies AgentSidebarPreview,
      ];
    }),
  );
  const verifiedDisplay =
    runtime.identityStatus.authentication?.verifiedDisplayAttributes;
  const profileName =
    verifiedDisplay?.displayName ?? verifiedDisplay?.email ?? "Local workspace";
  const conversation = durableConversation.state.conversation?.thread.id === selectedThreadId ? durableConversation.state.conversation : null;
  const messages = conversation?.messages ?? [];
  const screenPreviewUrl =
    localComputer.snapshot?.previewDataUrl ??
    hostedBrowser.snapshot?.previewDataUrl;
  const approvalPanel = runtime.openApprovals.length ? (
    <Suspense fallback={null}>
      <ApprovalPanel
        compact
        previews={runtime.approvalPreviews}
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
      className={`desktop-frame desktop-frame--agents${(workPanelOpen || artifactPreview) && !marketplaceTab ? "" : " desktop-frame--live-closed"}${artifactPreview ? " desktop-frame--artifact" : ""}`}
      data-theme={theme}
      data-mobile-view={mobileConversation || marketplaceTab ? "conversation" : "list"}
    >
      <AgentSidebar
        hidden={isPhone && (mobileConversation || marketplaceTab !== null)}
        connectors={runtime.connectorManifests}
        agents={runtime.agents}
        activeAgentId={activeAgent.id}
        previews={previews}
        profileName={profileName}
        marketplaceActive={marketplaceTab !== null}
        onSelectAgent={selectAgent}
        onCreateAgent={createTeammate}
        onEditAgent={editTeammate}
        onOpenMarketplace={() => {
          setMarketplaceConnectorId(undefined);
          setMarketplaceTab("plugins");
          setWorkPanelOpen(false);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenUsage={() => setAccountDialog("usage")}
        onSignOut={() => setAccountDialog("sign-out")}
      />

      {marketplaceTab ? (
        <Suspense fallback={null}>
          <MarketplacePage
            initialConnectorId={marketplaceConnectorId}
            onBack={() => setMarketplaceTab(null)}
            workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}
            manifests={runtime.connectorManifests.filter(
              (connector) => connector.id !== "local-files",
            )}
            accounts={runtime.connectorAccounts}
            connectorStatus={runtime.connectorStatus}
            onUseConnector={(connector) => {
              runtime.useConnector(connector);
              setMarketplaceTab(null);
            }}
            onConnect={runtime.connectConnector}
            onDisconnect={(connectorId) =>
              runtime.disconnectConnector(connectorId)
            }
            onRefresh={(connectorId) =>
              void runtime.refreshConnector(connectorId)
            }
            onSelectConnector={(connector) =>
              void runtime.loadConnectorAccounts(connector.id)
            }
            onSwitchAccount={(connectorId, connectionId) =>
              void runtime.switchConnectorAccount(connectorId, connectionId)
            }
          />
        </Suspense>
      ) : (
      <section className="workspace agent-workspace" hidden={isPhone && !mobileConversation}>
        <AgentWorkspaceHeader
          agent={activeAgent}
          attentionCount={runtime.openApprovals.length}
          presence={activePresence}
          activity={agent.state.activity}
          computerActive={Boolean(localComputer.node?.browserActive || hostedBrowser.opening)}
          onBack={isPhone ? () => { setMobileConversation(false); setWorkPanelOpen(false); window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.agent-row__select[aria-current="page"]')?.focus()); } : undefined}
          panelOpen={workPanelOpen && !artifactPreview}
          onTogglePanel={() => { if (artifactPreview) { setArtifactPreview(null); setWorkPanelOpen(true); } else setWorkPanelOpen((open) => !open); }}
        />

        <div className="workspace-center workspace-center--composer workspace-center--conversation">
          <div
            ref={conversationScroll.scrollRef}
            onScroll={conversationScroll.onScroll}
            className="conversation-scroll"
            aria-label="Conversation"
          >
            {messages.length === 0 &&
            !optimisticUserMessage &&
            !agent.state.running ? (
              <AgentWelcome
                agent={activeAgent}
                onChoose={(prompt) => {
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              />
            ) : null}
            <div className="conversation-feed" ref={conversationScroll.contentRef} onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest("summary")) conversationScroll.pauseFollowing();
            }}>
              <ConversationFeed messages={messages} agent={activeAgent} state={agent.state} presence={activePresence} threadId={selectedThreadId}
                profileName={profileName} connectors={runtime.connectorManifests} optimisticPrompt={optimisticUserMessage}
                onOpenConnector={(id) => { setMarketplaceConnectorId(id); setMarketplaceTab("plugins"); }}
                workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId ?? ""}
                generation={localComputer.node?.generation} approval={approvalPanel}
                onPreviewArtifact={(output) => { artifactTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setArtifactPreview(output); }}
                interruption={<>
                  {submissionError || agent.state.lastError ? <div className="conversation-attention" role="alert">
                    <p>{submissionError || agent.state.lastError}</p>
                    {/sign.in|authenticat|credential|provider.*connect|api.key/i.test(submissionError || agent.state.lastError || "") ? <button type="button" onClick={() => { setSettingsTab("providers"); setSettingsOpen(true); }}>Check provider connection</button> : null}
                  </div> : null}
                  {agent.state.status === "cancelled" && agent.state.progressThreadId === selectedThreadId ? <div className="conversation-attention">
                    <p>Stopped. Your completed work is still here.</p>
                    <button type="button" onClick={() => void executePrompt("Continue from where you stopped. Check the completed work before taking further actions; do not repeat actions that already succeeded.")}>Continue</button>
                  </div> : null}
                  {agent.state.recoverableAttempts.filter((attempt) => attempt.threadId === selectedThreadId).slice(0, 2).map((attempt) => <div className="conversation-attention" key={attempt.id}>
                    <p>This response was interrupted. Your completed work remains in the conversation.</p>
                    <button type="button" disabled={agent.state.running} onClick={async () => {
                      const retryPrompt = attempt.exchanges?.filter((exchange) => exchange.role === "user").at(-1)?.content ?? "";
                      setOptimisticUserMessage(retryPrompt);
                      try {
                        const { tools: connectorTools } = await beginConnectorTurn();
                        resetCancellation();
                        const retryProvider = runtime.backendProviders.find((provider) => provider.id === attempt.providerId);
                        const retryModel = composerModels.find((model) => model.providerId === attempt.providerId && model.modelId === attempt.model);
                        await agent.retry(attempt, conversationToolsForModel(connectorTools, localComputer.node?.lifecycle === "ready", retryProvider, retryModel), runtime.permissionMode,
                          [agentExecutionInstructions(activeAgent), CONVERSATION_STYLE_INSTRUCTIONS, COMPUTER_WORK_INSTRUCTIONS].join("\n\n"));
                      } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not retry this response."); }
                      finally { endConnectorTurn(); await Promise.allSettled([runtime.refreshConnectorStatuses(), durableConversation.refresh()]); setOptimisticUserMessage(""); }
                    }}>Retry response</button>
                    <small>Starts a new attempt from your original request, with fresh permissions.</small>
                  </div>)}
                </>} />
              {durableConversation.state.error ? <p className="conversation-status conversation-status--error" role="alert">{durableConversation.state.error}</p> : null}
            </div>
          </div>

          <div className="conversation-composer-dock">
            {conversationScroll.showLatest ? <button className="conversation-latest" type="button" onClick={conversationScroll.toLatest} aria-label="Scroll to latest message" title="Scroll to latest message"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16m-7-7 7 7 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button> : null}
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

              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
              }}
              onOpenTool={() => {
                setMarketplaceTab("plugins");
                setWorkPanelOpen(false);
                setAddMenuOpen(false);
              }}
              onRunCommand={(command) => runtime.setComposerValue(command)}
              onFileChange={runtime.handleComposerAttachmentChange}
              importStatus={runtime.importStatus}
              models={composerModels}
              selectedModelId={selectedModelOptionId}
              selectedModelLabel={selectedModelLabel}
              selectedReasoningEffort={selectedReasoningEffort}
              onSelectReasoningEffort={(reasoningEffort) => runtime.updateAgent(activeAgent.id, { reasoningEffort })}
              placeholder={`Message ${activeAgent.name}…`}
              onSelectModel={(modelId) => {
                runtime.selectModel(modelId);
                runtime.updateAgent(activeAgent.id, { modelId, reasoningEffort: undefined });
              }}



              inThread={Boolean(selectedThreadId)}
              isWorking={agent.state.running}
              onStop={() => void stopCurrentWork()}
              connectedConnectors={connectedConnectors}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
            />
          </div>
        </div>
      </section>
      )}

      {artifactPreview && !marketplaceTab ? <ArtifactPreview key={`${activeAgent.id}:${selectedThreadId}:${localComputer.node?.generation}:${artifactPreview}`}
        output={artifactPreview} workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId ?? ""}
        agentId={activeAgent.id} generation={localComputer.node?.generation}
        onClose={() => { setArtifactPreview(null); artifactTrigger.current?.focus(); }} /> : null}
      {workPanelOpen && !marketplaceTab && !artifactPreview ? (
        <LiveWorkRail
          conversations={durableConversation.state.threads.filter((thread) =>
            thread.lifecycle === "active" && (activeAgent.threadIds ?? [activeAgent.threadId]).includes(thread.id)
          ).map((thread) => ({ id: thread.id, title: thread.title, time: compactTime(thread.updatedAt) }))}
          activeConversationId={selectedThreadId}
          conversationBusy={agent.state.running || Boolean(queuedPrompt) || deletingConversation}
          onDeleteConversation={async (id) => {
            if (agent.state.running || queuedPrompt || deletingConversation) return;
            setDeletingConversation(true);
            try {
              await durableConversation.deleteThread(id);
              const threadIds = (activeAgent.threadIds ?? [activeAgent.threadId]).filter((threadId): threadId is string => Boolean(threadId) && threadId !== id);
              runtime.updateAgent(activeAgent.id, { threadIds, ...(activeAgent.threadId === id ? { threadId: undefined } : {}) });
              if (selectedThreadId === id) { setSelectedThreadId(undefined); runtime.setComposerValue(""); setOptimisticUserMessage(""); }
              setSubmissionError("");
            } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not delete this conversation."); }
            finally { setDeletingConversation(false); }
          }}
          onNewConversation={startNewConversation}
          onSelectConversation={(id) => {
            if (agent.state.running || queuedPrompt) return;
            runtime.updateAgent(activeAgent.id, { threadId: id });
            setSelectedThreadId(id); runtime.setComposerValue(""); setOptimisticUserMessage(""); setSubmissionError("");
          }}
          agentName={activeAgent.name}
          localComputer={{
            available: localComputer.available,
            status: localComputer.node?.lifecycle,
            browserAvailable: localComputer.node?.browserAvailable ?? false,
            browserActive: localComputer.node?.browserActive ?? false,
            browserProduct: localComputer.node?.browserProduct,
            canGoBack: localComputer.snapshot?.canGoBack ?? false,
            canGoForward: localComputer.snapshot?.canGoForward ?? false,
            filesAvailable: Boolean(
              localComputer.node &&
              localComputer.node.lifecycle !== "unprovisioned" &&
              localComputer.node.capabilities.includes("persistent-files"),
            ),
            files: localComputer.files,
            filesLoading: localComputer.filesLoading,
            filesError: localComputer.filesError,
            filePreview: localComputer.filePreview,
            filePreviewLoading: localComputer.filePreviewLoading,
            filePreviewError: localComputer.filePreviewError,
            controller: localComputer.controller,
            loading: localComputer.loading,
            provisioning: localComputer.provisioning,
            busy: localComputer.browserBusy,
            recoveryNeeded: localComputer.recoveryNeeded,
            error: localComputer.error,
            browserUrl: localComputer.snapshot?.currentUrl,
            browserTitle: localComputer.snapshot?.title,
            generation: localComputer.node?.generation ?? 0,
            leaseExpiresAt: localComputer.node?.leaseExpiresAt,
            viewport: localComputer.snapshot?.viewport,
            onProvision: localComputer.provision,
            onOpenViewer: localComputer.openViewer,
            onStop: localComputer.stop,
            onRestart: localComputer.restart,
            onUpdateSystem: localComputer.updateSystem,
            onOpenBrowser: localComputer.navigate,
            onRefreshBrowser: localComputer.refresh,
            onGoBack: localComputer.goBack,
            onGoForward: localComputer.goForward,
            onRefreshFiles: localComputer.refreshFiles,
            onPreviewFile: localComputer.previewFile,
            onCloseFilePreview: localComputer.closeFilePreview,
            onTakeControl: localComputer.takeControl,
            onReturnControl: localComputer.returnControl,
            onLaunchApplication: localComputer.launchApplication,
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
            onRefreshBrowser: hostedBrowser.refresh,
          }}
          screenPreviewUrl={screenPreviewUrl}
          onClose={() => setWorkPanelOpen(false)}
        />
      ) : null}

      <AgentEditor
        onSkillsChange={(learnedTasks) => { if (editingAgentId) runtime.updateAgent(editingAgentId, { learnedTasks }); }}
        onUseSkill={async (task) => {
          const profile = runtime.agents.find((candidate) => candidate.id === editingAgentId);
          if (profile && !await selectAgent(profile)) return;
          runtime.setComposerValue(task.instruction);
          focusComposer();
        }}
        existingAvatarSeeds={runtime.agents.map((profile) => profile.avatarSeed ?? `blob-v1:${profile.id}`)}
        open={agentEditorOpen}
        agent={
          editingAgentId
            ? (runtime.agents.find(
                (profile) => profile.id === editingAgentId,
              ) ?? null)
            : null
        }
        models={runtime.modelOptions}
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
            setMobileConversation(true);
            setWorkPanelOpen(false);
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

      {accountDialog ? <AccountDialog key={accountDialog} kind={accountDialog} name={profileName}
        records={Object.values(agent.state.usageReceipts)} onClose={() => setAccountDialog(null)}
        onSignOut={async () => { await stopCurrentWork(); await runtime.signOutIdentity(); }} /> : null}

      {settingsOpen ? (
        <SettingsModal activeTab={settingsTab} onSelectTab={setSettingsTab} onClose={() => setSettingsOpen(false)}>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={settingsTab}
                  workspaceName={
                    runtime.accountWorkspaceStatus.activeWorkspace.name ||
                    "Fable workspace"
                  }
                  dictationCapability={voice.capability}
                  titleId="settings-modal-title"
                />
              </Suspense>
        </SettingsModal>
      ) : null}
    </main>
  );

  function focusComposer() {
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  }

  function focusConversationBack() {
    if (isPhone) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".agent-workspace-header__back")?.focus());
  }

  function addDictationToComposer(transcript: string) {
    const composer = runtime.composerRef.current;
    const insertion = insertDictation(
      runtime.composerValue,
      transcript,
      composer?.selectionStart ?? runtime.composerValue.length,
      composer?.selectionEnd ?? runtime.composerValue.length,
    );
    runtime.setComposerValue(insertion.value);
    window.requestAnimationFrame(() => {
      runtime.composerRef.current?.focus();
      runtime.composerRef.current?.setSelectionRange(
        insertion.caret,
        insertion.caret,
      );
    });
  }
}
