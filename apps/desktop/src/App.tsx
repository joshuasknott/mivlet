import { useEffect, useMemo, useRef, useState } from "react";
import { createApprovalGate, createBrowserSpeechProvider } from "@fable/connectors";
import { Moon, Sun } from "@phosphor-icons/react";
import { chatThreads, connectors, profileFixture, projects } from "./data/workspace";
import { utilityItems } from "./lib/constants";
import {
  buildAgentRequest,
  PERMISSION_PROFILES,
  validateModelSelection
} from "./lib/agent-run";
import { createDesktopToolExecutor } from "./lib/desktop-tool-runtime";
import { useShellRuntime } from "./hooks/useShellRuntime";
import { useNativeAgent } from "./hooks/useNativeAgent";
import { useScheduledAgent } from "./hooks/useScheduledAgent";
import { useVoice } from "./hooks/useVoice";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { Composer } from "./components/Composer";
import { ConnectorIcon } from "./components/ConnectorIcon";
import { FableLogo } from "./components/FableLogo";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { CitationResults, DirectiveCards } from "./components/workspace-cards";
import { KnowledgePage } from "./components/pages/KnowledgePage";
import { SchedulesPage } from "./components/pages/SchedulesPage";
import { OnboardingPage } from "./components/pages/OnboardingPage";
import { ConnectorsPage } from "./components/pages/ConnectorsPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import type { SettingsTab } from "./components/pages/SettingsPage";
import { VoiceReview } from "./components/VoiceReview";

/**
 * Root composition for the Fable desktop shell.
 *
 * useShellRuntime owns runtime/data state and effects. This component owns
 * shell-local UI state (collection expansion, the account popover, tool/command
 * picker visibility) and routes between chat views and the standalone
 * Connectors / Knowledge / Schedules pages. The composer renders only on chat
 * views.
 */

