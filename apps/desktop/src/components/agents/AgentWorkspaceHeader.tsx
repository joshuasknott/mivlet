import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { WorkspaceMenu } from "./WorkspaceMenu";
import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";
import { presenceLabel, type AgentPresence } from "../../lib/agent-presence";

export function AgentWorkspaceHeader({
  agent,
  attentionCount,
  panelOpen,
  onTogglePanel,
  onBack,
  presence = "idle",
  activity,
  computerActive = false,
  onSchedules,
  activityKey,
}: {
  agent: FableAgentProfile;
  attentionCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onBack?: () => void;
  presence?: AgentPresence;
  activity?: string;
  computerActive?: boolean;
  onSchedules?: () => void;
  activityKey?: string;
}) {
  return (
    <header className="agent-workspace-header">
      {onBack ? <button className="agent-workspace-header__back" type="button" onClick={onBack} aria-label="Back to agents"><CaretLeft size={20} /></button> : null}
      <div className="agent-workspace-header__identity">
        <ProfileAgentAvatar agent={agent} iconSize={36} presence={presence} activityKey={activityKey} motion="expressive" />
        <div className="agent-workspace-header__copy">
          <strong>{agent.name}</strong>
          {presence !== "idle" && presence !== "done" ? <span className="agent-workspace-header__presence" data-presence={presence} role="status" title={presenceLabel(presence, activity)}>{presenceLabel(presence, activity)}</span> : <span className="sr-only" role="status">{presenceLabel(presence, activity)}</span>}
        </div>
      </div>
      <div className="agent-workspace-header__actions">
        {onSchedules ? <WorkspaceMenu onSchedules={onSchedules} /> : null}
        <button
          type="button"
          data-work-panel-toggle
          className={`${panelOpen ? "is-active" : ""}${computerActive ? " is-working" : ""}`}
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          aria-label={
            panelOpen ? "Close agent computer" : attentionCount
              ? `Open work panel, ${attentionCount} needs attention`
              : "Open agent computer"
          }
          title={
            attentionCount
              ? `${attentionCount} approval${attentionCount === 1 ? "" : "s"} waiting`
              : "Agent computer"
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
