import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import type { FableAgentProfile } from "@fable/protocol";
import { useMemo, useState } from "react";
import { ProfileAgentAvatar } from "./agent-icons";

export interface AgentSidebarPreview {
  message: string;
  time: string;
  status: "idle" | "running" | "attention";
}

export function AgentSidebar({
  agents,
  activeAgentId,
  previews,
  workspaceName,
  profileName,
  onSelectAgent,
  onCreateAgent,
  onEditAgent,
  onOpenKnowledge,
  onOpenConnectors,
  onOpenSettings
}: {
  agents: FableAgentProfile[];
  activeAgentId: string;
  previews: Record<string, AgentSidebarPreview>;
  workspaceName: string;
  profileName: string;
  onSelectAgent: (agent: FableAgentProfile) => void;
  onCreateAgent: () => void;
  onEditAgent: (agent: FableAgentProfile) => void;
  onOpenKnowledge: () => void;
  onOpenConnectors: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const visibleAgents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? agents.filter((agent) => agent.name.toLocaleLowerCase().includes(normalized))
      : agents;
  }, [agents, query]);

  return (
    <aside className="agent-sidebar" aria-label="Agents">
      <div className="agent-sidebar__topline">
        <span className="agent-sidebar__workspace" title={workspaceName}>{workspaceName}</span>
        <button className="agent-sidebar__create" type="button" onClick={onCreateAgent} aria-label="Create agent">
          <Plus size={17} weight="bold" aria-hidden="true" />
        </button>
      </div>

      <label className="agent-search">
        <MagnifyingGlass size={14} aria-hidden="true" />
        <span className="sr-only">Search agents</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" />
      </label>

      <div className="agent-list" role="list">
        {visibleAgents.map((agent) => {
          const active = agent.id === activeAgentId;
          const preview = previews[agent.id] ?? { message: "Start a conversation", time: "", status: "idle" as const };
          return (
            <div key={agent.id} className={`agent-row${active ? " agent-row--active" : ""}`} role="listitem">
              <button className="agent-row__select" type="button" onClick={() => onSelectAgent(agent)} aria-current={active ? "page" : undefined}>
                <ProfileAgentAvatar agent={agent} iconSize={27} />
                <span className="agent-row__copy">
                  <span className="agent-row__line">
                    <strong>{agent.name}</strong>
                    <span>{preview.time}</span>
                  </span>
                  <span className="agent-row__preview">{preview.message}</span>
                </span>
                {preview.status !== "idle" ? <span className={`agent-status agent-status--${preview.status}`} aria-label={preview.status === "running" ? "Active" : "Needs attention"} /> : null}
              </button>
              <button className="agent-row__edit" type="button" onClick={() => onEditAgent(agent)} aria-label={`Edit ${agent.name}`}>
                <NotePencil size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {visibleAgents.length === 0 ? <p className="agent-list__empty">No agents match that search.</p> : null}
      </div>

      <div className="agent-sidebar__utilities">
        <button type="button" onClick={onOpenKnowledge}><Stack size={16} aria-hidden="true" /><span>Knowledge</span></button>
        <button type="button" onClick={onOpenConnectors}><Plugs size={16} aria-hidden="true" /><span>Connectors</span></button>
      </div>

      <button className="agent-sidebar__profile" type="button" onClick={onOpenSettings}>
        <span className="agent-sidebar__profile-avatar">{profileName.trim().slice(0, 1).toUpperCase() || "F"}</span>
        <span>{profileName}</span>
        <Gear size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
