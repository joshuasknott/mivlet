import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceInputState } from "@fable/protocol";
import {
  SpeechToTextError,
  type SpeechToTextProvider,
  type SpeechToTextSession
} from "@fable/connectors";

function restingState(provider: SpeechToTextProvider, enabled: boolean): VoiceInputState {
  if (!enabled) return { status: "disabled" };
  if (provider.capability.status === "unavailable") {
    return { status: "unavailable", reason: provider.capability.reason };
  }
  return { status: "idle" };
}

function failureState(error: unknown): VoiceInputState {
  if (error instanceof SpeechToTextError) {
    if (error.code === "permission-denied") {
      return { status: "permission-denied", message: error.message };
    }
    if (error.code === "cancelled") return { status: "cancelled" };
    if (error.code === "unavailable") {
      return { status: "unavailable", reason: error.message };
    }
    return { status: "failed", code: error.code, message: error.message };
  }
  return {
    status: "failed",
    code: "failed",
    message: "Speech recognition failed. Text input is still available."
  };
}

/**
 * Deliberate dictation orchestration. The hook never starts on mount or after a
 * lifecycle change; only `start` may ask the provider for microphone access.
 * Operation ids fence late platform callbacks and pending-start races.
 */
export function useVoice(
  provider: SpeechToTextProvider,
  enabled: boolean,
  onAccept: (transcript: string) => void
) {
  const [state, setState] = useState<VoiceInputState>(() => restingState(provider, enabled));
  const sessionRef = useRef<SpeechToTextSession | null>(null);
  const operationRef = useRef(0);
  const startingRef = useRef(false);
  const releasedRef = useRef(new WeakSet<SpeechToTextSession>());
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  const release = useCallback(async (
    session: SpeechToTextSession | null,
    cancel: boolean
  ) => {
    if (!session) return;
    if (releasedRef.current.has(session)) return;
    releasedRef.current.add(session);
    try {
      if (cancel) await session.cancel();
    } finally {
      await session.dispose();
    }
  }, []);

  useEffect(() => {
    const operation = ++operationRef.current;
    startingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    void release(session, true);
    setState(restingState(provider, enabled));

    return () => {
      if (operationRef.current === operation) operationRef.current += 1;
      startingRef.current = false;
      const current = sessionRef.current;
      sessionRef.current = null;
      void release(current, true);
    };
  }, [enabled, provider, release]);

  const watchSession = useCallback((
    session: SpeechToTextSession,
    operation: number
  ) => {
    void session.result.then(
      async (transcript) => {
        if (operationRef.current !== operation || sessionRef.current !== session) {
          await release(session, false);
          return;
        }
        sessionRef.current = null;
        setState({ status: "processing" });
        await release(session, false);
        if (operationRef.current !== operation) return;
        const normalized = transcript.trim();
        setState(normalized
          ? { status: "successful", transcript: normalized }
          : {
              status: "failed",
              code: "no-speech",
              message: "No speech was recognized. You can try again or keep typing."
            });
      },
      async (error) => {
        if (operationRef.current !== operation || sessionRef.current !== session) {
          await release(session, false);
          return;
        }
        sessionRef.current = null;
        await release(session, false);
        if (operationRef.current === operation) setState(failureState(error));
      }
    );
  }, [release]);

  const start = useCallback(async () => {
    if (!enabled) {
      setState({ status: "disabled" });
      return;
    }
    if (provider.capability.status === "unavailable") {
      setState({ status: "unavailable", reason: provider.capability.reason });
      return;
    }
    if (startingRef.current || sessionRef.current) return;

    const operation = ++operationRef.current;
    startingRef.current = true;
    setState({ status: "active" });
    try {
      const session = await provider.start();
      startingRef.current = false;
      if (operationRef.current !== operation) {
        session.result.catch(() => {});
        await release(session, true);
        return;
      }
      sessionRef.current = session;
      watchSession(session, operation);
    } catch (error) {
      startingRef.current = false;
      if (operationRef.current === operation) setState(failureState(error));
    }
  }, [enabled, provider, release, watchSession]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const operation = operationRef.current;
    setState({ status: "processing" });
    try {
      await session.stop();
    } catch (error) {
      if (operationRef.current !== operation || sessionRef.current !== session) return;
      sessionRef.current = null;
      await release(session, false);
      if (operationRef.current === operation) setState(failureState(error));
    }
  }, [release]);

  const cancel = useCallback(async () => {
    operationRef.current += 1;
    startingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    setState({ status: "cancelled" });
    await release(session, true);
  }, [release]);

  const reset = useCallback(() => {
    operationRef.current += 1;
    startingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    void release(session, true);
    setState(restingState(provider, enabled));
  }, [enabled, provider, release]);

  const updateTranscript = useCallback((transcript: string) => {
    setState((current) =>
      current.status === "successful" ? { ...current, transcript } : current
    );
  }, []);

  const accept = useCallback(() => {
    if (state.status !== "successful") return;
    const transcript = state.transcript.trim();
    if (!transcript) return;
    onAcceptRef.current(transcript);
    setState(restingState(provider, enabled));
  }, [enabled, provider, state]);

  return {
    state,
    capability: provider.capability,
    provider: provider.descriptor,
    processingDisclosure: provider.processingDisclosure,
    canStart: enabled && provider.capability.status === "supported" &&
      state.status !== "active" && state.status !== "processing",
    start,
    stop,
    cancel,
    reset,
    updateTranscript,
    accept
  };
}
