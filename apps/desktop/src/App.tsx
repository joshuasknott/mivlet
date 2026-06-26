import { useEffect, useState } from "react";
import {
  CalendarBlank,
  ChatCircle,
  Checks,
  EnvelopeSimple,
  FileText,
  HardDrive,
  PresentationChart,
  Sparkle,
  Table
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { chatThreads, connectors, projects } from "./data/workspace";
import { utilityItems } from "./lib/constants";
import { useShellRuntime } from "./hooks/useShellRuntime";
import { useNativeAgent } from "./hooks/useNativeAgent";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { Composer } from "./components/Composer";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { CitationResults, DirectiveCards } from "./components/workspace-cards";
import { KnowledgePage } from "./components/pages/KnowledgePage";
import { AutomationsPage } from "./components/pages/AutomationsPage";
import { OnboardingPage } from "./components/pages/OnboardingPage";
import { PluginsPage } from "./components/pages/PluginsPage";
import { ProfilePage } from "./components/pages/ProfilePage";
import { SettingsPage } from "./components/pages/SettingsPage";

const googleConnectorCards: Array<{ label: string; icon: Icon; tone: string }> = [
  { label: "Google Docs", icon: FileText, tone: "docs" },
  { label: "Google Sheets", icon: Table, tone: "sheets" },
  { label: "Google Slides", icon: PresentationChart, tone: "slides" },
  { label: "Google Drive", icon: HardDrive, tone: "drive" },
  { label: "Gmail", icon: EnvelopeSimple, tone: "gmail" },
  { label: "Google Calendar", icon: CalendarBlank, tone: "calendar" },
  { label: "Google Chat", icon: ChatCircle, tone: "chat" },
  { label: "Google Tasks", icon: Checks, tone: "tasks" }
];

/**
 * Root composition for the Arden desktop shell.
 *
 * useShellRuntime owns runtime/data state and effects. This component owns
 * shell-local UI state (collection expansion, the account popover, tool/command
 * picker visibility) and routes between chat views and the standalone
 * Connectors / Knowledge / Schedules pages. The composer renders only on chat
 * views.
 */

export function App() {
  const runtime = useShellRuntime();
  const workspaceName = "Josh's Arden";
  const agent = useNativeAgent({
    providers: runtime.backendProviders,
    onToolCall: (event) => {
      // Route model tool calls into Arden's existing approval queue. The shell's
      // approval UI handles the grant/rule/deny decision; nothing auto-executes.
      void runtime.recordBackendToolCall(event);
    }
  });
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    arden: true,
    site: false
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const renderPage = () => {
    switch (runtime.activePage) {
      case "Connectors":
        return <PluginsPage runtime={runtime} />;
      case "Knowledge":
        return <KnowledgePage />;
      case "Schedules":
        return <AutomationsPage runtime={runtime} />;
      case "Profile":
        return <ProfilePage />;
      case "Settings":
        return <SettingsPage />;
      default:
        return null;
    }
  };

  const renderChatContext = () => {
    if (runtime.activeItem === "arden-memory") {
      return (
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
      );
    }

    return (
      <>
        <div className="connector-rail" aria-label="Available Google connectors">
          {googleConnectorCards.map((connector) => {
            const ConnectorIcon = connector.icon;
            return (
              <button
              key={connector.label}
              type="button"
              className={`connector-pill connector-pill--${connector.tone}`}
              onClick={() => {
                const prompt = `Use ${connector.label} to `;
                runtime.setComposerValue(prompt);
                runtime.focusComposer(prompt);
              }}
            >
                <ConnectorIcon size={15} weight="fill" />
                <span>{connector.label}</span>
              </button>
            );
          })}
        </div>
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
        agent.state.lastError ||
        agent.state.running ||
        agent.state.noTransport ? (
          <section className="agent-panel" aria-label="Agent activity">
            {agent.state.transcript ? (
              <p className="agent-panel__transcript">{agent.state.transcript}</p>
            ) : null}
            {agent.state.usage ? (
              <p className="agent-panel__usage">
                {agent.state.usage.inputTokens} in · {agent.state.usage.outputTokens} out · $
                {agent.state.usage.costUsd.toFixed(6)}
              </p>
            ) : null}
            {agent.state.running ? <p className="agent-panel__running">Running…</p> : null}
            {agent.state.lastError ? (
              <p className="agent-panel__error">{agent.state.lastError}</p>
            ) : null}
            {agent.state.noTransport && !agent.state.transcript ? (
              <p className="agent-panel__notice">
                Native agent needs a connected desktop backend to run.
              </p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;

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
      />
    );
  }

  return (
    <main
      className={`desktop-frame${sidebarCollapsed ? " desktop-frame--sidebar-collapsed" : ""}`}
    >
      <WorkspaceSidebar
        workspaceName={workspaceName}
        utilityItems={utilityItems}
        activeItem={runtime.activeItem}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={projects}
        chatThreads={chatThreads}
        mobileNavOpen={runtime.mobileNavOpen}
        accountOpen={accountOpen}
        collapsed={sidebarCollapsed}
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
          setAccountOpen(false);
          runtime.setLastAction(sidebarCollapsed ? "Navigation opened" : "Navigation closed");
        }}
        onOpenMobileConnection={() => {
          setAccountOpen(false);
          runtime.setLastAction("Mobile connection selected");
        }}
        onSelectThread={(thread) => runtime.openThread(thread, "chat")}
        onToggleAccount={() => {
          setAccountOpen((open) => !open);
          runtime.setLastAction("Profile and settings opened");
        }}
        onAccountMenu={(item) => {
          setAccountOpen(false);
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

      <section className="workspace" aria-label="Arden workspace">
        {runtime.activePage ? (
          <div className="workspace-center workspace-center--page">{renderPage()}</div>
        ) : (
          <div className="workspace-center">
            <section className="hero" aria-labelledby="hero-title">
              <div className="greeting">
                <Sparkle size={25} weight="regular" />
                <span>Good evening, Josh</span>
              </div>
              <h1 id="hero-title">What are we building today in {workspaceName}?</h1>
            </section>

            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                // When a native-API backend is connected, the composer drives the
                // Arden-owned agent loop; otherwise fall back to the workspace
                // knowledge-search submit.
                const nativeConnected = runtime.backendProviders.find(
                  (provider) =>
                    provider.backendType === "native-api" &&
                    provider.authState === "connected" &&
                    provider.capabilities.includes("streaming")
                );
                if (nativeConnected) {
                  event.preventDefault();
                  const prompt = runtime.composerValue.trim();
                  if (!prompt) return;
                  void agent.run({
                    providerId: nativeConnected.id,
                    model: nativeConnected.models.find((model) => model.available)?.id ??
                      nativeConnected.models[0]?.id ??
                      "",
                    messages: [{ role: "user", content: prompt }],
                    tools: [],
                    maxTokens: 2048
                  });
                  return;
                }
                runtime.submitComposer(event);
              }}
              voiceEnabled={runtime.voiceEnabled}
              onToggleVoice={runtime.toggleVoice}
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
                runtime.voiceEnabled
                  ? "Push-to-talk ready. Transcript stays local until you send it."
                  : undefined
              }
              importStatus={runtime.importStatus}
            />

            {renderChatContext()}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending.
        </p>
      </section>
    </main>
  );
}
