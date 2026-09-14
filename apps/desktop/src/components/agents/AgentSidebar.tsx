import { useEffect, useRef, useState } from "react";
import type { ConnectorManifest, FableAgentProfile } from "@fable/protocol";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { Brand } from "../Brand";
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
  threadId?: string;
}
type SidebarRoom = {
  id: string;
  title: string;
  kind: "direct" | "group";
  projectId?: string;
  participants?: { agentId: string; name?: string }[];
  status?: string;
};
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
  conversations = [],
  selectedConversationId,
  onSelectConversation,
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
  conversations?: SidebarRoom[];
  selectedConversationId?: string;
  onSelectConversation?: (id: string, newTab?: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    setQuery("");
    const frame = requestAnimationFrame(() => sidebar.current?.querySelector<HTMLElement>('.agent-row__select[aria-current="page"]')?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [activeAgentId]);
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
        } else if (
          preview.presence === "done" &&
          next[id]?.id !== (preview.completionId ?? "completed")
        ) {
          next[id] = { id: preview.completionId ?? "completed", unread: true };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [previews]);
  const search = collapsed ? "" : query.trim().toLowerCase();
  const visibleAgents = agents.filter((agent) =>
    agent.name.toLowerCase().includes(search),
  );
  const visibleProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(search),
  );
  // Search is the one place every existing conversation becomes reachable;
  // the default list keeps the sidebar quiet. Standalone groups are not a
  // navigation section: they are opened by reference and migrated into
  // projects through the conversation menu.
  const searchRooms = search
    ? conversations.filter((room) =>
        room.title.toLowerCase().includes(search),
      )
    : [];
  const installed = connectors.filter(
    (connector) =>
      connector.id !== "local-files" && connector.status === "connected",
  );
  return (
    <aside
      ref={sidebar}
      className={`agent-sidebar${collapsed ? " agent-sidebar--collapsed" : ""}`}
      aria-label="Agents"
      hidden={hidden}
    >
      <div className="agent-sidebar__topline">
        <Brand className="agent-sidebar__brand" />
        {onToggleCollapsed ? (
          <button
            className="agent-sidebar__collapse"
            type="button"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <SidebarSimple size={18} />
          </button>
        ) : null}
      </div>
      <label className="agent-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search projects, conversations and agents"
          placeholder="Search projects, chats, agents…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="agent-sidebar__scopes">
        {(!search && (projects.length || onCreateProject)) || visibleProjects.length ? (
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
                  <Plus size={15} />
                </button>
              ) : null}
            </header>
            <div className="project-sidebar-list">
              {visibleProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={`project-sidebar-row${project.id === selectedProjectId && !marketplaceActive ? " project-sidebar-row--active" : ""}`}
                  title={project.name}
                  aria-current={
                    project.id === selectedProjectId && !marketplaceActive
                      ? "page"
                      : undefined
                  }
                  data-conversation-room={project.threadId}
                  onDragStart={(event) => event.preventDefault()}
                  onClick={() => onSelectProject?.(project)}
                >
                  <span
                    className="project-sidebar-row__icon"
                    aria-hidden="true"
                  >
                    <FolderSimple size={20} />
                  </span>
                  <strong>{project.name}</strong>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {searchRooms.length ? (
          <div className="conversation-sidebar__list">
            {searchRooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className="conversation-sidebar__row"
                aria-current={
                  room.id === selectedConversationId && !marketplaceActive
                    ? "page"
                    : undefined
                }
                title={room.title}
                data-conversation-room={room.id}
                onDragStart={(event) => event.preventDefault()}
                onClick={(event) =>
                  onSelectConversation?.(
                    room.id,
                    event.ctrlKey || event.metaKey,
                  )
                }
              >
                <span>
                  {room.title}
                  {room.projectId
                    ? ` · ${projects.find((project) => project.id === room.projectId)?.name ?? "Project"}`
                    : ""}
                </span>
                {room.status ? (
                  <small aria-label={room.status}>
                    {["Working", "Unread"].includes(room.status) ? "•" : "!"}
                  </small>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        {!search || visibleAgents.length ? <div className="agent-sidebar__agents-heading">
          <span>Agents</span>
          <div>
            <button
              className="agent-sidebar__new"
              type="button"
              onClick={onCreateAgent}
              aria-label="Create agent"
              title="Create agent"
            >
              <Plus size={17} />
            </button>
          </div>
        </div> : null}
        <div className="agent-list" role="list">
          {visibleAgents.map((agent) => {
            const preview = previews[agent.id];
            const presence =
              preview?.presence ??
              (preview?.status === "running"
                ? "working"
                : preview?.status === "attention"
                  ? "waiting"
                  : "idle");
            const active =
              agent.id === activeAgentId &&
              !marketplaceActive &&
              !selectedProjectId &&
              conversations.find((room) => room.id === selectedConversationId)
                ?.kind !== "group";
            const room = conversations
              .filter(
                (room) =>
                  !room.projectId &&
                  room.kind === "direct" &&
                  room.participants?.some(
                    (member) => member.agentId === agent.id,
                  ),
              )
              .at(-1);
            return (
              <div
                className={`agent-row${active ? " agent-row--active" : ""}`}
                role="listitem"
                key={agent.id}
              >
                <button
                  className="agent-row__select"
                  type="button"
                  data-conversation-room={room?.id}
                  onDragStart={(event) => event.preventDefault()}
                  onClick={(event) => {
                    setCompletions((current) =>
                      current[agent.id]
                        ? {
                            ...current,
                            [agent.id]: { ...current[agent.id], unread: false },
                          }
                        : current,
                    );
                    if (room && (event.ctrlKey || event.metaKey))
                      onSelectConversation?.(room.id, true);
                    else onSelectAgent(agent);
                  }}
                  aria-current={active ? "page" : undefined}
                  aria-label={agent.name}
                  title={agent.name}
                >
                  <ProfileAgentAvatar
                    agent={agent}
                    iconSize={32}
                    presence={presence}
                  />
                  <span className="agent-row__copy">
                    <strong>{agent.name}</strong>
                  </span>
                  {(preview && preview.status !== "idle") ||
                  completions[agent.id]?.unread ? (
                    <span
                      className={`agent-status agent-status--${preview?.status === "attention" ? "attention" : preview?.status === "running" ? presence === "service" ? "service" : presence === "thinking" ? "thinking" : presence === "waiting" || presence === "input" ? "waiting" : "working" : "unread"}`}
                      role="status"
                      aria-label={
                        preview && preview.status !== "idle"
                          ? PRESENCE_LABELS[presence]
                          : "New completed work"
                      }
                    >
                      {preview?.status === "attention" ? "!" : null}
                    </span>
                  ) : null}
                </button>
                <button
                  className="agent-row__edit"
                  type="button"
                  onClick={() => onEditAgent(agent)}
                  aria-label={`Edit ${agent.name}`}
                >
                  <NotePencil size={14} />
                </button>
              </div>
            );
          })}
          {!agents.length ? (
            <p className="agent-list__empty">
              Create your first agent to get started.
            </p>
          ) : null}
        </div>
        {search && !visibleAgents.length && !visibleProjects.length && !searchRooms.length ? <p className="agent-list__empty">No matching projects, conversations or agents.</p> : null}
      </div>
      <button
        className={`agent-sidebar__connections${marketplaceActive ? " agent-sidebar__connections--active" : ""}`}
        type="button"
        onClick={onOpenMarketplace}
        aria-current={marketplaceActive ? "page" : undefined}
      >
        <PlugsConnected size={16} />
        <span>Plugins</span>
        {installed.length ? (
          <span
            className="agent-sidebar__connector-stack"
            aria-label={`${installed.length} installed`}
          >
            {installed.slice(0, 3).map((connector) => (
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
