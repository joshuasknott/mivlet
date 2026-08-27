import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { GraduationCap } from "@phosphor-icons/react/dist/csr/GraduationCap";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

export function AgentWorkspaceHeader({
  agent,
  canTeamUp,
  teamUpOpen,
  onTeamUp,
  learnedCount,
  learnedOpen,
  onOpenLearned,
  attentionCount,
  liveRailOpen,
  onToggleLiveRail
}: {
  agent: FableAgentProfile;
  canTeamUp: boolean;
  teamUpOpen: boolean;
  onTeamUp: () => void;
  learnedCount: number;
  learnedOpen: boolean;
  onOpenLearned: () => void;
  attentionCount: number;
  liveRailOpen: boolean;
  onToggleLiveRail: () => void;
}) {
  return (
    <header className="agent-workspace-header">
      <div className="agent-workspace-header__identity">
        <ProfileAgentAvatar agent={agent} iconSize={22} />
        <strong>{agent.name}</strong>
      </div>
      <div className="agent-workspace-header__actions">
        <button
          type="button"
          className={learnedOpen ? "is-active" : ""}
          onClick={onOpenLearned}
          aria-label={`Learned work${learnedCount ? `, ${learnedCount}` : ""}`}
          title={learnedCount ? `${learnedCount} learned ${learnedCount === 1 ? "responsibility" : "responsibilities"}` : "Learned work"}
        ><GraduationCap size={18} /><span className="agent-workspace-header__count">{learnedCount || ""}</span></button>
        <button
          type="button"
          className={teamUpOpen ? "is-active" : ""}
          onClick={onTeamUp}
          disabled={!canTeamUp}
          aria-label="Bring in teammates"
          title={canTeamUp ? "Bring in teammates" : "Create another teammate first"}
        ><UsersThree size={18} /></button>
        <button
          type="button"
          className={liveRailOpen ? "is-active" : ""}
          onClick={onToggleLiveRail}
          aria-label={attentionCount ? `Toggle live work, ${attentionCount} needs attention` : "Toggle live work"}
          title={attentionCount ? `${attentionCount} approval${attentionCount === 1 ? "" : "s"} waiting` : "Live work"}
        >
          <SidebarSimple size={18} />
          {attentionCount ? <span className="agent-workspace-header__count agent-workspace-header__count--attention">{attentionCount}</span> : null}
        </button>
      </div>
    </header>
  );
}
