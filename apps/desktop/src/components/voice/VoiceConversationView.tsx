import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { ConversationVoice, MivletAgentProfile, VoiceConversationState } from "@mivlet/protocol";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { MicrophoneSlash } from "@phosphor-icons/react/dist/csr/MicrophoneSlash";
import { PhoneDisconnect } from "@phosphor-icons/react/dist/csr/PhoneDisconnect";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Subtitles } from "@phosphor-icons/react/dist/csr/Subtitles";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import "../../styles/voice-conversation.css";

const labels: Record<VoiceConversationState["phase"], string> = {
  ready: "Ready to talk", connecting: "Connecting your microphone…", listening: "I'm listening", hearing: "Go on, I'm listening", transcribing: "One moment…", thinking: "Thinking…", speaking: "Speaking", paused: "Microphone paused", error: "Voice disconnected", ended: "Voice ended",
};

export interface VoiceConversationViewProps {
  agent: MivletAgentProfile;
  modelLabel: string;
  state: VoiceConversationState;
  voice: ConversationVoice;
  meterRef?: RefObject<HTMLDivElement | null>;
  unavailable?: string;
  approvals?: ReactNode;
  onVoiceChange: (voice: ConversationVoice) => void;
  onStart: () => void;
  onClose: () => void;
  onMute: () => void;
  onInterrupt: () => void;
  onFinishTurn: () => void;
  onOpenProviders: () => void;
}

