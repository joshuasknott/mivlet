import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { FableAgentProfile } from "@fable/protocol";

export function AgentWorkspaceHeader({
  agent,
  attentionCount,
  panelOpen,
  onTogglePanel,
}: {
  agent: FableAgentProfile;
  attentionCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  return (
    <header className="agent-workspace-header">
      <div className="agent-workspace-header__identity">
        <strong>{agent.name}</strong>
      </div>
      <div className="agent-workspace-header__actions">
        <button
          type="button"
          className={panelOpen ? "is-active" : ""}
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          aria-label={
            attentionCount
              ? `Open work panel, ${attentionCount} needs attention`
              : "Open teammate computer"
          }
          title={
            attentionCount
              ? `${attentionCount} approval${attentionCount === 1 ? "" : "s"} waiting`
              : "Teammate computer"
          }
        >
          <SidebarSimple size={18} />
          {attentionCount ? (
            <span className="agent-workspace-header__count agent-workspace-header__count--attention">
              {attentionCount}
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
