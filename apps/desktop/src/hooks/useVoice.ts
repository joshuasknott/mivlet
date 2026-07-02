import { useCallback, useEffect, useRef, useState } from "react";
import {
  SpeechToTextError,
  type SpeechToTextErrorCode,
  type SpeechToTextProvider,
  type SpeechToTextSession
} from "@fable/connectors";

export type VoiceStatus =
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

export interface VoiceState {
  status: VoiceStatus;
  message: string;
  errorCode: SpeechToTextErrorCode | null;
}

export interface UseVoiceOptions {
  disabled?: boolean;
  onCancel?: () => void;
}

const IDLE_STATE: VoiceState = {
  status: "idle",
  message: "Start dictation",
  errorCode: null
};

function stateForProvider(
  provider: SpeechToTextProvider,
  disabled: boolean
): VoiceState {
  if (disabled) {
    return {
      status: "disabled",
      message: "Dictation is disabled. You can continue typing.",
      errorCode: null
    };
  }
  const availability = provider.availability();
  if (availability.status === "available") return IDLE_STATE;
  return {
    status: availability.status,
    message: availability.message,
    errorCode:
      availability.status === "permission-denied"
        ? "permission-denied"
        : availability.status
  };
}

function stateForError(error: unknown): VoiceState {
  const typed =
    error instanceof SpeechToTextError
      ? error
      : new SpeechToTextError(
          "runtime-failure",
          error instanceof Error
            ? error.message
            : "Dictation failed. Your typed prompt was left unchanged."
        );
  if (typed.code === "cancelled") {
    return {
      status: "cancelled",
      message: "Dictation cancelled. Your typed prompt was left unchanged.",
      errorCode: typed.code
    };
  }
  if (typed.code === "permission-denied") {
    return {
      status: "permission-denied",
      message: typed.message,
      errorCode: typed.code
    };
  }
  if (typed.code === "unsupported" || typed.code === "unavailable") {
    return {
      status: typed.code,
      message: typed.message,
      errorCode: typed.code
    };
  }
  return {
    status: "error",
    message: typed.message,
    errorCode: typed.code
  };
}

export function useVoice(
  provider: SpeechToTextProvider,
  onTranscript: (transcript: string) => void,
  { disabled = false, onCancel }: UseVoiceOptions = {}
) {
  const [state, setState] = useState<VoiceState>(() =>
    stateForProvider(provider, disabled)
  );
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const sessionRef = useRef<SpeechToTextSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const handledGenerationRef = useRef<number | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onCancelRef = useRef(onCancel);

  onTranscriptRef.current = onTranscript;
  onCancelRef.current = onCancel;

  const isCurrent = useCallback(
    (generation: number) =>
      mountedRef.current && generationRef.current === generation,
    []
  );

  const disposeSession = useCallback((session?: SpeechToTextSession | null) => {
    const target = session ?? sessionRef.current;
    if (sessionRef.current === target) sessionRef.current = null;
    target?.dispose();
  }, []);

  const handleFailure = useCallback(
    (generation: number, error: unknown, session?: SpeechToTextSession) => {
      session?.dispose();
      if (!isCurrent(generation)) return;
      busyRef.current = false;
      abortRef.current = null;
      if (sessionRef.current === session) sessionRef.current = null;
      setState(stateForError(error));
    },
    [isCurrent]
  );

  const observeCompletion = useCallback(
    (generation: number, session: SpeechToTextSession) => {
      void session.completion.then(
        (transcript) => {
          if (
            !isCurrent(generation) ||
            handledGenerationRef.current === generation
          ) {
            session.dispose();
            return;
          }
          handledGenerationRef.current = generation;
          setState({
            status: "processing",
            message: "Recording stopped. Processing dictation.",
            errorCode: null
          });

          const normalized = transcript.trim();
          if (!normalized) {
            handleFailure(
              generation,
              new SpeechToTextError(
                "empty-result",
                "No speech was detected. Your typed prompt was left unchanged."
              ),
              session
            );
            return;
          }

          busyRef.current = false;
          abortRef.current = null;
          if (sessionRef.current === session) sessionRef.current = null;
          session.dispose();
          onTranscriptRef.current(normalized);
          if (!isCurrent(generation)) return;
          setState({
            status: "success",
            message: "Dictation added to your prompt.",
            errorCode: null
          });
        },
        (error) => handleFailure(generation, error, session)
      );
    },
    [handleFailure, isCurrent]
  );

  const start = useCallback(async () => {
    if (busyRef.current || disabled) return;
    const availability = provider.availability();
    if (availability.status !== "available") {
      setState(stateForProvider(provider, disabled));
      return;
    }

    busyRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    handledGenerationRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({
      status: "starting",
      message: "Starting dictation. The microphone is not active yet.",
      errorCode: null
    });

    try {
      const session = await provider.start({ signal: controller.signal });
      if (!isCurrent(generation)) {
        session.cancel();
        session.dispose();
        return;
      }
      sessionRef.current = session;
      setState({
        status: "listening",
        message: "Listening. Stop to add dictation, or cancel to discard it.",
        errorCode: null
      });
      observeCompletion(generation, session);
    } catch (error) {
      handleFailure(generation, error);
    }
  }, [
    disabled,
    handleFailure,
    isCurrent,
    observeCompletion,
    provider
  ]);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session || state.status !== "listening") return;
    setState({
      status: "stopping",
      message: "Stopping dictation. The microphone is no longer listening.",
      errorCode: null
    });
    session.stop();
  }, [state.status]);

  const cancel = useCallback(() => {
    const wasBusy = busyRef.current;
    generationRef.current += 1;
    busyRef.current = false;
    handledGenerationRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current?.cancel();
    disposeSession();
    if (mountedRef.current) {
      setState({
        status: "cancelled",
        message: wasBusy
          ? "Dictation cancelled. Your typed prompt was left unchanged."
          : "Dictation dismissed.",
        errorCode: "cancelled"
      });
      onCancelRef.current?.();
    }
  }, [disposeSession]);

  const dismiss = useCallback(() => {
    if (busyRef.current) return;
    setState(stateForProvider(provider, disabled));
  }, [disabled, provider]);

  useEffect(() => {
    if (disabled) {
      generationRef.current += 1;
      busyRef.current = false;
      handledGenerationRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      sessionRef.current?.cancel();
      disposeSession();
      setState(stateForProvider(provider, true));
      return;
    }
    if (busyRef.current) return;
    setState(stateForProvider(provider, false));
  }, [disabled, disposeSession, provider]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      generationRef.current += 1;
      busyRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      sessionRef.current?.cancel();
      disposeSession();
    },
    [disposeSession]
  );

  const isBusy =
    state.status === "starting" ||
    state.status === "listening" ||
    state.status === "stopping" ||
    state.status === "processing";
  const canStart =
    !disabled &&
    !isBusy &&
    state.status !== "unsupported" &&
    state.status !== "disabled";

  return {
    state,
    provider: provider.descriptor,
    processingDisclosure: provider.processingDisclosure,
    isBusy,
    canStart,
    start,
    stop,
    cancel,
    dismiss
  };
}
