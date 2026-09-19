import { useEffect, useRef, useState } from "react";
import type { ConnectorManifest, MivletAgentProfile } from "@mivlet/protocol";
import { SidebarCreateMenu } from "./SidebarCreateMenu";
import { PluginsIcon } from "../PluginsIcon";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Users } from "@phosphor-icons/react/dist/csr/Users";
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
  onOpenMarketplace,
  onOpenSettings,
  onOpenUsage,
  onSignOut,
  projects = [],
  selectedProjectId,
  onSelectProject,
  onCreateProject,
  hidden = false,
  conversations = [],
  selectedConversationId,
  onSelectConversation,
  onSearch,
}: {
  agents: MivletAgentProfile[];
  activeAgentId: string;
  previews: Record<string, AgentSidebarPreview>;
  profileName: string;
  connectors: ConnectorManifest[];
  marketplaceActive: boolean;
  onSelectAgent: (agent: MivletAgentProfile) => void;
  onCreateAgent: () => void;
  onOpenMarketplace: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onSignOut: () => void;
  projects?: AgentSidebarProject[];
  selectedProjectId?: string | null;
  onSelectProject?: (project: AgentSidebarProject) => void;
  onCreateProject?: () => void;
  hidden?: boolean;
  conversations?: SidebarRoom[];
  selectedConversationId?: string;
  onSelectConversation?: (id: string) => void;
  onSearch?: () => void;
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
  const search = query.trim().toLowerCase();
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
      className="agent-sidebar"
      aria-label="Agents"
      hidden={hidden}
    >
      <div className="agent-sidebar__topline">
        <Brand className="agent-sidebar__brand" />
        <SidebarCreateMenu agents={agents} onCreateAgent={onCreateAgent} onCreateProject={onCreateProject} onSelectAgent={onSelectAgent} />
      </div>
      {onSearch ? <button type="button" className="agent-search" onClick={onSearch} aria-label="Search workspace"><MagnifyingGlass size={16} /><span>Search</span></button> : <label className="agent-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search projects, conversations and agents"
          placeholder="Search projects, chats, agents…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>}
      <div className="agent-sidebar__scopes">
        {(!search && (projects.length || onCreateProject)) || visibleProjects.length ? (
          <section
            className="project-sidebar-section"
            aria-labelledby="project-sidebar-title"
          >
            <header>
              <span id="project-sidebar-title">Projects</span>
            </header>
            <div className="project-sidebar-list">
              {visibleProjects.map((project) => {
                const memberIds = new Set(conversations
                  .filter(room => room.projectId === project.id || room.id === project.threadId)
                  .flatMap(room => room.participants?.map(member => member.agentId) ?? []));
                const members = agents.filter(agent => memberIds.has(agent.id)).slice(0, 3);
                return (
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
                    className={`project-sidebar-row__icon project-sidebar-row__avatars project-sidebar-row__avatars--${members.length}`}
                    aria-hidden="true"
                  >
                    {members.length ? members.map(member => <ProfileAgentAvatar key={member.id} agent={member} iconSize={members.length === 1 ? 34 : 23} />) : <Users size={22} />}
                  </span>
                  <strong>{project.name}</strong>
                </button>
              ); })}
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
                onClick={() => onSelectConversation?.(room.id)}
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
                      onSelectConversation?.(room.id);
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
                    {preview?.message ? <span className="agent-row__preview" title={preview.message}>{preview.message}</span> : null}
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
        <span className="agent-sidebar__plugins-icon"><PluginsIcon size={22} /></span>
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
