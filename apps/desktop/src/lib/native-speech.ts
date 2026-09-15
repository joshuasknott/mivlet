import type { NativeSpeechPort, StagedRecordingReceipt } from "@mivlet/connectors/voice";
import { getRuntimeAdapter } from "../runtime/adapters/select";
import type { VoiceConversationPort } from "@mivlet/connectors/voice";
import type { VoiceConversationSession } from "@mivlet/protocol";

export function createNativeVoiceConversationPort(): VoiceConversationPort {
  const invoke = <T>(command: string, request: object) => getRuntimeAdapter().invoke<T>(command, { request });
  return {
    start: (scope) => invoke<VoiceConversationSession>("native_voice_start", scope),
    heartbeat: (session) => invoke<void>("native_voice_heartbeat", session),
    interrupt: (session, generation) => invoke<void>("native_voice_interrupt", { session, generation }),
    end: (session) => invoke<void>("native_voice_end", session),
    transcribe: (request) => invoke<{ transcript: string }>("native_voice_transcribe", request),
    speak: (request) => invoke<{ audioBase64: string }>("native_voice_speak", request),
  };
}

export function createNativeSpeechPort(): NativeSpeechPort {
  const invoke = <T>(command: string, request: object) =>
    getRuntimeAdapter().invoke<T>(command, { request });
  return {
    prepareRecording: (request) =>
      invoke<StagedRecordingReceipt>("native_speech_prepare_recording", request),
    transcribeRecording: (request) =>
      invoke<{ transcript: string }>("native_speech_transcribe_recording", request),
    cancelRecording: (request) =>
      invoke<void>("native_speech_cancel_recording", request)
  };
}