export function App() {
  // The shared approval gate: the shell's grant/deny decisions resolve it, and
  // the agent-loop executor awaits it. Created once before the hooks so both
  // useShellRuntime (dispatch on grant/deny) and useNativeAgent (executor awaits
  // it) share the same instance — a grant in the approval UI drives the tool call
  // the loop is currently blocked on.
  const approvalGate = useMemo(() => createApprovalGate(), []);
  const runtime = useShellRuntime({ approvalGate });
  const [profile, setProfile] = useState(profileFixture);
  const workspaceName = `${profile.name.split(" ")[0]}'s Fable`;
  // Re-sync the shell's standing grants into the gate so session/rule grants
  // auto-satisfy matching tool calls without re-prompting.
  useEffect(() => {
    approvalGate.replaceStandingGrants([
      ...runtime.sessionApprovalGrants,
      ...runtime.approvalRules
    ]);
  }, [approvalGate, runtime.sessionApprovalGrants, runtime.approvalRules]);
  // The real executor: awaits the gate, then runs the granted tool through the
  // Rust boundary (which re-validates the approval and performs the side effect).
  const executor = useMemo(
    () => createDesktopToolExecutor(approvalGate),
    [approvalGate]
  );
  // Cooperative cancellation: a cancel flag the agent hook's shouldCancel reads.
  // The cancel() path flips it true so an in-flight loop bails between events;
  // the real-Rust cancel (cancelRuntimeCompletion) still drops the socket. This
  // is the cooperative layer on top of the Rust boundary drop.
  const cancelRequestedRef = useRef(false);
  const agent = useNativeAgent({
    providers: runtime.backendProviders,
    models: runtime.selectableModels,
    threadId: runtime.activeThread?.id ?? runtime.activeItem,
    execute: executor,
    shouldCancel: () => cancelRequestedRef.current,
    onCancel: () => {
      // Flip the cancel flag the agent hook's shouldCancel reads, so an in-flight
      // loop bails cooperatively between events — not only via the Rust boundary
      // drop. It is reset to false at the start of each agent.run.
      cancelRequestedRef.current = true;
      // Tear down any tool-call still awaiting approval on the shared gate so a
      // cancelled-but-never-granted call does not linger for the session.
      approvalGate.cancelPending();
    },
    onToolCall: (event) => {
      // Route model tool calls into Fable's existing approval queue + register
      // the pending call on the shared gate so a later grant can dispatch it.
      approvalGate.register(event.approval);
      void runtime.recordBackendToolCall(event);
    }
  });
  const voiceProvider = useMemo(() => createBrowserSpeechProvider(), []);
  const voice = useVoice(voiceProvider, (transcript) => runPrompt(transcript));

  // Scheduled prompts run through a dedicated headless runner that drives the
  // same AgentBackend contract as the composer — but in complete isolation: it
  // owns its own backend resolution, cancellation, and lease renewal, and never
  // touches the active thread or interactive agent state.
  const scheduledAgent = useScheduledAgent(runtime.pendingWorkflowRuns, {
    providers: runtime.backendProviders,
    execute: executor,
    onComplete: (runId, result) => {
      runtime.completeWorkflowRun(
        runId,
        result.ok,
        result.ok ? result.transcript : result.error
      );
    }
  });
  // Reference the active run so React keeps the hook's effect wired and the
  // shell can surface "running" state without redesigning the schedules UI.
  const scheduledActive = scheduledAgent.active;
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    fable: true,
    site: false
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const storedTheme = window.localStorage.getItem("fable-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }

    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [previousActiveItem, setPreviousActiveItem] = useState("new-chat");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("providers");

  useEffect(() => {
    if (runtime.activeItem !== "Settings" && runtime.activeItem !== "Profile") {
      setPreviousActiveItem(runtime.activeItem);
    }
  }, [runtime.activeItem]);

  useEffect(() => {
    if (runtime.activeItem === "Profile") {
      setActiveSettingsTab("profile");
    } else if (runtime.activeItem === "Settings") {
      if (activeSettingsTab === "profile") {
        setActiveSettingsTab("providers");
      }
    }
  }, [runtime.activeItem]);

  // Connected connectors shown on the home rail. Real provider marks only;
  // local-files is always available so it is not surfaced as a connector. If
  // nothing is connected, the rail renders nothing.
  const connectedConnectorCards = runtime.connectorManifests.filter(
    (connector) => connector.status === "connected" && connector.id !== "local-files"
  );

  const renderPage = () => {
    switch (runtime.activePage) {
      case "Connectors":
        return <ConnectorsPage runtime={runtime} />;
      case "Knowledge":
        return <KnowledgePage runtime={runtime} />;
      case "Schedules":
        return <SchedulesPage runtime={runtime} />;
      case "Profile":
      case "Settings":
        return (
          <SettingsPage
            runtime={runtime}
            profile={profile}
            onProfileChange={setProfile}
            theme={theme}
            onThemeChange={setTheme}
            activeTab={activeSettingsTab}
            workspaceName={workspaceName}
          />
        );
      default:
        return null;
    }
  };

  const renderChatContext = () => {
    const visibleAgentError = agent.state.noTransport ? null : agent.state.lastError;
    const activeThreadId = runtime.activeThread?.id ?? runtime.activeItem;
    const visibleRecoverableRuns = agent.state.recoverableRuns.filter(
      (run) => !run.threadId || run.threadId === activeThreadId
    );

    return (
      <>
        {connectedConnectorCards.length > 0 ? (
          <div className="connector-rail" aria-label="Connected connectors">
            {connectedConnectorCards.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className={`connector-pill connector-pill--${connector.id}`}
                onClick={() => {
                  const prompt = `Use ${connector.name} to `;
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              >
                <ConnectorIcon id={connector.id} />
                <span>{connector.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {runtime.openApprovals.length > 0 ||
        runtime.editingApprovalId ||
        runtime.pendingApprovalConfirmation ? (
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
        ) : null}
        {runtime.knowledgeCitations.length > 0 ? (
          <CitationResults citations={runtime.knowledgeCitations} mode={runtime.knowledgeSearchMode} />
        ) : null}
        {runtime.importStatus ? (
          <DirectiveCards
            directives={runtime.contextualDirectives}
            connectors={connectors}
            onUseDirective={runtime.useDirective}
          />
        ) : null}
        {agent.state.transcript ||
        agent.state.usage ||
        visibleAgentError ||
        agent.state.running ||
        visibleRecoverableRuns.length > 0 ? (
          <section className="agent-panel" aria-label="Agent activity">
            {visibleRecoverableRuns.map((run) => (
              <div className="agent-panel__recovery" key={run.id}>
                <p>
                  {run.status === "interrupted" ? "Interrupted" : "Failed"} run · {run.model}
                  {run.transcript ? ` · ${run.transcript.slice(0, 120)}` : ""}
                </p>
                <button type="button" onClick={() => void agent.retry(run)}>
                  Retry from prompt
                </button>
              </div>
            ))}
            {agent.state.transcript ? (
              <p className="agent-panel__transcript">{agent.state.transcript}</p>
            ) : null}
            {agent.state.usage ? (
              <p className="agent-panel__usage">
                {agent.state.usage.inputTokens} in · {agent.state.usage.outputTokens} out · $
                {agent.state.usage.costUsd.toFixed(6)}
                {agent.state.usage.costEstimated ? " estimated" : ""}
              </p>
            ) : null}
            {agent.state.running ? (
              <p className="agent-panel__running">
                {agent.state.status === "awaiting-approval"
                  ? "Waiting for approval…"
                  : agent.state.status === "retrying"
                    ? "Retrying provider…"
                    : "Running…"}
                <button
                  type="button"
                  className="agent-panel__stop"
                  onClick={() => {
                    void agent.cancel();
                  }}
                >
                  Stop
                </button>
              </p>
            ) : null}
            {visibleAgentError ? (
              <p className="agent-panel__error">{visibleAgentError}</p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;
  // Label for the model chip: the selected model's friendly label, or a
  // placeholder when no model is selected/available on the connected backend.
  const modelChipLabel =
    runtime.selectableModels.find((model) => model.id === runtime.resolvedSelectedModelId)?.label ??
    "Select model";

  function runPrompt(rawPrompt: string) {
    const prompt = rawPrompt.trim();
    if (!prompt) return;
    const nativeConnected = runtime.connectedAgentBackend;
    if (!nativeConnected) {
      runtime.submitPrompt(prompt);
      return;
    }
    const validation = validateModelSelection(
      nativeConnected.id,
      runtime.resolvedSelectedModelId,
      runtime.selectableModels,
      2048
    );
    if (!validation.ok) {
      agent.reportError(validation.error ?? "The selected model cannot run.");
      return;
    }
    const request = buildAgentRequest({
      model: runtime.resolvedSelectedModelId,
      prompt,
      maxTokens: validation.maxTokens
    });
    cancelRequestedRef.current = false;
    void runtime.assembleKnowledgeContext(prompt).then((contextPrefix) =>
      agent.run(request, contextPrefix || undefined, runtime.permissionLabel)
    );
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        runtime.setLastAction("Search ready");
        runtime.focusComposer("Search ");
      }

      if (key === "n") {
        event.preventDefault();
        runtime.startNewChat();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [runtime]);

  // Onboarding gate: until one AI backend is connected (or the user skips in
  // preview), render the three-path onboarding shell instead of the workspace.
  if (runtime.onboardingRequired) {
    return (
      <OnboardingPage
        providers={runtime.backendProviders}
        connectedBackendIds={runtime.connectedBackendIds}
        status={runtime.backendStatus}
        onConnect={(providerId, secret) => void runtime.connectBackend(providerId, secret)}
        onSkip={runtime.dismissOnboarding}
        onSubmitProfile={(name, email) => {
          setProfile((current) => ({
            ...current,
            // Local profile only: apply name/email when provided. No auth and no
            // account is created — these are local display fields.
            ...(name ? { name } : {}),
            ...(email ? { email } : {}),
            photoInitials: (name || current.name)
              .split(" ")
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)
          }));
        }}
        onOpenConnectors={() => runtime.setActiveItem("Connectors")}
      />
    );
  }

  const isSettingsActive = runtime.activePage === "Settings" || runtime.activePage === "Profile";

  const handleSelectSettingsTab = (tab: SettingsTab) => {
    setActiveSettingsTab(tab);
    if (tab === "profile") {
      runtime.setActiveItem("Profile");
    } else {
      runtime.setActiveItem("Settings");
    }
  };

  return (
    <main
      className={`desktop-frame${sidebarCollapsed ? " desktop-frame--sidebar-collapsed" : ""}`}
      data-theme={theme}
    >
      <WorkspaceSidebar
        workspaceName={workspaceName}
        utilityItems={utilityItems}
        activeItem={runtime.activeItem}
        profile={profile}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={projects}
        chatThreads={chatThreads}
        mobileNavOpen={runtime.mobileNavOpen}
        collapsed={sidebarCollapsed}
        loadingItemIds={agent.state.running && runtime.activeItem ? [runtime.activeItem] : []}
        isSettingsActive={isSettingsActive}
        activeSettingsTab={activeSettingsTab}
        onSelectSettingsTab={handleSelectSettingsTab}
        onCloseSettings={() => runtime.setActiveItem(previousActiveItem)}
        onNewChat={runtime.startNewChat}
        onAddProject={() => {
          runtime.setActiveItem("new-project");
          runtime.setLastAction("New project ready");
          runtime.focusComposer("Create a project for ");
        }}
        onSearch={() => {
          runtime.setLastAction("Search ready");
          runtime.focusComposer("Search ");
        }}
        onSelectWorkspace={() => runtime.setLastAction("Workspace selector ready")}
        onToggleProjects={() =>
          setExpandedCollections((current) => ({ ...current, projects: !current.projects }))
        }
        onToggleChats={() =>
          setExpandedCollections((current) => ({ ...current, chats: !current.chats }))
        }
        onSelectUtility={(label) => {
          runtime.setActiveItem(label);
          runtime.setLastAction(`${label} selected`);
        }}
        onSelectProjectThread={(thread, projectTitle) => runtime.openThread(thread, projectTitle)}
        onToggleProject={(projectId, projectTitle, expanded) => {
          setExpandedProjects((current) => ({ ...current, [projectId]: !expanded }));
          runtime.setLastAction(`${expanded ? "Collapsed" : "Expanded"} project: ${projectTitle}`);
        }}
        onToggleMobileNav={() => runtime.setMobileNavOpen((open) => !open)}
        onToggleCollapsed={() => {
          setSidebarCollapsed((collapsed) => !collapsed);
          runtime.setLastAction(sidebarCollapsed ? "Navigation opened" : "Navigation closed");
        }}
        onOpenMobileConnection={() => {
          runtime.setLastAction("Mobile connection selected");
        }}
        onSelectThread={(thread) => runtime.openThread(thread, "chat")}
        onAccountMenu={(item) => {
          if (item === "logout") {
            runtime.setLastAction("Log out selected");
            return;
          }

          const page = item === "profile" ? "Profile" : "Settings";
          runtime.setActiveItem(page);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction(`${page} selected`);
        }}
      />

      <section className="workspace" aria-label="Fable workspace">
        {runtime.activePage ? (
          <div className="workspace-center workspace-center--page">{renderPage()}</div>
        ) : (
          <div className="workspace-center">
            <section className="hero" aria-labelledby="hero-title">
              <FableLogo size="hero" />
              <h1 id="hero-title">What are we building today in {workspaceName}?</h1>
            </section>

            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                // When a native-API backend is connected, the composer drives the
                // Fable-owned agent loop; otherwise fall back to the workspace
                // knowledge-search submit.
                const nativeConnected = runtime.connectedAgentBackend;
                if (nativeConnected) {
                  event.preventDefault();
                  const prompt = runtime.composerValue.trim();
                  if (!prompt) return;
                  // Build the pinned-memory/knowledge system prefix (empty when
                  // nothing is pinned or memory is disabled) and the request from
                  // the picker-selected model — both drive the real agent run.
                  // Validate the model selection before opening a socket: an
                  // unknown, unavailable, or non-streaming model is caught here
                  // and surfaced through the same error channel as run failures.
                  const validation = validateModelSelection(
                    nativeConnected.id,
                    runtime.resolvedSelectedModelId,
                    runtime.selectableModels,
                    2048
                  );
                  if (!validation.ok) {
                    agent.reportError(validation.error ?? "The selected model cannot run.");
                    return;
                  }
                  const request = buildAgentRequest({
                    model: runtime.resolvedSelectedModelId,
                    prompt,
                    maxTokens: validation.maxTokens
                  });
                  // Reset the cooperative-cancel flag so a new run is not born
                  // already cancelled, then drive the Fable-owned agent loop.
                  cancelRequestedRef.current = false;
                  void runtime.assembleKnowledgeContext(prompt).then((contextPrefix) =>
                    agent.run(
                      request,
                      contextPrefix || undefined,
                      runtime.permissionLabel
                    )
                  );
                  return;
                }
                runtime.submitComposer(event);
              }}
              voiceEnabled={voice.state.status === "recording"}
              onToggleVoice={() => {
                if (voice.state.status === "recording") void voice.stop();
                else if (voice.state.status !== "processing") void voice.start();
              }}
              onAttach={runtime.triggerAttach}
              addMenuOpen={addMenuOpen}
              permissionsOpen={toolPickerOpen}
              onTogglePermissions={() => {
                setToolPickerOpen((open) => !open);
                setAddMenuOpen(false);
                runtime.setLastAction("Tool picker toggled");
              }}
              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
                setToolPickerOpen(false);
                runtime.setLastAction("Add menu toggled");
              }}
              onOpenTool={(tool) => {
                setAddMenuOpen(false);
                runtime.setActiveItem(tool);
                runtime.setLastAction(`${tool} selected`);
              }}
              onRunCommand={runtime.runCommand}
              onFileChange={runtime.handleLocalKnowledgeFileChange}
              voiceState={
                voice.state.status === "recording"
                  ? "Recording only after your explicit click."
                  : voice.state.status === "processing"
                    ? "Processing speech…"
                    : undefined
              }
              importStatus={runtime.importStatus}
              models={runtime.selectableModels}
              selectedModelId={runtime.resolvedSelectedModelId}
              selectedModelLabel={modelChipLabel}
              onSelectModel={runtime.selectModel}
              permissionLabel={runtime.permissionLabel}
              permissionProfiles={PERMISSION_PROFILES}
              onSelectPermissionLabel={runtime.selectPermissionLabel}
              inThread={!!runtime.activeThread}
              connectedConnectors={connectedConnectorCards}
              knowledgeSources={runtime.workspaceKnowledgeSources}
              schedules={runtime.schedules}
            />
            <VoiceReview voice={voice} />

            {renderChatContext()}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending. {scheduledActive ? `Running scheduled prompt ${scheduledActive.jobId}.` : ""}
        </p>
      </section>
    </main>
  );
}
