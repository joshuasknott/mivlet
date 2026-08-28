import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
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
  profileName,
  onSelectAgent,
  onCreateAgent,
  onEditAgent,
  onOpenSettings
}: {
  agents: FableAgentProfile[];
  activeAgentId: string;
  previews: Record<string, AgentSidebarPreview>;
  profileName: string;
  onSelectAgent: (agent: FableAgentProfile) => void;
  onCreateAgent: () => void;
  onEditAgent: (agent: FableAgentProfile) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="agent-sidebar" aria-label="Agents">
      <div className="agent-sidebar__topline">
        <button className="agent-sidebar__new" type="button" onClick={onCreateAgent} aria-label="Create teammate" title="Create teammate">
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>

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

      <button className="agent-sidebar__profile" type="button" onClick={onOpenSettings}>
        <span className="agent-sidebar__profile-avatar">{profileName.trim().slice(0, 1).toUpperCase() || "F"}</span>
        <span>{profileName}</span>
        <Gear size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}
