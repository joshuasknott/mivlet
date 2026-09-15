/** Provider-neutral speech contracts. Dictation only fills the composer. */
export type VoiceProviderKind = "local" | "remote";

export interface VoiceProviderDescriptor {
  id: string;
  kind: VoiceProviderKind;
  label: string;
  /** Whether Mivlet retains raw audio. This does not describe a provider's policy. */
  retainsAudio: boolean;
  setupHint?: string;
}

/** Availability checks must never request microphone access. */
export type VoiceCapability =
  | { status: "supported"; provider: VoiceProviderDescriptor }
  | { status: "unavailable"; provider: VoiceProviderDescriptor; reason: string };

export type VoiceFailureCode =
  | "cancelled"
  | "empty-result"
  | "permission-denied"
  | "runtime-failure"
  | "startup-failure"
  | "unavailable"
  | "unsupported";

export type VoiceInputStatus =
  | "cancelled"
  | "disabled"
  | "error"
  | "idle"
  | "listening"
  | "permission-denied"
  | "processing"
  | "reviewing"
  | "starting"
  | "stopping"
  | "success"
  | "unavailable"
  | "unsupported";

export interface VoiceInputState {
  status: VoiceInputStatus;
  message: string;
  errorCode: VoiceFailureCode | null;
}

/** A call authorizes speech processing only; it never grants agent tool authority. */
export interface VoiceConversationScope {
  workspaceId: string;
  agentId: string;
  threadId: string;
}

export interface VoiceConversationSession extends VoiceConversationScope {
  sessionId: string;
  expiresAt: string;
}

export type ConversationVoice = "marin" | "cedar" | "coral" | "sage";

export interface VoiceConversationRequest {
  session: VoiceConversationSession;
  generation: number;
  requestId: string;
}

export type VoiceConversationPhase = "ready" | "connecting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "paused" | "error" | "ended";

export interface VoiceConversationState {
  phase: VoiceConversationPhase;
  muted: boolean;
  userCaption: string;
  agentCaption: string;
  error: string | null;
  startedAt: number | null;
  voiceInterruptionAvailable: boolean;
  generation: number;
}
