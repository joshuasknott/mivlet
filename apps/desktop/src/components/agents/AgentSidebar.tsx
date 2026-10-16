import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConnectorManifest, MivletAgentProfile, ProjectTeam, SidebarPreferences } from "@mivlet/protocol";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PluginsIcon } from "../PluginsIcon";
import { Brand } from "../Brand";
import { ConnectorIcon } from "../ConnectorIcon";
import { ProfileAgentAvatar } from "./agent-icons";
import { AccountMenu } from "./AccountMenu";
import { SidebarMenu } from "./SidebarMenu";
import { SidebarSection } from "./SidebarSection";
import { sidebarProjectMembers, type AgentSidebarProject, type SidebarRoom, type SidebarAttention } from "./sidebar-data";
import { DEFAULT_SIDEBAR_PREFERENCES, moveSidebarItem, orderSidebarItems } from "../../lib/sidebar-preferences";
import { PRESENCE_LABELS, type AgentPresence } from "../../lib/agent-presence";
import "./agent-sidebar.css";

export interface AgentSidebarPreview {
  message: string;
  time: string;
  status: "idle" | "running" | "attention";
  presence?: AgentPresence;
  completionId?: string;
}

type SidebarEntity = { kind: "project"; item: AgentSidebarProject } | { kind: "agent"; item: MivletAgentProfile };
const reference = (entity: SidebarEntity) => `${entity.kind}:${entity.item.id}`;
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();
const EMPTY_TEAMS: ProjectTeam[] = [];

