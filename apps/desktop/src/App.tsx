import {
  At,
  Bell,
  CaretDown,
  CaretRight,
  ChatCircle,
  Clock,
  Database,
  FileText,
  FolderOpen,
  Lightning,
  MagnifyingGlass,
  Paperclip,
  Plus,
  PuzzlePiece,
  ShieldCheck,
  SidebarSimple,
  Sparkle,
  Stack,
  UploadSimple,
  Waveform
} from "@phosphor-icons/react";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalRequest,
  AutomationRule,
  AutomationStatus,
  ConnectorManifest,
  KnowledgeSource,
  MemoryRecord,
  ThreadSummary,
  WorkspaceDirective
} from "@praxis/protocol";
import {
  automations,
  chatThreads,
  connectors,
  knowledgeSources,
  memoryRecords,
  pendingApprovals,
  projects,
  workspaceDirectives
} from "./data/workspace";
import { PraxisLogo } from "./components/PraxisLogo";

const STORAGE_KEY = "praxis.shell.v1";

type UtilityItem = "Knowledge" | "Plugins" | "Automations";
type AutomationRuleView = Omit<AutomationRule, "status"> & { status: AutomationStatus };

interface PersistedShellState {
  activeItem: string;
  composerValue: string;
  voiceEnabled: boolean;
  approvalAudit: ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  automationStatuses: Record<string, AutomationStatus>;
  pinnedSourceIds: string[];
}

const utilityItems = [
  { label: "Knowledge", icon: Stack },
  { label: "Plugins", icon: PuzzlePiece },
  { label: "Automations", icon: Lightning }
] as const;

const defaultShellState: PersistedShellState = {
  activeItem: "praxis-initial-build",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  automationStatuses: {},
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id)
};

function readPersistedShellState(): PersistedShellState {
  if (typeof window === "undefined") {
    return defaultShellState;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return defaultShellState;
    }

    return { ...defaultShellState, ...JSON.parse(stored) } as PersistedShellState;
  } catch {
    return defaultShellState;
  }
}

function persistShellState(state: PersistedShellState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local persistence is best-effort in preview and private browsing modes.
  }
}

