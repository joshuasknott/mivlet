import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { useEffect, useState } from "react";
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
}) {
  const [query, setQuery] = useState("");
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
  const normalizedQuery = query.trim().toLowerCase();
  const visibleAgents = agents.filter((agent) =>
    `${agent.name} ${previews[agent.id]?.message ?? ""}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const visibleProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(normalizedQuery),
  );
  const installedConnectors = connectors.filter(
    (connector) =>
      connector.id !== "local-files" && connector.status === "connected",
  );

  return (
    <aside className="agent-sidebar" aria-label="Agents" hidden={hidden}>
      <div className="agent-sidebar__topline">
        <span className="agent-sidebar__title">Fable</span>
      </div>

      <label className="agent-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search projects and agents"
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
                <button
                  key={project.id}
                  type="button"
                  className={`project-sidebar-row${active ? " project-sidebar-row--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelectProject?.(project)}
                >
                  <span
                    className="project-sidebar-row__icon"
                    aria-hidden="true"
                  >
                    <FolderSimple size={19} />
                  </span>
                  <span>
                    <strong title={project.name}>{project.name}</strong>
                    <small>Shared with all agents</small>
                  </span>
                </button>
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
            !selectedProjectId;
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
              className={`agent-row${active ? " agent-row--active" : ""}`}
              role="listitem"
            >
              <button
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
                  onSelectAgent(agent);
                }}
                aria-current={active ? "page" : undefined}
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
              <button
                className="agent-row__edit"
                type="button"
                onClick={() => onEditAgent(agent)}
                aria-label={`Edit ${agent.name}`}
              >
                <NotePencil size={14} aria-hidden="true" />
              </button>
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
      </div>

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
