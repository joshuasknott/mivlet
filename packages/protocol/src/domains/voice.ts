/** Provider-neutral dictation contracts. Dictation only fills the composer. */
export type VoiceProviderKind = "local" | "remote";

export interface VoiceProviderDescriptor {
  id: string;
  kind: VoiceProviderKind;
  label: string;
  /** Whether Fable retains raw audio. This does not describe a provider's policy. */
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

/** @deprecated Use VoiceInputState. */
export type VoiceRecordingState = VoiceInputState["status"];