function ShellButton({
  children,
  pressed,
  onClick,
  label
}: {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      className="shell-button"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusDot({ tone }: { tone: "ready" | "needs-auth" | "draft" | "paused" }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}

function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function DirectiveCards({
  directives,
  onUseDirective
}: {
  directives: WorkspaceDirective[];
  onUseDirective: (directive: WorkspaceDirective) => void;
}) {
  return (
    <section className="directives" aria-label="Workspace directives">
      {directives.map((directive) => (
        <button
          className="directive-card"
          key={directive.id}
          type="button"
          onClick={() => onUseDirective(directive)}
        >
          <span className="directive-copy">
            <strong>{directive.label}</strong>
            <small>{directive.source}</small>
          </span>
        </button>
      ))}
    </section>
  );
}

function ThreadContext({ thread }: { thread?: ThreadSummary }) {
  if (!thread) {
    return null;
  }

  return (
    <section className="thread-context" aria-label="Selected thread context">
      <span>{thread.kind === "project" ? "Project thread" : "Chat"}</span>
      <strong>{thread.title}</strong>
      <p>{thread.description}</p>
      <small>{thread.updatedAt}</small>
    </section>
  );
}

function ApprovalPanel({
  approvals,
  audit,
  onDecision
}: {
  approvals: ApprovalRequest[];
  audit: ApprovalAuditEntry[];
  onDecision: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}) {
  return (
    <section className="context-panel" aria-label="Approvals and memory">
      <SectionHeading title="Approvals" meta={`${approvals.length} waiting`} />
      <div className="approval-list">
        {approvals.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={22} />
            <span>No approvals are waiting.</span>
          </div>
        ) : (
          approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div>
                <span className="label-row">
                  <ShieldCheck size={18} />
                  {approval.mode}
                </span>
                <h3>{approval.action}</h3>
                <p>{approval.consequence}</p>
              </div>
              <dl className="approval-details">
                <div>
                  <dt>Service</dt>
                  <dd>{approval.service}</dd>
                </div>
                <div>
                  <dt>Data</dt>
                  <dd>{approval.dataUsed.join(", ")}</dd>
                </div>
              </dl>
              <div className="approval-actions">
                {approval.decisions.map((decision) => (
                  <button key={decision} type="button" onClick={() => onDecision(approval, decision)}>
                    {decision}
                  </button>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
      {audit.length > 0 ? (
        <div className="audit-strip" aria-label="Approval audit history">
          {audit.slice(0, 3).map((entry) => (
            <span key={entry.id}>
              {entry.decision}: {entry.note}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function KnowledgePanel({
  sources,
  memory,
  pinnedSourceIds,
  onTogglePin
}: {
  sources: KnowledgeSource[];
  memory: MemoryRecord[];
  pinnedSourceIds: string[];
  onTogglePin: (sourceId: string) => void;
}) {
  return (
    <section className="context-panel context-panel--split" aria-label="Knowledge">
      <div>
        <SectionHeading title="Sources" meta={`${sources.length} indexed`} />
        <div className="source-list">
          {sources.map((source) => {
            const pinned = pinnedSourceIds.includes(source.id);
            return (
              <button
                className={`source-row${pinned ? " source-row--pinned" : ""}`}
                key={source.id}
                type="button"
                onClick={() => onTogglePin(source.id)}
              >
                <FileText size={19} />
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.provenance} - {source.freshness}</small>
                </span>
                <span>{pinned ? "Pinned" : "Pin"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <SectionHeading title="Memory" meta="inspectable" />
        <div className="memory-list">
          {memory.map((record) => (
            <article className="memory-row" key={record.id}>
              <span className="label-row">
                <Database size={17} />
                {record.kind}
              </span>
              <strong>{record.title}</strong>
              <p>{record.value}</p>
              <small>{record.source} - {record.freshness}</small>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PluginPanel({
  manifests,
  onUseConnector
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
}) {
  return (
    <section className="context-panel" aria-label="Plugins">
      <SectionHeading title="Plugins" meta="bridges and permissions" />
      <div className="connector-grid">
        {manifests.map((connector) => {
          const ready = connector.status === "connected" || connector.status === "fixture";
          return (
            <article className="connector-card" key={connector.id}>
              <div className="connector-card__top">
                <span>
                  <strong>{connector.name}</strong>
                  <small>{connector.healthSummary}</small>
                </span>
                <StatusDot tone={ready ? "ready" : "needs-auth"} />
              </div>
              <div className="permission-list">
                {connector.permissions.map((permission) => (
                  <span key={permission}>{permission}</span>
                ))}
              </div>
              <button type="button" onClick={() => onUseConnector(connector)}>
                {ready ? "Use in composer" : "Prepare auth"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AutomationPanel({
  rules,
  onToggle
}: {
  rules: AutomationRuleView[];
  onToggle: (rule: AutomationRuleView) => void;
}) {
  return (
    <section className="context-panel" aria-label="Automations">
      <SectionHeading title="Automations" meta="quiet by default" />
      <div className="automation-list">
        {rules.map((rule) => (
          <article className="automation-row" key={rule.id}>
            <Clock size={19} />
            <span>
              <strong>{rule.title}</strong>
              <small>{rule.trigger} - {rule.destination}</small>
            </span>
            <span className="automation-status">
              <StatusDot tone={rule.status === "active" ? "ready" : rule.status === "paused" ? "paused" : "draft"} />
              {rule.status}
            </span>
            <button type="button" onClick={() => onToggle(rule)}>
              {rule.status === "active" ? "Pause" : "Enable"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const initialState = useMemo(readPersistedShellState, []);
  const [activeItem, setActiveItem] = useState(initialState.activeItem);
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    praxis: true,
    site: false
  });
  const [composerValue, setComposerValue] = useState(initialState.composerValue);
  const [voiceEnabled, setVoiceEnabled] = useState(initialState.voiceEnabled);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lastAction, setLastAction] = useState("Workspace ready");
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(initialState.approvalAudit);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(initialState.dismissedApprovalIds);
  const [automationStatuses, setAutomationStatuses] = useState<Record<string, AutomationStatus>>(
    initialState.automationStatuses
  );
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(initialState.pinnedSourceIds);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const allThreads = useMemo(
    () => [...chatThreads, ...projects.flatMap((project) => project.threads)],
    []
  );
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = utilityItems.find((item) => item.label === activeItem)?.label;
  const connectorManifests: ConnectorManifest[] = connectors;
  const connectedCount = useMemo(
    () => connectorManifests.filter((connector) => connector.status === "fixture" || connector.status === "connected").length,
    []
  );
  const openApprovals = pendingApprovals.filter((approval) => !dismissedApprovalIds.includes(approval.id));
  const automationRules: AutomationRuleView[] = automations.map((rule) => ({
    ...rule,
    status: automationStatuses[rule.id] ?? rule.status
  }));

  useEffect(() => {
    persistShellState({
      activeItem,
      composerValue,
      voiceEnabled,
      approvalAudit,
      dismissedApprovalIds,
      automationStatuses,
      pinnedSourceIds
    });
  }, [
    activeItem,
    approvalAudit,
    automationStatuses,
    composerValue,
    dismissedApprovalIds,
    pinnedSourceIds,
    voiceEnabled
  ]);

  const focusComposer = (value: string) => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(value.length, value.length);
    });
  };

  const useDirective = (directive: WorkspaceDirective) => {
    setComposerValue(directive.prompt);
    setLastAction(`Loaded directive: ${directive.label}`);
    focusComposer(directive.prompt);
  };

  const openThread = (thread: ThreadSummary, label: string) => {
    setActiveItem(thread.id);
    setMobileNavOpen(false);
    setLastAction(`Opened ${label}: ${thread.title}`);
  };

  const startNewChat = () => {
    setActiveItem("new-chat");
    setComposerValue("");
    setMobileNavOpen(false);
    setLastAction("New chat ready");
    focusComposer("");
  };

  const submitComposer = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = composerValue.trim();
    setLastAction(trimmed ? "Praxis is ready to plan this with your workspace context." : "Choose a directive or write a prompt.");
  };

  const useConnector = (connector: ConnectorManifest) => {
    const prompt = `Use @${connector.id} with the current workspace context.`;
    setComposerValue(prompt);
    setLastAction(`${connector.name} is ready in the composer`);
    focusComposer(prompt);
  };

  const runCommand = (command: string) => {
    const prompt = `${command} `;
    setComposerValue(prompt);
    setCommandOpen(false);
    setLastAction(`${command} command ready`);
    focusComposer(prompt);
  };

  const decideApproval = (approval: ApprovalRequest, decision: ApprovalDecision) => {
    const entry: ApprovalAuditEntry = {
      id: `${approval.id}-${decision}-${Date.now()}`,
      requestId: approval.id,
      decision,
      decidedAt: new Date().toISOString(),
      note: `${approval.service} ${approval.action}`
    };
    setApprovalAudit((current) => [entry, ...current]);
    setDismissedApprovalIds((current) => (current.includes(approval.id) ? current : [...current, approval.id]));
    setLastAction(`${decision} recorded for ${approval.service}`);
  };

  const toggleSourcePin = (sourceId: string) => {
    setPinnedSourceIds((current) => {
      if (current.includes(sourceId)) {
        setLastAction("Source removed from pinned context");
        return current.filter((id) => id !== sourceId);
      }
      setLastAction("Source pinned to workspace context");
      return [...current, sourceId];
    });
  };

  const toggleAutomation = (rule: AutomationRuleView) => {
    if (rule.requiresApproval && rule.status === "draft") {
      const prompt = `/schedule ${rule.title} with pinned memory, connector health, and active projects.`;
      setComposerValue(prompt);
      setActiveItem("praxis-memory");
      setLastAction("Automation needs approval before it can run");
      focusComposer(prompt);
      return;
    }

    setAutomationStatuses((current) => ({
      ...current,
      [rule.id]: (current[rule.id] ?? rule.status) === "active" ? "paused" : "active"
    }));
    setLastAction(`${rule.title} updated`);
  };

  const renderWorkspaceContext = () => {
    if (activeUtility === "Knowledge") {
      return (
        <KnowledgePanel
          sources={knowledgeSources}
          memory={memoryRecords}
          pinnedSourceIds={pinnedSourceIds}
          onTogglePin={toggleSourcePin}
        />
      );
    }

    if (activeUtility === "Plugins") {
      return <PluginPanel manifests={connectorManifests} onUseConnector={useConnector} />;
    }

    if (activeUtility === "Automations") {
      return <AutomationPanel rules={automationRules} onToggle={toggleAutomation} />;
    }

    if (activeItem === "praxis-memory") {
      return <ApprovalPanel approvals={openApprovals} audit={approvalAudit} onDecision={decideApproval} />;
    }

    return (
      <>
        <DirectiveCards directives={workspaceDirectives} onUseDirective={useDirective} />
        <ThreadContext thread={activeThread} />
      </>
    );
  };

  return (
    <main className="desktop-frame">
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic traffic--red" />
          <span className="traffic traffic--yellow" />
          <span className="traffic traffic--green" />
        </div>

        <PraxisLogo />

        <button className="mobile-nav-toggle" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}>
          <SidebarSimple size={20} />
        </button>

        <button className="new-chat-button" type="button" onClick={startNewChat}>
          <ChatCircle size={16} />
          <span>New chat</span>
          <Plus size={14} />
        </button>

        <div className="sidebar-body">
          <section className="nav-group" aria-labelledby="projects-heading">
            <button
              type="button"
              className="nav-group-heading"
              id="projects-heading"
              aria-expanded={expandedCollections.projects}
              onClick={() => setExpandedCollections((current) => ({ ...current, projects: !current.projects }))}
            >
              <span className="nav-group-title">
                <FolderOpen size={15} />
                <span>Projects</span>
              </span>
              <CaretRight className="collection-caret" size={13} weight="bold" />
            </button>
            {expandedCollections.projects ? (
              <div className="project-list">
                {projects.map((project) => {
                  const expanded = expandedProjects[project.id];
                  return (
                    <div className="project-block" key={project.id}>
                      <button
                        type="button"
                        className="project-row"
                        aria-expanded={expanded}
                        onClick={() => {
                          setExpandedProjects((current) => ({ ...current, [project.id]: !expanded }));
                          setLastAction(`${expanded ? "Collapsed" : "Expanded"} project: ${project.title}`);
                        }}
                      >
                        <CaretRight className="project-caret" size={12} weight="bold" />
                        <FolderOpen size={15} />
                        <span>{project.title}</span>
                      </button>
                      {expanded ? (
                        <div className="nested-thread-list">
                          {project.threads.map((thread) => (
                            <button
                              key={thread.id}
                              type="button"
                              className={`thread-row thread-row--nested${
                                activeItem === thread.id ? " thread-row--active" : ""
                              }`}
                              onClick={() => openThread(thread, project.title)}
                            >
                              {thread.title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="nav-group" aria-labelledby="chats-heading">
            <button
              type="button"
              className="nav-group-heading"
              id="chats-heading"
              aria-expanded={expandedCollections.chats}
              onClick={() => setExpandedCollections((current) => ({ ...current, chats: !current.chats }))}
            >
              <span className="nav-group-title">
                <ChatCircle size={15} />
                <span>Chats</span>
              </span>
              <CaretRight className="collection-caret" size={13} weight="bold" />
            </button>
            {expandedCollections.chats ? (
              <div className="thread-list">
                {chatThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                    onClick={() => openThread(thread, "chat")}
                  >
                    {thread.title}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <nav className="utility-nav" aria-label="Workspace tools">
            {utilityItems.map((item) => {
              const Icon = item.icon;
              const active = activeItem === item.label;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`utility-row${active ? " utility-row--active" : ""}`}
                  onClick={() => {
                    setActiveItem(item.label);
                    setLastAction(`${item.label} selected`);
                  }}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className={`account-row${accountOpen ? " account-row--open" : ""}`}
            onClick={() => {
              setAccountOpen((open) => !open);
              setLastAction("Profile and settings opened");
            }}
          >
            <span className="avatar">J</span>
            <strong>Josh</strong>
            <CaretDown size={16} weight="bold" />
          </button>
          {accountOpen ? (
            <div className="account-popover" role="status">
              <span>Read-only by default</span>
              <span>{connectedCount} bridges ready</span>
              <span>{pinnedSourceIds.length} pinned sources</span>
            </div>
          ) : null}
        </div>

        {mobileNavOpen ? (
          <div className="mobile-drawer" aria-label="Mobile navigation">
            <button className="mobile-new-chat" type="button" onClick={startNewChat}>
              <ChatCircle size={16} />
              <span>New chat</span>
              <Plus size={14} />
            </button>

            <section className="mobile-drawer-section" aria-label="Projects">
              <strong>Projects</strong>
              {projects.map((project) => (
                <div className="mobile-project" key={project.id}>
                  <span>
                    <FolderOpen size={14} />
                    {project.title}
                  </span>
                  {project.threads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={`thread-row thread-row--nested${
                        activeItem === thread.id ? " thread-row--active" : ""
                      }`}
                      onClick={() => openThread(thread, project.title)}
                    >
                      {thread.title}
                    </button>
                  ))}
                </div>
              ))}
            </section>

            <section className="mobile-drawer-section" aria-label="Chats">
              <strong>Chats</strong>
              {chatThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                  onClick={() => openThread(thread, "chat")}
                >
                  {thread.title}
                </button>
              ))}
            </section>

            <nav className="mobile-utilities" aria-label="Mobile workspace tools">
              {utilityItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setActiveItem(item.label);
                      setMobileNavOpen(false);
                      setLastAction(`${item.label} selected`);
                    }}
                  >
                    <Icon size={15} />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>
        ) : null}
      </aside>

      <section className="workspace" aria-label="Praxis workspace">
        <header className="topbar">
          <button className="search-control" type="button">
            <MagnifyingGlass size={18} />
            <span>Search</span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
          <button className="notification-button" type="button" aria-label="Notifications">
            <Bell size={23} />
            <span />
          </button>
          <button className="mini-avatar" type="button" aria-label="Josh profile">
            J
          </button>
        </header>

        <div className="workspace-center">
          <section className="hero" aria-labelledby="hero-title">
            <div className="greeting">
              <Sparkle size={25} weight="regular" />
              <span>Good evening, Josh</span>
            </div>
            <h1 id="hero-title">Bring the work into one place</h1>
            <p>Ask Praxis to work with your tools, memory, and files</p>
          </section>

          <form className="composer" onSubmit={submitComposer}>
            <textarea
              ref={composerRef}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              placeholder="Ask anything, speak, attach, or run a command..."
              aria-label="Universal composer"
            />
            <div className="composer-actions">
              <div className="composer-left-actions">
                <button
                  type="button"
                  className={`voice-chip${voiceEnabled ? " voice-chip--active" : ""}`}
                  onClick={() => {
                    setVoiceEnabled((enabled) => !enabled);
                    setLastAction(voiceEnabled ? "Voice paused" : "Voice ready");
                  }}
                >
                  <Waveform size={19} weight="bold" />
                  <span>Voice</span>
                  <CaretDown size={14} weight="bold" />
                </button>
                <ShellButton label="Attach context" onClick={() => setLastAction("Attach a file, folder, or source")}>
                  <Paperclip size={21} />
                  <span>Attach</span>
                </ShellButton>
                <ShellButton
                  label="Open tools"
                  pressed={toolPickerOpen}
                  onClick={() => {
                    setToolPickerOpen((open) => !open);
                    setCommandOpen(false);
                    setLastAction("Tool picker toggled");
                  }}
                >
                  <At size={21} />
                  <span>tools</span>
                </ShellButton>
                <ShellButton
                  label="Open slash commands"
                  pressed={commandOpen}
                  onClick={() => {
                    setCommandOpen((open) => !open);
                    setToolPickerOpen(false);
                    setLastAction("Command palette toggled");
                  }}
                >
                  <span className="slash">/</span>
                  <span>commands</span>
                </ShellButton>
              </div>
              <button className="send-button" type="submit" aria-label="Send prompt">
                <UploadSimple size={25} weight="bold" />
              </button>
            </div>
            {voiceEnabled ? (
              <div className="voice-state" role="status">
                Push-to-talk ready. Transcript stays local until you send it.
              </div>
            ) : null}
            {toolPickerOpen ? (
              <div className="inline-menu" role="status">
                {connectors.slice(0, 4).map((connector) => (
                  <button key={connector.id} type="button" onClick={() => useConnector(connector)}>
                    {connector.name}
                  </button>
                ))}
              </div>
            ) : null}
            {commandOpen ? (
              <div className="inline-menu inline-menu--commands" role="status">
                {["/plan", "/goal", "/remember", "/schedule"].map((command) => (
                  <button key={command} type="button" onClick={() => runCommand(command)}>
                    {command}
                  </button>
                ))}
              </div>
            ) : null}
          </form>

          {renderWorkspaceContext()}
          <p className="sr-only" aria-live="polite">
            {lastAction}. {memoryRecords.length} memory items. {openApprovals.length} approvals pending.
          </p>
        </div>
      </section>
    </main>
  );
}
