import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { GraduationCap } from "@phosphor-icons/react/dist/csr/GraduationCap";
import { PlusCircle } from "@phosphor-icons/react/dist/csr/PlusCircle";
import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

export function AgentWorkspaceHeader({
  agent,
  learnedCount,
  learnedOpen,
  onOpenLearned,
  newConversationDisabled,
  onNewConversation,
  attentionCount,
  panelOpen,
  onTogglePanel,
}: {
  agent: FableAgentProfile;
  learnedCount: number;
  learnedOpen: boolean;
  onOpenLearned: () => void;
  newConversationDisabled: boolean;
  onNewConversation: () => void;
  attentionCount: number;
  panelOpen: boolean;
  onTogglePanel: () => void;
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
          disabled={newConversationDisabled}
          onClick={onNewConversation}
          aria-label="New conversation"
          title="New conversation"
        >
          <PlusCircle size={18} />
        </button>
        <button
          type="button"
          className={learnedOpen ? "is-active" : ""}
          onClick={onOpenLearned}
          aria-label={`Learned work${learnedCount ? `, ${learnedCount}` : ""}`}
          title={
            learnedCount
              ? `${learnedCount} learned ${learnedCount === 1 ? "responsibility" : "responsibilities"}`
              : "Learned work"
          }
        >
          <GraduationCap size={18} />
          <span className="agent-workspace-header__count">
            {learnedCount || ""}
          </span>
        </button>
        <button
          type="button"
          className={panelOpen ? "is-active" : ""}
          onClick={onTogglePanel}
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
