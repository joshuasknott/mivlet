import type { MivletAgentProfile } from "@mivlet/protocol";
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import type { AgentPresence } from "../lib/agent-presence";

export function ConversationIdentity({ agent, presence, name, settingsLabel, disabled, sideChat, onOpen }: {
  agent: MivletAgentProfile;
  presence: AgentPresence;
  name: string;
  settingsLabel: string;
  disabled: boolean;
  sideChat: boolean;
  onOpen: () => void;
}) {
  return <div className="team-conversation-identity">
    <span className="team-conversation-title">
      <button type="button" className="team-agent-settings-trigger" disabled={disabled} aria-label={settingsLabel} onClick={onOpen}>
        <ProfileAgentAvatar agent={agent} iconSize={29} presence={presence} />
        <strong>{name}</strong>
      </button>
      {sideChat ? <small className="side-chat-marker">Side Chat · separate conversation</small> : null}
    </span>
  </div>;
}