export function VoiceConversationView({ agent, modelLabel, state, voice, meterRef, unavailable, approvals, onVoiceChange, onStart, onClose, onMute, onInterrupt, onFinishTurn, onOpenProviders }: VoiceConversationViewProps) {
  const [captions, setCaptions] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const captionRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const active = !["ready", "error", "ended"].includes(state.phase);
  const busy = state.phase === "thinking" || state.phase === "speaking" || state.phase === "transcribing";
  useEffect(() => { startRef.current?.focus(); }, []);
  useEffect(() => { if (approvals && bodyRef.current) bodyRef.current.scrollTop = 0; }, [Boolean(approvals)]);
  useEffect(() => {
    if (!active || !state.startedAt) return;
    const update = () => setElapsed(Math.floor((Date.now() - state.startedAt!) / 1000));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [active, state.startedAt]);
  useEffect(() => {
    const element = captionRef.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 100) element.scrollTop = element.scrollHeight;
  }, [state.agentCaption, state.userCaption]);
  const presence = approvals ? "waiting" : state.phase === "speaking" ? "speaking" : state.phase === "hearing" || state.phase === "listening" ? "listening" : state.phase === "thinking" ? "thinking" : "idle";
  return (
    <section className="voice-conversation" aria-label={`Voice conversation with ${agent.name}`} data-phase={state.phase} data-approval={Boolean(approvals)} onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } }}>
      <div className="voice-conversation__top">
        <button type="button" onClick={onClose} className="voice-conversation__back"><ArrowLeft size={17} /> Back to chat</button>
        <span className="voice-conversation__time">{active && state.startedAt ? <><span className="voice-conversation__live" />{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</> : "Voice conversation"}</span>
        <button type="button" className="voice-conversation__captions-toggle" aria-label="Show captions" aria-pressed={captions} onClick={() => setCaptions((value) => !value)} title="Captions"><Subtitles size={20} /></button>
      </div>
      <div ref={bodyRef} className="voice-conversation__body">
        <div className="voice-conversation__identity">
          <div className="voice-conversation__avatar" style={{ "--voice-colour": agent.iconColor ?? "#8b9482" } as CSSProperties}>
            <span className="voice-conversation__halo" aria-hidden="true" />
            <ProfileAgentAvatar agent={agent} iconSize={112} presence={presence} activityKey={`voice:${agent.id}:${state.startedAt ?? "ready"}:${state.generation}`} motion="expressive" />
          </div>
          <h1>{agent.name}</h1>
          <p className="voice-conversation__model">{modelLabel}</p>
        </div>
        <div className="voice-conversation__status" role="status" aria-live="polite">
          {approvals ? "Your approval is needed" : active && state.muted && state.phase !== "speaking" && state.phase !== "thinking" ? "Microphone muted" : labels[state.phase]}
        </div>
        {active ? <>
          {!approvals ? <div ref={meterRef} className="voice-conversation__meter" aria-hidden="true" data-muted={state.muted}>
            {[0.35, 0.65, 0.85, 1, 0.8, 0.6, 0.3].map((scale, i) => <i key={i} style={{ "--bar-scale": scale, "--bar-delay": `${i * 85}ms` } as CSSProperties} />)}
          </div> : null}
          <p className="voice-conversation__hint">{approvals ? "Review the action below. Your microphone is paused." : state.muted ? "You can still hear replies while muted." : state.phase === "speaking" ? state.voiceInterruptionAvailable ? "Speak to interrupt, or use the interrupt button." : "Your microphone pauses during replies on this device. Use Interrupt to speak." : "Speak naturally. A short pause sends your words."}</p>
          {approvals ? <div className="voice-conversation__approvals">{approvals}</div> : null}
          {captions && !approvals && (state.userCaption || state.agentCaption) ? <div ref={captionRef} className="voice-conversation__captions" aria-label="Live captions" tabIndex={0}>
            {state.userCaption ? <p className="voice-conversation__user-caption"><span>You</span>{state.userCaption}</p> : null}
            {state.agentCaption ? <p><span>{agent.name}</span>{state.agentCaption}</p> : null}
          </div> : null}
        </> : <div className="voice-conversation__setup">
          {state.error ? <p className="voice-conversation__error" role="alert">{state.error}</p> : <p>Speak naturally. {agent.name} will reply out loud, with the context and tools from this conversation.</p>}
          <label className="voice-conversation__voice-select"><span>Voice</span><select value={voice} onChange={(event) => onVoiceChange(event.target.value as ConversationVoice)}><option value="marin">Marin</option><option value="cedar">Cedar</option><option value="coral">Coral</option><option value="sage">Sage</option></select></label>
          <p className="voice-conversation__disclosure">During this call, your speech and reply text are sent to OpenAI for metered transcription and AI-generated speech. Transcribed messages send automatically. Mivlet keeps the conversation, but does not save raw audio. Tool actions keep their usual approvals.</p>
          {unavailable ? <p className="voice-conversation__error">{unavailable} <button type="button" onClick={onOpenProviders}>Open Providers</button></p> : null}
        </div>}
      </div>
      {active ? <footer className="voice-conversation__controls">
        <div><button type="button" className="voice-conversation__mute" onClick={onMute} disabled={state.phase === "connecting"} aria-label={state.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.muted}>{state.muted ? <MicrophoneSlash size={23} /> : <Microphone size={23} />}</button><span>{state.muted ? "Unmute" : "Mute"}</span></div>
        <div><button type="button" className="voice-conversation__end" onClick={onClose} aria-label="End voice conversation"><PhoneDisconnect size={25} /></button><span>End</span></div>
        <div><button type="button" className="voice-conversation__interrupt" onClick={state.phase === "hearing" ? onFinishTurn : onInterrupt} disabled={!busy && state.phase !== "hearing"} aria-label={state.phase === "hearing" ? "Send speech now" : "Interrupt reply"}><span aria-hidden="true">{state.phase === "hearing" ? "↑" : "■"}</span></button><span>{state.phase === "hearing" ? "Send now" : "Interrupt"}</span></div>
      </footer> : <footer className="voice-conversation__start-controls">
        <button ref={startRef} type="button" className="voice-conversation__start" disabled={Boolean(unavailable)} onClick={onStart}><Microphone size={19} />{state.phase === "ready" ? "Start voice" : "Reconnect voice"}</button>
        <small className="voice-conversation__limit">OpenAI API billing · 30-minute calls · Ends after 3 minutes idle</small>
      </footer>}
    </section>
  );
}
