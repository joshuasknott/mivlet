import { useState } from "react";
import type { ConversationVoice, FableAgentProfile, VoiceConversationPhase } from "@fable/protocol";
import { INITIAL_CONVERSATION_STATE } from "@fable/connectors/voice";
import { VoiceConversationView } from "../components/voice/VoiceConversationView";
import { AgentSidebar } from "../components/agents/AgentSidebar";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";
import { WindowControls } from "../components/WindowControls";
import { useMediaQuery } from "../hooks/useMediaQuery";

const noop = () => {};
const agent: FableAgentProfile = { id: "voice-preview", name: "Chief of Staff", icon: "agent", iconColor: "#d37d67", instructions: "", modelId: "preview", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };

/** Labelled component fixtures. No microphone, provider calls or audio playback. */
export function VoiceConversationPreview() {
  const isPhone = useMediaQuery("(max-width: 700px)");
  const [phase, setPhase] = useState<VoiceConversationPhase>("ready");
  const [muted, setMuted] = useState(false);
  const [voice, setVoice] = useState<ConversationVoice>("marin");
  const [approval, setApproval] = useState(false);
  const [missingProvider, setMissingProvider] = useState(false);
  return <main className="desktop-frame desktop-frame--agents desktop-frame--live-closed" data-mobile-view="conversation">
    <WindowControls preview />
    <AgentSidebar hidden={isPhone} agents={[agent]} activeAgentId={agent.id} previews={{}} profileName="Preview" connectors={[]} marketplaceActive={false} onSelectAgent={noop} onCreateAgent={noop} onEditAgent={noop} onOpenMarketplace={noop} onOpenSettings={noop} onOpenUsage={noop} onSignOut={noop} />
    <section className="workspace agent-workspace" style={{ gridTemplateRows: "56px auto minmax(0, 1fr)" }}>
      <AgentWorkspaceHeader agent={agent} attentionCount={approval ? 1 : 0} panelOpen={false} onTogglePanel={noop} onVoice={() => setPhase("ready")} voiceOpen />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "6px 16px", fontSize: 10, color: "var(--ink-muted)", borderBottom: "1px solid var(--line)" }} aria-label="Voice preview controls">
        <span>Sample states · No microphone or audio</span>
        <select aria-label="Preview voice state" value={phase} onChange={(event) => setPhase(event.target.value as VoiceConversationPhase)}>
          {["ready", "connecting", "listening", "hearing", "transcribing", "thinking", "speaking", "paused", "error", "ended"].map((value) => <option key={value}>{value}</option>)}
        </select>
        <label><input type="checkbox" checked={approval} onChange={(event) => setApproval(event.target.checked)} /> Approval</label>
        <label><input type="checkbox" checked={missingProvider} onChange={(event) => setMissingProvider(event.target.checked)} /> Missing provider</label>
      </div>
      <VoiceConversationView agent={agent} modelLabel="Your selected model" state={{ ...INITIAL_CONVERSATION_STATE, phase, muted, startedAt: phase === "ready" ? null : Date.now() - 83_000, userCaption: phase === "ready" ? "" : "Can you help me think through what to focus on today?", agentCaption: ["speaking", "thinking"].includes(phase) ? "Let's start with what matters most. What's the one thing you'd feel good about finishing today?" : "", error: phase === "error" ? "Your microphone disconnected. Please reconnect voice." : null }}
        voice={voice} onVoiceChange={setVoice} onStart={() => setPhase("listening")} onClose={() => setPhase("ended")} onMute={() => setMuted((value) => !value)} onInterrupt={() => setPhase("listening")} onFinishTurn={() => setPhase("transcribing")} onOpenProviders={noop}
        unavailable={missingProvider ? "Connect an OpenAI API account for speech. This is separate from a ChatGPT subscription." : undefined}
        approvals={approval ? <div className="conversation-attention"><strong>Approve opening your calendar</strong><p>Sample approval. The production call shows Mivlet's existing approval controls here.</p><button type="button" onClick={() => setApproval(false)}>Dismiss sample</button></div> : undefined}
      />
    </section>
  </main>;
}
