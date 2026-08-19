import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

export function AgentWorkspaceHeader({
  agent,
  modelLabel,
  liveRailOpen,
  onEdit,
  onToggleLiveRail
}: {
  agent: FableAgentProfile;
  modelLabel: string;
  liveRailOpen: boolean;
  onEdit: () => void;
  onToggleLiveRail: () => void;
}) {
  const routeLabel = agent.modelId
    ? modelLabel
    : modelLabel === "Select model"
      ? "Auto"
      : `Auto · ${modelLabel}`;

  return (
    <header className="agent-workspace-header">
      <div className="agent-workspace-header__identity">
        <ProfileAgentAvatar agent={agent} iconSize={34} />
        <span>
          <strong>{agent.name}</strong>
          <small>{routeLabel}</small>
        </span>
      </div>
      <div>
        <button type="button" onClick={onEdit} aria-label={`Edit ${agent.name}`}><DotsThree size={19} weight="bold" /></button>
        <button type="button" className={liveRailOpen ? "is-active" : ""} onClick={onToggleLiveRail} aria-label="Toggle live work"><SidebarSimple size={18} /></button>
      </div>
    </header>
  );
}
