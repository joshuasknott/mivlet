import { useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { chatThreads, connectors, projects } from "./data/workspace";
import { utilityItems } from "./lib/constants";
import { useShellRuntime } from "./hooks/useShellRuntime";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { Composer } from "./components/Composer";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { PluginPanel } from "./components/PluginPanel";
import { AutomationPanel } from "./components/AutomationPanel";
import { CitationResults, DirectiveCards, ThreadContext } from "./components/workspace-cards";

/**
 * Root composition for the Arden desktop shell.
 *
 * The runtime/data state and runtime-backed effects live in useShellRuntime.
 * This component owns only shell-local UI state (collection expansion, the
 * account popover, tool/command picker visibility, voice) and wires the
 * shell, composer, and active context view together.
 */

export function App() {
  const runtime = useShellRuntime();
  const [expandedCollections, setExpandedCollections] = useState({
    utilities: true,
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    arden: true,
    site: false
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  const renderWorkspaceContext = () => {
    if (runtime.activeUtility === "Knowledge") {
      return (
        <KnowledgePanel
          sources={runtime.workspaceKnowledgeSources}
          memory={runtime.managedMemoryRecords}
          memoryDisabled={runtime.memoryDisabled}
          editingMemoryId={runtime.editingMemoryId}
          editingMemoryDraft={runtime.editingMemoryDraft}
          memoryExportText={runtime.memoryExportText}
          memoryStatus={runtime.memoryStatus}
          pinnedSourceIds={runtime.pinnedSourceIds}
          onTogglePin={runtime.toggleSourcePin}
          onPromoteSource={runtime.promoteSourceToMemory}
          onStartMemoryEdit={runtime.startMemoryEdit}
          onUpdateMemoryDraft={runtime.setEditingMemoryDraft}
          onSaveMemoryEdit={runtime.saveMemoryEdit}
          onCancelMemoryEdit={runtime.cancelMemoryEdit}
          onForgetMemory={runtime.forgetMemory}
          onToggleMemoryPin={runtime.toggleMemoryPin}
          onToggleMemoryDisabled={runtime.toggleMemoryDisabled}
          onExportMemory={runtime.exportMemory}
        />
      );
    }

    if (runtime.activeUtility === "Plugins") {
      return <PluginPanel manifests={connectors} onUseConnector={runtime.useConnector} />;
    }

    if (runtime.activeUtility === "Automations") {
      return <AutomationPanel rules={runtime.automationRules} onToggle={runtime.toggleAutomation} />;
    }

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
        <CitationResults citations={runtime.knowledgeCitations} mode={runtime.knowledgeSearchMode} />
        <DirectiveCards directives={runtime.contextualDirectives} onUseDirective={runtime.useDirective} />
        <ThreadContext thread={runtime.activeThread} />
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;

  return (
    <main className="desktop-frame">
      <WorkspaceSidebar
        utilityItems={utilityItems}
        activeItem={runtime.activeItem}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={projects}
        chatThreads={chatThreads}
        mobileNavOpen={runtime.mobileNavOpen}
        accountOpen={accountOpen}
        onNewChat={runtime.startNewChat}
        onSearch={() => {
          runtime.setLastAction("Search ready");
          runtime.focusComposer("Search ");
        }}
        onToggleUtilityGroup={() =>
          setExpandedCollections((current) => ({ ...current, utilities: !current.utilities }))
        }
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
        onSelectThread={(thread) => runtime.openThread(thread, "chat")}
        onToggleAccount={() => {
          setAccountOpen((open) => !open);
          runtime.setLastAction("Profile and settings opened");
        }}
        onAccountMenu={(item) => {
          setAccountOpen(false);
          runtime.setLastAction(item === "profile" ? "Profile selected" : "Settings selected");
        }}
      />

      <section className="workspace" aria-label="Arden workspace">
        <div className="workspace-center">
          <section className="hero" aria-labelledby="hero-title">
            <div className="greeting">
              <Sparkle size={25} weight="regular" />
              <span>Good evening, Josh</span>
            </div>
            <h1 id="hero-title">Bring the work into one place</h1>
            <p>Ask Arden to work with your tools, memory, and files</p>
          </section>

          <Composer
            composerRef={runtime.composerRef}
            fileInputRef={runtime.fileInputRef}
            composerValue={runtime.composerValue}
            onComposerChange={runtime.setComposerValue}
            onSubmit={runtime.submitComposer}
            voiceEnabled={runtime.voiceEnabled}
            onToggleVoice={runtime.toggleVoice}
            onAttach={runtime.triggerAttach}
            toolPickerOpen={toolPickerOpen}
            commandOpen={commandOpen}
            onToggleTools={() => {
              setToolPickerOpen((open) => !open);
              setCommandOpen(false);
              runtime.setLastAction("Tool picker toggled");
            }}
            onToggleCommands={() => {
              setCommandOpen((open) => !open);
              setToolPickerOpen(false);
              runtime.setLastAction("Command palette toggled");
            }}
            connectors={connectors}
            onUseConnector={runtime.useConnector}
            onRunCommand={runtime.runCommand}
            onFileChange={runtime.handleLocalKnowledgeFileChange}
            voiceState={runtime.voiceEnabled ? "Push-to-talk ready. Transcript stays local until you send it." : undefined}
            importStatus={runtime.importStatus}
          />

          {renderWorkspaceContext()}
          <p className="sr-only" aria-live="polite">
            {liveStatusLead} {runtime.managedMemoryRecords.length} memory items. {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals pending.
          </p>
        </div>
      </section>
    </main>
  );
}
