import type { CollaborationWorkItem, MivletAgentProfile } from "@mivlet/protocol";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { WorkStatusBadge } from "./WorkStatusBadge";
import "./work.css";
import { displayWorkspaceMentions } from "../../lib/collaboration-mentions";

/** Conversation history backed by durable execution records. */
export function CoordinationActivity({ work, agents, onInspect, onStop, onFollowUp }: {
  work: CollaborationWorkItem[];
  agents: MivletAgentProfile[];
  onInspect: (id: string) => void;
  onStop: (id: string) => void;
  onFollowUp: (agentId: string, name: string, workId: string) => void;
}) {
  if (!work.length) return <p className="right-panel__empty">No history for this conversation yet.</p>;
  const unfinished = work.filter(item => !["completed", "failed", "cancelled"].includes(item.status));
  const roots = work.filter(item => !item.parentId);
  return <div className="coordination-activity">
    <p>{unfinished.length ? `${unfinished.length} active` : `${work.length} ${work.length === 1 ? "assignment" : "assignments"}`}</p>
    <p className="coordination-runtime-note">Work continues while Mivlet is running and Windows is awake. Interrupted work needs review after restart.</p>
    {roots.map(root => <section key={root.id} className="coordination-effort" aria-label={`Request: ${root.userRequest}`}>
      <header><span>{displayWorkspaceMentions(root.userRequest)}</span>{work.some(item => item.rootId === root.id && !["completed", "cancelled"].includes(item.status)) ? <button type="button" onClick={() => onStop(root.id)}>Stop effort</button> : null}</header>
      <ul>{work.filter(item => item.rootId === root.id).map(item => {
        const profile = agents.find(agent => agent.id === item.agentId);
        return <li key={item.id}>
          <div className="coordination-assignee">{profile ? <ProfileAgentAvatar agent={profile} iconSize={23} /> : null}<strong>{item.agentName}</strong><WorkStatusBadge item={item} /></div>
          <p>{displayWorkspaceMentions(item.prompt)}</p>
          {item.reason ? <p className="coordination-blocker">{item.reason}</p> : null}
          {item.messages?.length ? <details><summary>{item.messages.length} task messages</summary><ol>{item.messages.map(message => <li key={message.id}>
            <strong>{agents.find(agent => agent.id === message.fromAgentId)?.name ?? "Historical agent"}{message.question ? " asked" : " replied"}</strong>
            <p>{message.text}</p>
          </li>)}</ol></details> : null}
          <div className="coordination-actions">
            <button type="button" onClick={() => onInspect(item.id)}>Details</button>
            {profile && !["failed", "cancelled"].includes(item.status) ? <button type="button" onClick={() => onFollowUp(item.agentId, profile.name, item.id)}>Follow up</button> : null}
            {!["completed", "cancelled"].includes(item.status) ? <button type="button" onClick={() => onStop(item.id)}>Cancel assignment</button> : null}
          </div>
        </li>;
      })}</ul>
    </section>)}
  </div>;
}
