import type { VoiceProviderDescriptor } from "@fable/protocol";

export interface SpeechToTextSession {
  stop(): Promise<string>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SpeechToTextProvider {
  descriptor: VoiceProviderDescriptor;
  processingDisclosure: string;
  start(): Promise<SpeechToTextSession>;
}

interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type BrowserRecognitionConstructor = new () => BrowserRecognition;

export function createBrowserSpeechProvider(
  environment: Window & {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  } = window
): SpeechToTextProvider {
  return {
    descriptor: {
      id: "browser-speech",
      kind: "remote",
      label: "Browser speech service",
      retainsAudio: false,
      setupHint: "Speech recognition is unavailable in this desktop webview."
    },
    processingDisclosure:
      "Speech processing is provided by the operating system or browser and may use a remote service.",
    async start() {
      const Constructor =
        environment.SpeechRecognition ?? environment.webkitSpeechRecognition;
      if (!Constructor) throw new Error("Speech recognition is unavailable on this device.");
      const recognition = new Constructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = environment.navigator.language || "en-GB";
      let transcript = "";
      let failure: Error | null = null;
      let resolveEnd: (() => void) | null = null;
      recognition.onresult = (event) => {
        transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
      };
      recognition.onerror = (event) => {
        failure = new Error(`Speech recognition failed: ${event.error}.`);
      };
      recognition.onend = () => resolveEnd?.();
      recognition.start();
      let disposed = false;
      return {
        async stop() {
          const ended = new Promise<void>((resolve) => {
            resolveEnd = resolve;
            globalThis.setTimeout(resolve, 2_000);
          });
          recognition.stop();
          await ended;
          if (failure) throw failure;
          if (!transcript) throw new Error("No speech was recognized.");
          return transcript;
        },
        async cancel() {
          recognition.abort();
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.onend = null;
          transcript = "";
          failure = null;
          resolveEnd = null;
        }
      };
    }
  };
}
