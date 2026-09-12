import { Brand } from "../Brand";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { useEffect, useState, type ReactNode } from "react";
import type { ConnectorManifest, FableAgentProfile } from "@fable/protocol";
import { ConnectorIcon } from "../ConnectorIcon";
import { ProfileAgentAvatar } from "./agent-icons";
import { AccountMenu } from "./AccountMenu";
import { PRESENCE_LABELS, type AgentPresence } from "../../lib/agent-presence";
import "../projects/projects.css";

export interface AgentSidebarPreview {
  message: string;
  time: string;
  status: "idle" | "running" | "attention";
  presence?: AgentPresence;
  completionId?: string;
}

export interface AgentSidebarProject {
  id: string;
  name: string;
}

export function AgentSidebar({
  agents,
  activeAgentId,
  previews,
  profileName,
  connectors,
  marketplaceActive,
  onSelectAgent,
  onCreateAgent,
  onEditAgent,
  onOpenMarketplace,
  onOpenSettings,
  onOpenUsage,
  onSignOut,
  projects = [],
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  hidden = false,
  collapsed = false,
  onToggleCollapsed,
  conversations = [], selectedConversationId, onSelectConversation, onCreateConversation, activity,
}: {
  agents: FableAgentProfile[];
  activeAgentId: string;
  previews: Record<string, AgentSidebarPreview>;
  profileName: string;
  connectors: ConnectorManifest[];
  marketplaceActive: boolean;
  onSelectAgent: (agent: FableAgentProfile) => void;
  onCreateAgent: () => void;
  onEditAgent: (agent: FableAgentProfile) => void;
  onOpenMarketplace: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onSignOut: () => void;
  projects?: AgentSidebarProject[];
  selectedProjectId?: string | null;
  onSelectProject?: (project: AgentSidebarProject) => void;
  onCreateProject?: () => void;
  hidden?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  conversations?: { id: string; title: string; kind: "direct" | "group"; projectId?: string; participants?: { agentId: string }[]; status?: string }[];
  selectedConversationId?: string;
  onSelectConversation?: (id: string) => void;
  onCreateConversation?: (kind?: "direct" | "group", agentId?: string) => void;
  activity?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const reveal = (id: string) => setExpanded(current => new Set([...current, id]));
  const directRooms = (agentId: string) => conversations.filter(room => !room.projectId && room.kind === "direct" && room.participants?.some(member => member.agentId === agentId));
  const [completions, setCompletions] = useState<
    Record<string, { id: string; unread: boolean }>
  >({});
  useEffect(() => {
    setCompletions((current) => {
      const next = { ...current };
      let changed = false;
      for (const [id, preview] of Object.entries(previews)) {
        if (preview.status === "running" && next[id]) {
          delete next[id];
          changed = true;
        } else if (preview.presence === "done") {
          const completionId = preview.completionId ?? "completed";
          if (next[id]?.id !== completionId) {
            next[id] = { id: completionId, unread: true };
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [previews]);
  const normalizedQuery = collapsed ? "" : query.trim().toLowerCase();
  const visibleAgents = agents.filter((agent) =>
    `${agent.name} ${previews[agent.id]?.message ?? ""}`
      .toLowerCase()
      .includes(normalizedQuery) || directRooms(agent.id).some(room => room.title.toLowerCase().includes(normalizedQuery)),
  );
  const visibleProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(normalizedQuery) || conversations.some(room => room.projectId === project.id && room.title.toLowerCase().includes(normalizedQuery)),
  );
  const groupRooms = conversations.filter(room => !room.projectId && room.kind === "group" && room.title.toLowerCase().includes(normalizedQuery));
  const unassigned = conversations.filter(room => !room.projectId && room.kind === "direct" && !room.participants?.some(member => agents.some(agent => agent.id === member.agentId)) && room.title.toLowerCase().includes(normalizedQuery));
  const roomButton = (room: (typeof conversations)[number]) => <button type="button" key={room.id} className="conversation-sidebar__row" aria-current={room.id === selectedConversationId && !marketplaceActive ? "page" : undefined} onClick={() => onSelectConversation?.(room.id)} title={room.title}>
    <span aria-hidden="true">{room.kind === "group" ? "◉" : "·"}</span><span>{room.title}</span>{room.status ? <small aria-label={room.status} title={room.status}>{room.status === "Working" || room.status === "Unread" ? "•" : "!"}</small> : null}
  </button>;
  const installedConnectors = connectors.filter(
    (connector) =>
      connector.id !== "local-files" && connector.status === "connected",
  );

  return (
    <aside className={`agent-sidebar${collapsed ? " agent-sidebar--collapsed" : ""}`} aria-label="Agents" hidden={hidden}>
      <div className="agent-sidebar__topline">
        <Brand className="agent-sidebar__brand" />
        {onToggleCollapsed ? <button className="agent-sidebar__collapse" type="button" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} onClick={onToggleCollapsed}><SidebarSimple size={18} /></button> : null}
      </div>

      <label className="agent-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search conversations, projects and agents"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {projects.length > 0 || onCreateProject ? (
        <section
          className="project-sidebar-section"
          aria-labelledby="project-sidebar-title"
        >
          <header>
            <span id="project-sidebar-title">Projects</span>
            {onCreateProject ? (
              <button
                type="button"
                onClick={onCreateProject}
                aria-label="Create project"
                title="Create project"
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            ) : null}
          </header>
          <div className="project-sidebar-list">
            {visibleProjects.map((project) => {
              const active =
                project.id === selectedProjectId && !marketplaceActive;
              return (
                <div className="sidebar-project-group" key={project.id}><div className="sidebar-project-group__row"><button
                  type="button"
                  className={`project-sidebar-row${active ? " project-sidebar-row--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => { reveal(project.id); onSelectProject?.(project); }}
                >
                  <span
                    className="project-sidebar-row__icon"
                    aria-hidden="true"
                  >
                    <FolderSimple size={19} />
                  </span>
                  <span>
                    <strong title={project.name}>{project.name}</strong>
                    <small>Project team</small>
                  </span>
                </button>{!collapsed ? <button type="button" className="sidebar-scope-toggle" aria-label={`Show conversations in ${project.name}`} aria-expanded={expanded.has(project.id) || Boolean(normalizedQuery)} onClick={() => toggle(project.id)}>⌄</button> : null}</div>
                {!collapsed && (expanded.has(project.id) || normalizedQuery) ? <div className="sidebar-child-conversations" aria-label={`Conversations in ${project.name}`}>{conversations.filter(room => room.projectId === project.id && (!normalizedQuery || room.title.toLowerCase().includes(normalizedQuery) || project.name.toLowerCase().includes(normalizedQuery))).slice().reverse().map(roomButton)}</div> : null}</div>
              );
            })}
            {projects.length > 0 && visibleProjects.length === 0 ? (
              <p className="project-sidebar-empty" role="status">
                No projects match “{query}”.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {onCreateConversation || groupRooms.length ? <section className="conversation-sidebar" aria-label="Group chats">
        <header className="agent-sidebar__agents-heading"><span>Group chats</span>{onCreateConversation ? <button className="agent-sidebar__new" type="button" onClick={() => onCreateConversation("group")} aria-label="New group chat" title="New group chat"><Plus size={17} /></button> : null}</header>
        {!collapsed ? <div className="conversation-sidebar__list">{groupRooms.map(roomButton)}{!groupRooms.length && !normalizedQuery ? <button type="button" className="sidebar-new-conversation" onClick={() => onCreateConversation?.("group")}>Start a group chat</button> : null}</div> : null}
      </section> : null}

      <div className="agent-sidebar__agents-heading">
        <span>Agents</span>
        <button className="agent-sidebar__new" type="button" onClick={onCreateAgent} aria-label="Create agent" title="Create agent">
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="agent-list" role="list">
        {visibleAgents.map((agent) => {
          const active =
            agent.id === activeAgentId &&
            !marketplaceActive &&
            !selectedProjectId && conversations.find(room => room.id === selectedConversationId)?.kind !== "group";
          const preview = previews[agent.id] ?? {
            message: "Start a conversation",
            time: "",
            status: "idle" as const,
          };
          const presence =
            preview.presence ??
            (preview.status === "running"
              ? "working"
              : preview.status === "attention"
                ? "waiting"
                : "idle");
          return (
            <div
              key={agent.id}
              className="sidebar-agent-group"
              role="listitem"
            ><div className={`agent-row${active ? " agent-row--active" : ""}`}><button
                className="agent-row__select"
                type="button"
                onClick={() => {
                  setCompletions((current) =>
                    current[agent.id]
                      ? {
                          ...current,
                          [agent.id]: { ...current[agent.id], unread: false },
                        }
                      : current,
                  );
                  reveal(agent.id);
                  onSelectAgent(agent);
                }}
                aria-current={active ? "page" : undefined}
                aria-label={collapsed ? agent.name : undefined}
                title={collapsed ? agent.name : undefined}
              >
                <ProfileAgentAvatar
                  agent={agent}
                  iconSize={36}
                  presence={presence}
                />
                <span className="agent-row__copy">
                  <span className="agent-row__line">
                    <strong title={agent.name}>{agent.name}</strong>
                    <time>{preview.time}</time>
                  </span>
                  <span className="agent-row__meta">
                    <span className="agent-row__preview">
                      {preview.message}
                    </span>
                  </span>
                </span>
                {preview.status === "running" || preview.status === "attention" || completions[agent.id]?.unread ? (
                  <span
                    className={`agent-status agent-status--${preview.status === "attention" ? "attention" : preview.status === "running" ? "working" : "unread"}`}
                    role="status"
                    aria-label={preview.status !== "idle" ? PRESENCE_LABELS[presence] : "New completed work"}
                    title={preview.status !== "idle" ? PRESENCE_LABELS[presence] : "New completed work"}
                  >{preview.status === "attention" ? "!" : null}</span>
                ) : null}
              </button>
              {!collapsed && onSelectConversation ? <button type="button" className="sidebar-scope-toggle" aria-label={`Show conversations with ${agent.name}`} aria-expanded={expanded.has(agent.id) || Boolean(normalizedQuery)} onClick={() => toggle(agent.id)}>⌄</button> : null}
              <button
                className="agent-row__edit"
                type="button"
                onClick={() => onEditAgent(agent)}
                aria-label={`Edit ${agent.name}`}
              >
                <NotePencil size={14} aria-hidden="true" />
              </button></div>
              {!collapsed && onSelectConversation && (expanded.has(agent.id) || normalizedQuery) ? <div className="sidebar-child-conversations" aria-label={`Conversations with ${agent.name}`}>{directRooms(agent.id).filter(room => !normalizedQuery || room.title.toLowerCase().includes(normalizedQuery) || agent.name.toLowerCase().includes(normalizedQuery)).map(roomButton)}{onCreateConversation ? <button type="button" className="sidebar-new-conversation" onClick={() => onCreateConversation("direct", agent.id)}>+ New conversation</button> : null}</div> : null}
            </div>
          );
        })}
        {agents.length === 0 ? (
          <p className="agent-list__empty">
            Create your first agent to get started.
          </p>
        ) : null}
        {agents.length > 0 && !visibleAgents.length ? (
          <p className="agent-list__empty" role="status">
            No agents match “{query}”.
          </p>
        ) : null}
      {!collapsed && unassigned.length ? <details className="sidebar-unassigned"><summary>Unassigned history</summary><p>Choose a teammate in the conversation options to continue these older chats.</p>{unassigned.map(roomButton)}</details> : null}</div>

      {activity}
      <button
        className={`agent-sidebar__connections${marketplaceActive ? " agent-sidebar__connections--active" : ""}`}
        type="button"
        onClick={onOpenMarketplace}
        aria-current={marketplaceActive ? "page" : undefined}
      >
        <PlugsConnected size={16} aria-hidden="true" />
        <span>Plugins</span>
        {installedConnectors.length ? (
          <span
            className="agent-sidebar__connector-stack"
            aria-label={`${installedConnectors.length} installed`}
          >
            {installedConnectors.slice(0, 3).map((connector) => (
              <span key={connector.id} title={connector.name}>
                <ConnectorIcon id={connector.id} />
              </span>
            ))}
          </span>
        ) : null}
      </button>

      <AccountMenu
        name={profileName}
        onUsage={onOpenUsage}
        onSettings={onOpenSettings}
        onSignOut={onSignOut}
      />
    </aside>
  );
}
