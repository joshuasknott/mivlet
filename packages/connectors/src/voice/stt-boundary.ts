import type {
  VoiceCapability,
  VoiceFailureCode,
  VoiceProviderDescriptor
} from "@fable/protocol";

export interface SpeechToTextSession {
  /** Resolves with the final transcript or rejects with a typed, content-free error. */
  result: Promise<string>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SpeechToTextProvider {
  descriptor: VoiceProviderDescriptor;
  /** Side-effect-free capability detection. It must not prompt for microphone access. */
  capability: VoiceCapability;
  processingDisclosure: string;
  start(): Promise<SpeechToTextSession>;
}

export class SpeechToTextError extends Error {
  constructor(
    public readonly code: VoiceFailureCode,
    message: string
  ) {
    super(message);
    this.name = "SpeechToTextError";
  }
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

const BROWSER_SPEECH_DESCRIPTOR: VoiceProviderDescriptor = {
  id: "browser-speech",
  kind: "remote",
  label: "Browser speech service",
  retainsAudio: false,
  setupHint: "Speech recognition is unavailable in this desktop webview."
};

function browserSpeechConstructor(
  environment: Window & {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  }
): BrowserRecognitionConstructor | undefined {
  return environment.SpeechRecognition ?? environment.webkitSpeechRecognition;
}

export function detectBrowserSpeechCapability(
  environment: Window & {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  } = window
): VoiceCapability {
  return browserSpeechConstructor(environment)
    ? { status: "supported", provider: BROWSER_SPEECH_DESCRIPTOR }
    : {
        status: "unavailable",
        provider: BROWSER_SPEECH_DESCRIPTOR,
        reason: BROWSER_SPEECH_DESCRIPTOR.setupHint!
      };
}

function browserSpeechError(error: string): SpeechToTextError {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return new SpeechToTextError(
      "permission-denied",
      "Microphone access was denied. You can keep typing, or allow microphone access in system settings and try again."
    );
  }
  if (error === "audio-capture" || error === "language-not-supported") {
    return new SpeechToTextError(
      "unavailable",
      "Speech recognition is unavailable on this device. Text input is still available."
    );
  }
  if (error === "aborted") {
    return new SpeechToTextError("cancelled", "Dictation was cancelled.");
  }
  if (error === "no-speech") {
    return new SpeechToTextError("no-speech", "No speech was recognized. You can try again or keep typing.");
  }
  if (error === "network") {
    return new SpeechToTextError("network", "The speech service could not be reached. Text input is still available.");
  }
  return new SpeechToTextError("failed", "Speech recognition failed. Text input is still available.");
}

export function createBrowserSpeechProvider(
  environment: Window & {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  } = window
): SpeechToTextProvider {
  const capability = detectBrowserSpeechCapability(environment);
  return {
    descriptor: BROWSER_SPEECH_DESCRIPTOR,
    capability,
    processingDisclosure:
      "Speech processing is provided by the operating system or browser and may use a remote service.",
    async start() {
      const Constructor = browserSpeechConstructor(environment);
      if (!Constructor) {
        throw new SpeechToTextError("unavailable", capability.status === "unavailable"
          ? capability.reason
          : "Speech recognition is unavailable on this device.");
      }
      const recognition = new Constructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = environment.navigator.language || "en-GB";
      let transcript = "";
      let settled = false;
      let disposed = false;
      let ended = false;
      let abortRequested = false;
      let resolveResult!: (transcript: string) => void;
      let rejectResult!: (error: SpeechToTextError) => void;
      const result = new Promise<string>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const settleError = (error: SpeechToTextError) => {
        if (settled) return;
        settled = true;
        rejectResult(error);
      };
      const abortOnce = () => {
        if (ended || abortRequested) return;
        abortRequested = true;
        recognition.abort();
      };
      recognition.onresult = (event) => {
        transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
      };
      recognition.onerror = (event) => {
        settleError(browserSpeechError(event.error));
      };
      recognition.onend = () => {
        ended = true;
        if (settled) return;
        settled = true;
        if (transcript) resolveResult(transcript);
        else rejectResult(browserSpeechError("no-speech"));
      };
      try {
        recognition.start();
      } catch {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        throw new SpeechToTextError(
          "failed",
          "Speech recognition could not start. Text input is still available."
        );
      }
      return {
        result,
        async stop() {
          if (settled || disposed) return;
          recognition.stop();
        },
        async cancel() {
          if (disposed) return;
          settleError(browserSpeechError("aborted"));
          abortOnce();
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          if (!settled) {
            settleError(browserSpeechError("aborted"));
          }
          abortOnce();
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.onend = null;
          transcript = "";
        }
      };
    }
  };
}
