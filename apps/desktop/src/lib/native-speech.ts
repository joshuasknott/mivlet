import type { NativeSpeechPort, StagedRecordingReceipt } from "@mivlet/connectors/voice";
import { getRuntimeAdapter } from "../runtime/adapters/select";
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
