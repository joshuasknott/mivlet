import { base64ToBytes, VoiceTurnDetector } from "@fable/connectors/voice";

export interface ConversationMicrophone {
  setEnabled(enabled: boolean): void;
  finish(): void;
  close(): void;
  echoCancellation: boolean;
}

export async function openConversationMicrophone(options: {
  signal: AbortSignal;
  onStart: () => void;
  onTurn: (wav: Uint8Array) => void;
  onSilence: () => void;
  onLevel: (level: number) => void;
  onError: (message: string) => void;
}): Promise<ConversationMicrophone> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    throw new Error("This desktop runtime does not support microphone conversations. Update Mivlet and the Windows WebView2 runtime, then try again.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let detector: VoiceTurnDetector | undefined;
  let enabled = true;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    detector?.reset();
    if (node) { node.port.onmessage = null; node.disconnect(); }
    source?.disconnect();
    for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    void context?.close().catch(() => undefined);
    options.signal.removeEventListener("abort", close);
  };
  options.signal.addEventListener("abort", close, { once: true });
  try {
    if (options.signal.aborted) throw new DOMException("Voice was cancelled.", "AbortError");
    context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule("/audio/voice-capture.worklet.js");
    if (closed || options.signal.aborted) throw new DOMException("Voice was cancelled.", "AbortError");
    detector = new VoiceTurnDetector(context.sampleRate, options.onStart, options.onTurn, options.onSilence);
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "mivlet-voice-capture");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (closed || !enabled) return;
      options.onLevel(detector!.push(event.data));
    };
    node.onprocessorerror = () => options.onError("Microphone processing stopped. Please reconnect voice.");
    source.connect(node);
    node.connect(context.destination);
    for (const track of stream.getAudioTracks()) track.onended = () => options.onError("Your microphone disconnected. Please reconnect voice.");
    return {
      echoCancellation: stream.getAudioTracks()[0]?.getSettings().echoCancellation === true,
      setEnabled(value) {
        if (enabled === value) return;
        enabled = value;
        detector?.reset();
        for (const track of stream.getAudioTracks()) track.enabled = value;
        if (!value) options.onLevel(0);
      },
      finish: () => detector?.finish(),
      close,
    };
  } catch (error) { close(); throw error; }
}

/** Native speech returns WAV bytes. A media element lets the OS cancel playback echo. */
export function playConversationAudio(audioBase64: string, signal: AbortSignal, onPlaying: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Speech interrupted.", "AbortError")); return; }
    const url = URL.createObjectURL(new Blob([base64ToBytes(audioBase64)], { type: "audio/wav" }));
    const audio = new Audio(url);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      audio.onended = audio.onerror = audio.onplaying = null;
      audio.pause(); audio.removeAttribute("src"); audio.load();
      URL.revokeObjectURL(url);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException("Speech interrupted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    audio.onplaying = onPlaying;
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("Audio playback failed. Your reply is still in the conversation."));
    void audio.play().catch(() => finish(new Error("Audio playback was blocked. Reconnect voice to try again.")));
  });
}
