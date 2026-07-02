import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createApprovalGate, createBrowserSpeechProvider, parseComposerText } from "@fable/connectors";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { chatThreads, connectors, profileFixture, projects } from "./data/workspace";
import { utilityItems } from "./lib/constants";
import {
  buildAgentRequest,
  PERMISSION_PROFILES,
  validateModelSelection
} from "./lib/agent-run";
import { createDesktopToolExecutor } from "./lib/desktop-tool-runtime";
import { insertDictation } from "./lib/insert-dictation";
import { useShellRuntime } from "./hooks/useShellRuntime";
import { useNativeAgent } from "./hooks/useNativeAgent";
import { useScheduledAgent } from "./hooks/useScheduledAgent";
import { useVoice } from "./hooks/useVoice";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { Composer } from "./components/Composer";
import { ConnectorIcon } from "./components/ConnectorIcon";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { CitationResults, DirectiveCards } from "./components/workspace-cards";
import { tabs as settingsTabs } from "./components/pages/settings-tabs";
import type { SettingsTab } from "./components/pages/settings-tabs";

// Standalone pages are code-split: each is only rendered when navigated to, so
// loading them lazily keeps the initial workspace bundle small. Named exports
// are adapted to the lazy() default-export contract via `.then`. Suspense
// fallbacks are minimal (no layout shift) — the heaviest of these (Settings)
// pulls in Run History, Schedule panel, and provider rendering on demand.
const KnowledgePage = lazy(() =>
  import("./components/pages/KnowledgePage").then((m) => ({ default: m.KnowledgePage }))
);
const SchedulesPage = lazy(() =>
  import("./components/pages/SchedulesPage").then((m) => ({ default: m.SchedulesPage }))
);
const OnboardingPage = lazy(() =>
  import("./components/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage }))
);
const ConnectorsPage = lazy(() =>
  import("./components/pages/ConnectorsPage").then((m) => ({ default: m.ConnectorsPage }))
);
const DepartmentsPage = lazy(() =>
  import("./components/pages/DepartmentsPage").then((m) => ({ default: m.DepartmentsPage }))
);
const SettingsPage = lazy(() =>
  import("./components/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkspaceSettingsView = lazy(() =>
  import("./components/pages/SettingsPage").then((m) => ({ default: m.WorkspaceSettingsView }))
);

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

  const voice = useVoice(voiceProvider, addDictationToComposer, {
    disabled: !runtime.voiceEnabled,
    onCancel: focusComposerAfterVoice
  });

  useEffect(() => {
    // Do not leave a hidden recording alive when the composer is no longer visible.
    if (!runtime.isChatView) voice.reset();
  }, [runtime.isChatView, voice.reset]);

  // Connected connector ids the scheduled runner is allowed to read from.
  // Memoized so the options object passed to useScheduledAgent keeps a stable
  // array reference unless the connector manifests actually change (otherwise
  // every render produced a fresh array and churned the runner's effect deps).
  const connectedConnectorIds = useMemo(
    () =>
      runtime.connectorManifests
        .filter((connector) => connector.status === "connected")
        .map((connector) => connector.id),
    [runtime.connectorManifests]
  );

  // Scheduled prompts run through a dedicated headless runner that drives the
  // same AgentBackend contract as the composer — but in complete isolation: it
  // owns its own backend resolution, cancellation, and lease renewal, and never
  // touches the active thread or interactive agent state.
  const scheduledAgent = useScheduledAgent(runtime.pendingWorkflowRuns, {
    providers: runtime.backendProviders,
    connectedConnectorIds,
    execute: executor,
    onComplete: (runId, result, workflowRun) => {
      runtime.completeWorkflowRun(
        runId,
        result.ok,
        result.ok ? result.transcript : result.error,
        workflowRun
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

    return "light";
  });

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [previousActiveItem, setPreviousActiveItem] = useState("new-chat");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("general");
  const [settingsModalSearch, setSettingsModalSearch] = useState("");
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceSettingsStatus, setWorkspaceSettingsStatus] = useState("");
  const navigationHistory = useRef([runtime.activeItem]);
  const navigationTarget = useRef<string | null>(null);
  const [navigationIndex, setNavigationIndex] = useState(0);

  useEffect(() => {
    if (navigationTarget.current === runtime.activeItem) {
      navigationTarget.current = null;
    } else if (navigationHistory.current[navigationIndex] !== runtime.activeItem) {
      const nextHistory = navigationHistory.current.slice(0, navigationIndex + 1);
      nextHistory.push(runtime.activeItem);
      navigationHistory.current = nextHistory;
      setNavigationIndex(nextHistory.length - 1);
    }

    if (runtime.activeItem !== "Settings" && runtime.activeItem !== "Profile") {
      setPreviousActiveItem(runtime.activeItem);
    }
  }, [navigationIndex, runtime.activeItem]);

  useEffect(() => {
    if (runtime.activeItem === "Profile") {
      setActiveSettingsTab("general");
    }
    if (runtime.runHistoryJobId && runtime.activeItem === "Settings") {
      setActiveSettingsTab("history");
    }
  }, [runtime.activeItem, runtime.runHistoryJobId]);

  // Connected connectors shown on the home rail. Real provider marks only;
  // local-files is always available so it is not surfaced as a connector. If
  // nothing is connected, the rail renders nothing. Memoized so the rail and
  // the composer prop keep a stable reference across unrelated re-renders.
  const connectedConnectorCards = useMemo(
    () =>
      runtime.connectorManifests.filter(
        (connector) => connector.status === "connected" && connector.id !== "local-files"
      ),
    [runtime.connectorManifests]
  );

  // Recoverable runs scoped to the active thread. Hoisted + memoized so the
  // agent panel does not re-filter the full recoverable list on every render
  // (agent text deltas re-render App frequently).
  const activeThreadId = runtime.activeThread?.id ?? runtime.activeItem;
  const visibleRecoverableRuns = useMemo(
    () =>
      agent.state.recoverableRuns.filter(
        (run) => !run.threadId || run.threadId === activeThreadId
      ),
    [agent.state.recoverableRuns, activeThreadId]
  );

  // The sidebar highlights the active item's spinner while an agent run is in
  // flight. Memoized so the prop keeps a stable array reference (the previous
  // inline ternary allocated a fresh array every render).
  const loadingItemIds = useMemo(
    () => (agent.state.running && runtime.activeItem ? [runtime.activeItem] : []),
    [agent.state.running, runtime.activeItem]
  );

  const renderPage = () => {
    switch (runtime.activePage) {
      case "Departments":
        return <DepartmentsPage />;
      case "Connectors":
        return <ConnectorsPage runtime={runtime} />;
      case "Knowledge":
        return <KnowledgePage runtime={runtime} />;
      case "Schedules":
        return <SchedulesPage runtime={runtime} />;
      case "Profile":
      case "Settings":
        return null;
      default:
        return null;
    }
  };

  const renderChatContext = () => {
    const visibleAgentError = agent.state.noTransport ? null : agent.state.lastError;

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
        runtime.pendingApprovalConfirmation ||
        runtime.sessionApprovalGrants.length > 0 ||
        runtime.approvalRules.length > 0 ? (
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
  // Memoized so the composer's chip prop keeps a stable primitive unless the
  // model selection actually changes.
  const modelChipLabel = useMemo(
    () =>
      runtime.selectableModels.find((model) => model.id === runtime.resolvedSelectedModelId)?.label ??
      "Select model",
    [runtime.selectableModels, runtime.resolvedSelectedModelId]
  );

  // Settings nav search filter. Memoized (and kept above the onboarding early
  // return so the Rules of Hooks hold) so typing in the settings search box
  // does not refilter the static tab list on every unrelated render.
  const visibleSettingsTabs = useMemo(() => {
    const query = settingsModalSearch.trim().toLocaleLowerCase();
    if (!query) return settingsTabs;
    return settingsTabs.filter((tab) => tab.label.toLocaleLowerCase().includes(query));
  }, [settingsModalSearch]);

  /**
   * Submit raw composer text. Fable-owned slash commands (/goal, /plan,
   * /remember, /schedule) are parsed and executed first — they create
   * structured Fable state and, when a backend is connected, submit follow-up
   * model work through the agent run. Unknown slashes and ordinary text fall
   * through to the normal prompt path unchanged.
   */
  async function submitComposerText(rawText: string) {
    const outcome = parseComposerText(rawText);
    if (outcome.status === "command") {
      const result = await runtime.runFableCommand(outcome.request);
      // Clear the composer so the command token doesn't also reach the model
      // as ordinary prompt text. A follow-up prompt (if any) is submitted
      // through the same agent path as a normal prompt.
      runtime.setComposerValue("");
      if (result.status === "ok" && result.followUpPrompt) {
        runPrompt(result.followUpPrompt);
      }
      return;
    }
    runPrompt(rawText);
  }

  function focusComposerAfterVoice() {
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
      const currentComposer = runtime.composerRef.current;
      currentComposer?.focus();
      currentComposer?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }

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
      agent.run(request, contextPrefix || undefined, runtime.permissionMode)
    );
  }

  // Subscribe the global shortcut listener once. The runtime object is not
  // referentially stable (it is rebuilt each render), so depending on it here
  // would tear down and re-add the keydown listener on every render. A ref
  // always points at the latest runtime, keeping the handlers current without
  // resubscribing.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      const current = runtimeRef.current;
      if (key === "k") {
        event.preventDefault();
        current.setLastAction("Search ready");
        current.focusComposer("Search ");
      }

      if (key === "n") {
        event.preventDefault();
        current.startNewChat();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  // Onboarding gate: until one AI backend is connected (or the user skips in
  // preview), render the three-path onboarding shell instead of the workspace.
  if (runtime.onboardingRequired) {
    return (
      <Suspense fallback={<div className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          onConnect={(providerId, secret) => void runtime.connectBackend(providerId, secret)}
          onConnectWithVerify={(providerId, secret) =>
            runtime.connectBackendWithVerify(providerId, secret)
          }
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
      </Suspense>
    );
  }

  const isSettingsActive = runtime.activePage === "Settings" || runtime.activePage === "Profile";

  const handleSelectSettingsTab = (tab: SettingsTab) => {
    setActiveSettingsTab(tab);
    runtime.setActiveItem("Settings");
  };

  const closeSettingsModal = () => {
    if (navigationIndex > 0) {
      navigateHistory(-1);
    } else {
      runtime.setActiveItem(previousActiveItem);
    }
  };

  const navigateHistory = (offset: -1 | 1) => {
    const nextIndex = navigationIndex + offset;
    const target = navigationHistory.current[nextIndex];
    if (!target || nextIndex < 0 || nextIndex >= navigationHistory.current.length) {
      return;
    }
    navigationTarget.current = target;
    setNavigationIndex(nextIndex);
    runtime.setActiveItem(target);
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
        loadingItemIds={loadingItemIds}
        isSettingsActive={false}
        activeSettingsTab={activeSettingsTab}
        onSelectSettingsTab={handleSelectSettingsTab}
        canNavigateBack={navigationIndex > 0}
        canNavigateForward={navigationIndex < navigationHistory.current.length - 1}
        onNavigateBack={() => navigateHistory(-1)}
        onNavigateForward={() => navigateHistory(1)}
        onCloseSettings={closeSettingsModal}
        onNewChat={runtime.startNewChat}
        onAddProject={() => {
          runtime.setActiveItem("new-thread");
          runtime.setLastAction("New thread ready");
          runtime.focusComposer("Create a thread for ");
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
          setActiveSettingsTab("privacy");
          runtime.setActiveItem("Settings");
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Mobile approvals opened");
        }}
        onOpenWorkspaceSettings={() => {
          setWorkspaceSettingsStatus("");
          setWorkspaceSettingsOpen(true);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Workspace settings opened");
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
        {runtime.activePage && !isSettingsActive ? (
          <div className="workspace-center workspace-center--page">
            <Suspense fallback={null}>{renderPage()}</Suspense>
          </div>
        ) : (
          <div className="workspace-center workspace-center--composer">
            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                const text = runtime.composerValue;
                if (!text.trim()) return;
                void submitComposerText(text);
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
            />

            {renderChatContext()}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending. {scheduledActive ? `Running scheduled prompt ${scheduledActive.jobId}.` : ""}
        </p>
      </section>

      {isSettingsActive ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
            <aside className="settings-modal__nav" aria-label="Settings sections">
              <label className="settings-modal__search">
                <MagnifyingGlass size={15} aria-hidden="true" />
                <span className="sr-only">Search settings</span>
                <input
                  type="search"
                  placeholder="Search settings"
                  value={settingsModalSearch}
                  onChange={(event) => setSettingsModalSearch(event.target.value)}
                />
              </label>
              <nav className="settings-modal__tab-list" aria-label="Settings">
                {visibleSettingsTabs.map((tab) => {
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={activeSettingsTab === tab.id ? "settings-modal__tab settings-modal__tab--active" : "settings-modal__tab"}
                      aria-current={activeSettingsTab === tab.id ? "page" : undefined}
                      onClick={() => handleSelectSettingsTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </aside>
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close settings"
                onClick={closeSettingsModal}
              >
                <X size={17} />
              </button>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  profile={profile}
                  onProfileChange={setProfile}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={activeSettingsTab}
                  workspaceName={workspaceName}
                  dictationCapability={voice.capability}
                  titleId="settings-modal-title"
                />
              </Suspense>
            </div>
          </section>
        </div>
      ) : null}

      {workspaceSettingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section
            className="settings-modal settings-modal--workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-settings-modal-title"
          >
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close workspace settings"
                onClick={() => {
                  setWorkspaceSettingsOpen(false);
                  setWorkspaceSettingsStatus("");
                }}
              >
                <X size={17} />
              </button>
              <section className="settings-page" aria-labelledby="workspace-settings-modal-title">
                <div className="settings-page__content">
                  <div className="settings-page__header">
                    <h1 id="workspace-settings-modal-title">{workspaceName}</h1>
                  </div>
                  <Suspense fallback={null}>
                    <WorkspaceSettingsView
                      workspaceName={workspaceName}
                      onStatus={(message) => {
                        setWorkspaceSettingsStatus(message);
                        runtime.setLastAction(message);
                      }}
                    />
                  </Suspense>
                  {workspaceSettingsStatus ? (
                    <p className="settings-status" role="status">
                      {workspaceSettingsStatus}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
