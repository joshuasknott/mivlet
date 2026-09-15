import { useEffect, useMemo } from "react";
import {
  createBrowserSpeechProvider,
  createOpenAiRecordingProvider,
} from "@mivlet/connectors/voice";
import type { ShellRuntime } from "./useShellRuntime";
import { createNativeSpeechPort } from "../lib/native-speech";
import { useVoice } from "./useVoice";

let recordingOwner: { id: string; cancel: () => void } | undefined;

export function useComposerVoice(
  runtime: ShellRuntime,
  scope: string,
  onDictation: (text: string) => void,
  onCancel: () => void,
) {
  const workspaceId =
    runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const connected = runtime.backendProviders.some(
    (provider) =>
      provider.id === "openai" &&
      provider.backendType === "native-api" &&
      provider.authState === "connected",
  );
  const provider = useMemo(
    () =>
      runtime.voiceProvider === "openai"
        ? createOpenAiRecordingProvider({
            connected,
            workspaceId: workspaceId || null,
            native: createNativeSpeechPort(),
          })
        : createBrowserSpeechProvider(),
    [runtime.voiceProvider, connected, workspaceId],
  );
  const voice = useVoice(provider, onDictation, {
    disabled: !runtime.voiceEnabled || !runtime.runtimeSnapshotReady,
    onCancel,
  });
  useEffect(() => {
    voice.reset();
    return () => {
      if (recordingOwner?.id === scope) recordingOwner = undefined;
    };
  }, [scope, voice.reset]);
  return {
    ...voice,
    start: () => {
      if (recordingOwner?.id !== scope) recordingOwner?.cancel();
      recordingOwner = { id: scope, cancel: voice.cancel };
      return voice.start();
    },
  };
}
