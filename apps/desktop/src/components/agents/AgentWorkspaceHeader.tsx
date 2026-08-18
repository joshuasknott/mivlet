import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

export function AgentWorkspaceHeader({
  agent,
  liveRailOpen,
  onEdit,
  onToggleLiveRail
}: {
  agent: FableAgentProfile;
  liveRailOpen: boolean;
  onEdit: () => void;
  onToggleLiveRail: () => void;
}) {
  return (
    <header className="agent-workspace-header">
      <div><ProfileAgentAvatar agent={agent} iconSize={24} /><strong>{agent.name}</strong></div>
      <div>
        <button type="button" onClick={onEdit} aria-label={`Edit ${agent.name}`}><DotsThree size={19} weight="bold" /></button>
        <button type="button" className={liveRailOpen ? "is-active" : ""} onClick={onToggleLiveRail} aria-label="Toggle live work"><SidebarSimple size={18} /></button>
      </div>
    </header>
  );
}
