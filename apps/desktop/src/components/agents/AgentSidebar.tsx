import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import type { ConnectorManifest, FableAgentProfile } from "@fable/protocol";
import { ConnectorIcon } from "../ConnectorIcon";
import { ProfileAgentAvatar } from "./agent-icons";
import { AccountMenu } from "./AccountMenu";
import fableMark from "../../assets/fable-mark.png";

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
  connectors,
  marketplaceActive,
  onSelectAgent,
  onCreateAgent,
  onEditAgent,
  onOpenMarketplace,
  onOpenSettings,
  onOpenUsage,
  onSignOut,
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
}) {
  const installedConnectors = connectors.filter(
    (connector) =>
      connector.id !== "local-files" && connector.status === "connected",
  );

  return (
    <aside className="agent-sidebar" aria-label="Agents">
      <div className="agent-sidebar__topline">
        <img className="fable-mark" src={fableMark} alt="Fable" width={32} height={32} />
        <button
          className="agent-sidebar__new"
          type="button"
          onClick={onCreateAgent}
          aria-label="Create teammate"
          title="Create teammate"
        >
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="agent-list" role="list">
        {agents.map((agent) => {
          const active = agent.id === activeAgentId && !marketplaceActive;
          const preview = previews[agent.id] ?? {
            message: "Start a conversation",
            time: "",
            status: "idle" as const,
          };
          return (
            <div
              key={agent.id}
              className={`agent-row${active ? " agent-row--active" : ""}`}
              role="listitem"
            >
              <button
                className="agent-row__select"
                type="button"
                onClick={() => onSelectAgent(agent)}
                aria-current={active ? "page" : undefined}
              >
                <ProfileAgentAvatar agent={agent} iconSize={32} />
                <span className="agent-row__copy">
                  <span className="agent-row__line">
                    <strong>{agent.name}</strong>
                    <span>{preview.time}</span>
                  </span>
                  <span className="agent-row__preview">{preview.message}</span>
                </span>
                {preview.status !== "idle" ? (
                  <span
                    className={`agent-status agent-status--${preview.status}`}
                    aria-label={
                      preview.status === "running"
                        ? "Active"
                        : "Needs attention"
                    }
                  />
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
      </div>

      <button
        className={`agent-sidebar__connections${marketplaceActive ? " agent-sidebar__connections--active" : ""}`}
        type="button"
        onClick={onOpenMarketplace}
        aria-current={marketplaceActive ? "page" : undefined}
      >
        <PlugsConnected size={16} aria-hidden="true" />
        <span>Connectors</span>
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

      <AccountMenu name={profileName} onUsage={onOpenUsage} onSettings={onOpenSettings} onSignOut={onSignOut} />
    </aside>
  );
}
