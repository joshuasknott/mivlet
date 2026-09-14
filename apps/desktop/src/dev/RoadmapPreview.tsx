import { useState } from "react";
import type { CollaborationWorkItem, ConversationRoom, FableAgentProfile } from "@fable/protocol";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { WorkspaceRightNav } from "../components/navigation/WorkspaceRightNav";
import { WorkDetails } from "../components/work/WorkDetails";
import { SideChatList } from "../components/conversation/SideChats";
import { SearchOverlay } from "../components/search/SearchOverlay";
import "../shell/teammate-workspace.css";

/** Component-only QA fixture: no account, schedule, provider or native actions. */
export function RoadmapPreview({ agent }: { agent: FableAgentProfile }) {
  const [panel, setPanel] = useState(true);
  const [search, setSearch] = useState(false);
  const [notice, setNotice] = useState("Sample Work · no provider is running");
  const [rooms, setRooms] = useState<ConversationRoom[]>([{ id: "side", workspaceId: "preview", title: "Check the launch assumptions", kind: "direct", chat: { role: "side", ownerKind: "agent", ownerId: agent.id }, participants: [{ agentId: agent.id, name: agent.name }], revision: 1, generation: 1, createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" }]);
  const work: CollaborationWorkItem = { id: "work", rootId: "work", workspaceId: "preview", conversationId: "side", agentId: agent.id, agentName: agent.name, modelOptionId: agent.modelId, prompt: "Review the launch plan and summarize the risks", userRequest: "Review the launch plan and summarize the risks", status: "awaiting-user", reason: "Confirm the proposed launch date", permissionMode: "read-only", dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: true, generation: 2, conversationGeneration: 1, contextRevision: 1, depth: 0, turnCount: 2, tokenUsage: 400, maxTurns: 12, maxTokens: 64000, runIds: ["sample-run"], outputs: [{ runId: "sample-run", conversationId: "side", text: "The plan is ready for review. Confirm the date before sending invitations.", evidence: "agent-report", createdAt: "2026-09-14T00:00:00Z" }], createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" };
  const runtime = { agents: [agent], managedMemoryRecords: [], connectorManifests: [] } as unknown as ShellRuntime;
  return <main className="roadmap-preview">
    <style>{`.roadmap-preview { --team-border: #ddd9d0; --team-muted: #777; display: grid; grid-template-columns: minmax(0,1fr) 300px; height: 100dvh; } @media(max-width:850px) { .roadmap-preview { grid-template-columns: minmax(0,1fr); } }`}</style><section style={{ minWidth: 0, flex: 1, overflow: "auto", padding: 20 }}>
      <nav><button onClick={() => setSearch(true)}>Search workspace</button><button onClick={() => setPanel(!panel)}>Context</button></nav>
      <p role="status">{notice}</p>
      <WorkDetails item={work} onOpen={() => setNotice("Opened existing Chat")} onStop={async () => setNotice("Sample Stop")} onContinue={async () => setNotice("Sample continuation")} onSteer={async () => setNotice("Sample steering")} onPromote={async () => setNotice("Sample promotion")} />
    </section>
    <WorkspaceRightNav context={{ kind: "agent", agent }} rooms={rooms} work={[work]} runtime={runtime} open={panel} onClose={() => setPanel(false)} onOpenConversation={() => setNotice("Opened existing Side Chat")} sideChats={<SideChatList chats={rooms} owner={{ kind: "agent", id: agent.id }} ownerName={agent.name} onOpen={() => setNotice("Opened existing Side Chat")} onCreate={async title => setRooms(current => [...current, { ...rooms[0], id: crypto.randomUUID(), title }])} onRename={async (room, title) => setRooms(current => current.map(item => item.id === room.id ? { ...item, title } : item))} onArchive={async (room, archived) => setRooms(current => current.map(item => item.id === room.id ? { ...item, archived } : item))} onDelete={async room => setRooms(current => current.filter(item => item.id !== room.id))} />} />
    <SearchOverlay workspaceId="preview" open={search} onClose={() => setSearch(false)} onOpenResult={() => {}} />
  </main>;
}
