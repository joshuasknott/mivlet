import { useEffect, useRef, useState } from "react";
import type { CollaborationWorkItem, MivletAgentProfile, WorkStatus } from "@mivlet/protocol";
import { X } from "@phosphor-icons/react/dist/csr/X";

const messages: Partial<Record<WorkStatus, string>> = {
  failed: "could not finish", blocked: "needs your attention",
  "awaiting-user": "needs your input", "awaiting-approval": "needs your approval",
};
type Notice = { id: string; agentId: string; conversationId: string; message: string };

/** Session-local notices. Historical work never replays on workspace hydration. */
export function AgentNotifications({ agents, work, onOpen }: {
  agents: MivletAgentProfile[];
  work: CollaborationWorkItem[];
  onOpen: (conversationId: string) => void;
}) {
  const previous = useRef(new Map<string, WorkStatus>());
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    const next: Notice[] = [];
    for (const item of work) {
      const before = previous.current.get(item.id);
      const agent = agents.find(agent => agent.id === item.agentId);
      if (before && before !== item.status && messages[item.status] && agent && agent.notificationsEnabled !== false) {
        next.push({ id: item.id, agentId: agent.id, conversationId: item.conversationId, message: `${agent.name} ${messages[item.status]}.` });
      }
    }
    previous.current = new Map(work.map(item => [item.id, item.status]));
    setNotices(current => {
      const retained = current.filter(notice => agents.some(agent => agent.id === notice.agentId && agent.notificationsEnabled !== false)
        && !next.some(item => item.id === notice.id));
      return next.length || retained.length !== current.length ? [...retained, ...next].slice(-3) : current;
    });
  }, [agents, work]);
  const dismiss = (id: string) => setNotices(current => current.filter(notice => notice.id !== id));
  return <div className="agent-notifications" aria-live="polite" aria-relevant="additions text">
    {notices.filter(notice => agents.some(agent => agent.id === notice.agentId && agent.notificationsEnabled !== false)).map(notice =>
      <div className="agent-notification" key={notice.id}>
        <span>{notice.message}</span>
        <button type="button" onClick={() => { onOpen(notice.conversationId); dismiss(notice.id); }}>View</button>
        <button type="button" aria-label={`Dismiss: ${notice.message}`} onClick={() => dismiss(notice.id)}><X size={16} /></button>
      </div>)}
  </div>;
}
