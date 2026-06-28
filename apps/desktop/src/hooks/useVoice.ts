import { useCallback, useRef, useState } from "react";
import type { VoiceRecordingState } from "@fable/protocol";
import type { SpeechToTextProvider, SpeechToTextSession } from "@fable/connectors";

export interface VoiceState {
  status: VoiceRecordingState;
  transcript: string;
  error: string | null;
}

export function useVoice(
  provider: SpeechToTextProvider,
  onSubmit: (transcript: string) => void
) {
  const [state, setState] = useState<VoiceState>({
    status: "idle",
    transcript: "",
    error: null
  });
  const sessionRef = useRef<SpeechToTextSession | null>(null);

  const dispose = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.dispose();
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    setState({ status: "recording", transcript: "", error: null });
    try {
      sessionRef.current = await provider.start();
    } catch (error) {
      await dispose();
      setState({
        status: "error",
        transcript: "",
        error: error instanceof Error ? error.message : "Voice input could not start."
      });
    }
  }, [dispose, provider]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    setState((current) => ({ ...current, status: "processing", error: null }));
    try {
      const transcript = await session.stop();
      setState({ status: "review", transcript, error: null });
    } catch (error) {
      setState({
        status: "error",
        transcript: "",
        error: error instanceof Error ? error.message : "Speech processing failed."
      });
    } finally {
      await dispose();
    }
  }, [dispose]);

  const cancel = useCallback(async () => {
    try {
      await sessionRef.current?.cancel();
    } finally {
      await dispose();
      setState({ status: "idle", transcript: "", error: null });
    }
  }, [dispose]);

  const updateTranscript = useCallback((transcript: string) => {
    setState((current) => ({ ...current, transcript }));
  }, []);

  const submit = useCallback(() => {
    const transcript = state.transcript.trim();
    if (!transcript) return;
    onSubmit(transcript);
    setState({ status: "idle", transcript: "", error: null });
  }, [onSubmit, state.transcript]);

  return {
    state,
    provider: provider.descriptor,
    processingDisclosure: provider.processingDisclosure,
    start,
    stop,
    cancel,
    updateTranscript,
    submit
  };
}