export function AgentSidebar({
  agents, activeAgentId, previews, profileName, connectors, marketplaceActive,
  onSelectAgent, onCreateAgent, onNewConversation, onOpenMarketplace, onOpenSettings, onOpenUsage, onSignOut,
  projects = [], selectedProjectId, onSelectProject, onCreateProject, hidden = false,
  conversations = [], selectedConversationId, onSelectConversation, onSearch,
  preferences, onPreferencesChange, projectActivity = EMPTY_ACTIVITY, agentActivity = EMPTY_ACTIVITY,
  teams = EMPTY_TEAMS, attention = [], onOpenAttention,
}: {
  agents: MivletAgentProfile[];
  activeAgentId: string;
  previews: Record<string, AgentSidebarPreview>;
  profileName: string;
  connectors: ConnectorManifest[];
  marketplaceActive: boolean;
  onSelectAgent: (agent: MivletAgentProfile) => void;
  onCreateAgent: () => void;
  onNewConversation: () => void;
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
  preferences?: SidebarPreferences;
  onPreferencesChange?: (preferences: SidebarPreferences) => void;
  projectActivity?: ReadonlyMap<string, number>;
  agentActivity?: ReadonlyMap<string, number>;
  teams?: ProjectTeam[];
  attention?: SidebarAttention[];
  onOpenAttention?: (item: SidebarAttention) => void;
}) {
  const [query, setQuery] = useState("");
  const [localPreferences, setLocalPreferences] = useState(DEFAULT_SIDEBAR_PREFERENCES);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionId = useId();
  const settings = preferences ?? localPreferences;
  const sidebar = useRef<HTMLElement>(null);
  const update = (patch: Partial<SidebarPreferences>) => {
    const next = { ...settings, ...patch };
    setLocalPreferences(next);
    onPreferencesChange?.(next);
  };
  const restoreRowFocus = (key: string) => requestAnimationFrame(() => {
    const row = [...(sidebar.current?.querySelectorAll<HTMLElement>("[data-sidebar-entity]") ?? [])]
      .find((row) => row.dataset.sidebarEntity === key);
    row?.querySelector<HTMLElement>(".sidebar-more")?.focus();
  });
  useEffect(() => {
    setQuery("");
    const frame = requestAnimationFrame(() => sidebar.current?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [activeAgentId, selectedProjectId]);
  const [completions, setCompletions] = useState<Record<string, { id: string; unread: boolean }>>({});
  useEffect(() => {
    setCompletions((current) => {
      const next = { ...current };
      let changed = false;
      for (const [id, preview] of Object.entries(previews)) {
        if (preview.status === "running" && next[id]) { delete next[id]; changed = true; }
        else if (preview.presence === "done" && next[id]?.id !== (preview.completionId ?? "completed")) {
          next[id] = { id: preview.completionId ?? "completed", unread: true }; changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [previews]);

  const members = useMemo(() => sidebarProjectMembers(projects, agents, conversations, teams), [projects, agents, conversations, teams]);
  const agentRooms = useMemo(() => {
    const rooms = new Map<string, string>();
    for (const room of conversations) if (!room.projectId && room.kind === "direct" && !room.archived)
      for (const member of room.participants ?? []) rooms.set(member.agentId, room.id);
    return rooms;
  }, [conversations]);
  const entities = new Map<string, SidebarEntity>([
    ...projects.map((item): [string, SidebarEntity] => [`project:${item.id}`, { kind: "project", item }]),
    ...agents.map((item): [string, SidebarEntity] => [`agent:${item.id}`, { kind: "agent", item }]),
  ]);
  const search = query.trim().toLowerCase();
  const matches = (entity: SidebarEntity) => entity.item.name.toLowerCase().includes(search);
  const pinned = settings.pinned.flatMap((pin) => {
    const entity = entities.get(`${pin.kind}:${pin.id}`);
    return entity ? [entity] : [];
  });
  const pinnedKeys = new Set(pinned.map(reference));
  const orderedProjects = orderSidebarItems(projects, settings.projectSort, settings.projectOrder, projectActivity)
    .filter((item) => !pinnedKeys.has(`project:${item.id}`));
  const orderedAgents = orderSidebarItems(agents, settings.agentSort, settings.agentOrder, agentActivity)
    .filter((item) => !pinnedKeys.has(`agent:${item.id}`));
  const projectEntities = orderedProjects.map((item): SidebarEntity => ({ kind: "project", item }));
  const agentEntities = orderedAgents.map((item): SidebarEntity => ({ kind: "agent", item }));
  const searchRooms = search ? conversations.filter((room) => room.title.toLowerCase().includes(search)) : [];
  const installed = connectors.filter((connector) => connector.id !== "local-files" && connector.status === "connected");
  const attentionCount = attention.reduce((total, item) => total + item.count, 0);
  const attentionSummary = (["approval", "input", "blocked"] as const).flatMap((kind) => {
    const count = attention.filter((item) => item.kind === kind).reduce((total, item) => total + item.count, 0);
    return count ? [kind === "approval" ? `${count} approval${count === 1 ? "" : "s"}`
      : kind === "input" ? `${count} waiting for you` : `${count} blocked`] : [];
  }).join(" · ");

  const row = (entity: SidebarEntity, list: SidebarEntity[], isPinned = false) => {
    const key = reference(entity), index = list.findIndex((entry) => reference(entry) === key);
    const agent = entity.kind === "agent" ? entity.item : null;
    const project = entity.kind === "project" ? entity.item : null;
    const preview = agent ? previews[agent.id] : undefined;
    const presence = preview?.presence ?? (preview?.status === "running" ? "working" : preview?.status === "attention" ? "waiting" : "idle");
    const active = !marketplaceActive && (project ? project.id === selectedProjectId
      : agent?.id === activeAgentId && !selectedProjectId && conversations.find((room) => room.id === selectedConversationId)?.kind !== "group");
    const team = project ? members.get(project.id) ?? [] : [];
    const roomId = project?.threadId ?? (agent ? agentRooms.get(agent.id) : undefined);
    const manual = isPinned || (project ? settings.projectSort : settings.agentSort) === "manual";
    const move = (direction: -1 | 1) => {
      const next = moveSidebarItem(list, index, direction);
      update(isPinned ? { pinned: next.map((entry) => ({ kind: entry.kind, id: entry.item.id })) }
        : project ? { projectOrder: next.map((entry) => entry.item.id) } : { agentOrder: next.map((entry) => entry.item.id) });
      restoreRowFocus(key);
    };
    return <div key={key} className={`sidebar-row${active ? " sidebar-row--active" : ""}`} data-sidebar-entity={key}
      onKeyDown={(event) => {
        if (manual && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); move(event.key === "ArrowUp" ? -1 : 1);
        }
      }}>
      <button type="button" className="sidebar-row__select" title={entity.item.name} aria-label={entity.item.name}
        aria-description={project && team.length ? `Agents: ${team.map((member) => member.name).join(", ")}` : undefined}
        aria-current={active ? "page" : undefined} data-conversation-room={roomId}
        onDragStart={(event) => event.preventDefault()} onClick={(event) => {
          if (project) onSelectProject?.(project);
          if (agent) {
            setCompletions((current) => current[agent.id] ? { ...current, [agent.id]: { ...current[agent.id], unread: false } } : current);
            if (roomId && (event.ctrlKey || event.metaKey) && onSelectConversation) onSelectConversation(roomId);
            else onSelectAgent(agent);
          }
        }}>
        {agent ? <ProfileAgentAvatar agent={agent} iconSize={28} presence={presence} motion={presence === "idle" ? "quiet" : "expressive"} />
          : <Folder size={21} aria-hidden="true" className="sidebar-row__folder" />}
        <span className="sidebar-row__name">{entity.item.name}</span>
        {project && team.length > 0 && <span className="sidebar-row__members" aria-hidden="true" title={team.map((member) => member.name).join(", ")}>
          {team.slice(0, 3).map((member) => <ProfileAgentAvatar key={member.id} agent={member} iconSize={17} />)}
          {team.length > 3 && <small aria-hidden="true">+{team.length - 3}</small>}
        </span>}
        {agent && ((preview && preview.status !== "idle") || completions[agent.id]?.unread) && <span
          className={`agent-status agent-status--${preview?.status === "attention" ? "attention" : preview?.status === "running"
            ? presence === "service" ? "service" : presence === "thinking" ? "thinking" : presence === "waiting" || presence === "input" ? "waiting" : "working" : "unread"}`}
          role="status" aria-label={preview && preview.status !== "idle" ? PRESENCE_LABELS[presence] : "New completed work"}>
          {preview?.status === "attention" ? "!" : null}
        </span>}
      </button>
      <div className="sidebar-row__actions"><SidebarMenu label={`Organize ${entity.item.name}`} items={[
        { label: isPinned ? "Unpin" : "Pin", run: () => {
          update({ pinned: isPinned ? settings.pinned.filter((pin) => `${pin.kind}:${pin.id}` !== key)
            : [...settings.pinned, { kind: entity.kind, id: entity.item.id }] });
          restoreRowFocus(key);
        } },
        ...(manual ? [
          { label: "Move up", disabled: index === 0, run: () => move(-1) },
          { label: "Move down", disabled: index === list.length - 1, run: () => move(1) },
        ] : []),
      ]} /></div>
    </div>;
  };

  return <aside ref={sidebar} className="agent-sidebar workspace-sidebar" aria-label="Workspace navigation" hidden={hidden}>
    <div className="agent-sidebar__topline"><Brand className="agent-sidebar__brand" /></div>
    {onSearch ? <button type="button" className="agent-search" onClick={onSearch} aria-label="Search workspace">
      <MagnifyingGlass size={17} aria-hidden="true" /><span>Search workspace</span><span className="agent-search__shortcut" aria-hidden="true">Ctrl K</span>
    </button> : <label className="agent-search">
      <MagnifyingGlass size={17} aria-hidden="true" /><input type="search" aria-label="Search projects, conversations and agents"
        placeholder="Search workspace" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>}
    <button className="sidebar-new-conversation" type="button" onClick={onNewConversation}><Plus size={19} aria-hidden="true" />New conversation</button>
    {attentionCount > 0 && <section className="sidebar-attention" aria-label="Needs you">
      <button className="sidebar-attention__toggle" type="button" aria-expanded={attentionOpen} aria-controls={attentionOpen ? attentionId : undefined} onClick={() => setAttentionOpen(!attentionOpen)}>
        <span><strong>Needs you <span className="sidebar-attention__count">{attentionCount}</span></strong><small>{attentionSummary}</small></span><CaretDown size={14} aria-hidden="true" />
      </button>
      {attentionOpen && <div id={attentionId} className="sidebar-attention__list">{attention.map((item) => <button type="button" key={item.id}
        onClick={() => onOpenAttention ? onOpenAttention(item) : onSelectConversation?.(item.conversationId)}>
        <strong>{item.label}</strong><small>{item.detail}</small>
      </button>)}</div>}
    </section>}
    <nav className="sidebar-sections" aria-label="Projects and agents">
      {pinned.some(matches) && <section className="sidebar-section sidebar-section--pinned" aria-label="Pinned">
        <h2 className="sidebar-section__heading">Pinned</h2>
        <div className="sidebar-section__list">{pinned.filter(matches).map((entity) => row(entity, pinned, true))}</div>
      </section>}
      <SidebarSection title="Projects" collapsed={!search && settings.projectsCollapsed} onToggle={() => update({ projectsCollapsed: !settings.projectsCollapsed })}
        sort={settings.projectSort} onSort={(sort) => update({ projectSort: sort,
          ...(sort === "manual" && !settings.projectOrder.length ? { projectOrder: orderedProjects.map((item) => item.id) } : {}) })}
        onCreate={onCreateProject}>
        {projectEntities.filter(matches).map((entity) => row(entity, projectEntities))}
        {!projects.length && <p className="sidebar-section__empty">Projects keep related chats together.</p>}
      </SidebarSection>
      <SidebarSection title="Agents" collapsed={!search && settings.agentsCollapsed} onToggle={() => update({ agentsCollapsed: !settings.agentsCollapsed })}
        sort={settings.agentSort} onSort={(sort) => update({ agentSort: sort,
          ...(sort === "manual" && !settings.agentOrder.length ? { agentOrder: orderedAgents.map((item) => item.id) } : {}) })}
        onCreate={onCreateAgent}>
        {agentEntities.filter(matches).map((entity) => row(entity, agentEntities))}
        {!agents.length && <p className="sidebar-section__empty">Create your first agent to get started.</p>}
      </SidebarSection>
      {searchRooms.length > 0 && <section className="sidebar-section" aria-label="Matching chats">
        <h2 className="sidebar-section__heading">Chats</h2>
        <div className="sidebar-section__list">{searchRooms.map((room) => <button type="button" key={room.id}
          className="sidebar-search-result" aria-current={room.id === selectedConversationId && !marketplaceActive ? "page" : undefined}
          onClick={() => onSelectConversation?.(room.id)}>{room.title}</button>)}</div>
      </section>}
      {search && ![...entities.values()].some(matches) && !searchRooms.length && <p className="sidebar-section__empty">No matching projects, chats or agents.</p>}
    </nav>
    <button className={`agent-sidebar__connections${marketplaceActive ? " agent-sidebar__connections--active" : ""}`} type="button"
      onClick={onOpenMarketplace} aria-current={marketplaceActive ? "page" : undefined}>
      <span className="agent-sidebar__plugins-icon"><PluginsIcon size={21} /></span><span>Plugins</span>
      {installed.length > 0 && <span className="agent-sidebar__connector-stack" aria-label={`${installed.length} installed`}>
        {installed.slice(0, 3).map((connector) => <span key={connector.id} title={connector.name}><ConnectorIcon id={connector.id} /></span>)}
      </span>}
    </button>
    <AccountMenu name={profileName} onUsage={onOpenUsage} onSettings={onOpenSettings} onSignOut={onSignOut} />
  </aside>;
}
