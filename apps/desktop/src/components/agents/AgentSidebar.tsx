import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import type { FableAgentProfile } from "@fable/protocol";
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
  onOpenSearch,
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
  onOpenSearch: () => void;
  onEditAgent: (agent: FableAgentProfile) => void;
  onOpenKnowledge: () => void;
  onOpenConnectors: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="agent-sidebar" aria-label="Agents">
      <div className="agent-sidebar__topline">
        <span className="agent-sidebar__workspace" title={workspaceName}>{workspaceName}</span>
      </div>

      <div className="agent-sidebar__actions">
        <button className="agent-sidebar__new" type="button" onClick={onCreateAgent}>
          <Plus size={16} weight="bold" aria-hidden="true" />
          <span>New agent</span>
        </button>
        <button className="agent-search" type="button" onClick={onOpenSearch} aria-label="Search">
          <MagnifyingGlass size={15} aria-hidden="true" />
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>

      <div className="agent-sidebar__section-label">Agents</div>

      <div className="agent-list" role="list">
        {agents.map((agent) => {
          const active = agent.id === activeAgentId;
          const preview = previews[agent.id] ?? { message: "Start a conversation", time: "", status: "idle" as const };
          return (
            <div key={agent.id} className={`agent-row${active ? " agent-row--active" : ""}`} role="listitem">
              <button className="agent-row__select" type="button" onClick={() => onSelectAgent(agent)} aria-current={active ? "page" : undefined}>
                <ProfileAgentAvatar agent={agent} iconSize={32} />
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
        {agents.length === 0 ? <p className="agent-list__empty">Create your first agent to get started.</p> : null}
      </div>

      <div className="agent-sidebar__utilities">
        <button type="button" onClick={onOpenKnowledge}><Stack size={16} aria-hidden="true" /><span>Knowledge</span></button>
        <button type="button" onClick={onOpenConnectors}><Plugs size={16} aria-hidden="true" /><span>Connections</span></button>
      </div>

      <button className="agent-sidebar__profile" type="button" onClick={onOpenSettings}>
        <span className="agent-sidebar__profile-avatar">{profileName.trim().slice(0, 1).toUpperCase() || "F"}</span>
        <span>{profileName}</span>
        <Gear size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
