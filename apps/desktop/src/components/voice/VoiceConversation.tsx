import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationVoice, MivletAgentProfile, VoiceConversationPhase, VoiceConversationScope } from "@mivlet/protocol";
import { INITIAL_CONVERSATION_STATE, VoiceConversationController, type VoicePromptControl } from "@mivlet/connectors/voice";
import { createNativeVoiceConversationPort } from "../../lib/native-speech";
import { openConversationMicrophone, playConversationAudio } from "../../lib/conversation-audio";
import { VoiceConversationView } from "./VoiceConversationView";

export function VoiceConversation({ agent, modelLabel, scope, unavailable, approvals, onPrompt, onClose, onOpenProviders, onPhase }: {
  agent: MivletAgentProfile;
  modelLabel: string;
  scope: VoiceConversationScope;
  unavailable?: string;
  approvals?: ReactNode;
  onPrompt: (text: string, control: VoicePromptControl) => Promise<void>;
  onClose: () => void;
  onOpenProviders: () => void;
  onPhase: (phase: VoiceConversationPhase) => void;
}) {
  const [state, setState] = useState(INITIAL_CONVERSATION_STATE);
  const [voice, setVoice] = useState<ConversationVoice>("marin");
  const controller = useRef<VoiceConversationController | null>(null);
  const prompt = useRef(onPrompt); prompt.current = onPrompt;
  const meterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setState(INITIAL_CONVERSATION_STATE);
    const instance = new VoiceConversationController({
      scope, voice, port: createNativeVoiceConversationPort(),
      audio: { open: openConversationMicrophone, play: playConversationAudio },
      onPrompt: (text, control) => prompt.current(text, control),
      onState: setState,
      onLevel: (level) => meterRef.current?.style.setProperty("--voice-level", String(level)),
    });
    controller.current = instance;
    instance.setPaused(Boolean(approvals));
    const end = () => instance.end();
    window.addEventListener("pagehide", end);
    return () => { window.removeEventListener("pagehide", end); instance.end(); controller.current = null; };
  }, [scope.workspaceId, scope.agentId, scope.threadId, voice]);
  useEffect(() => { controller.current?.setPaused(Boolean(approvals)); }, [Boolean(approvals)]);
  useEffect(() => { if (unavailable && !["ready", "ended", "error"].includes(state.phase)) controller.current?.end(); }, [unavailable, state.phase]);
  useEffect(() => { onPhase(state.phase); }, [state.phase, onPhase]);
  return <VoiceConversationView agent={agent} modelLabel={modelLabel} state={state} voice={voice} meterRef={meterRef} unavailable={unavailable} approvals={approvals}
    onVoiceChange={setVoice} onStart={() => void controller.current?.start()} onClose={() => { controller.current?.end(); onClose(); }}
    onMute={() => controller.current?.setMuted(!state.muted)} onInterrupt={() => controller.current?.interrupt()} onFinishTurn={() => controller.current?.finishTurn()} onOpenProviders={onOpenProviders} />;
}
