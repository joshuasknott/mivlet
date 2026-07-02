import type {
  VoiceCapability,
  VoiceFailureCode,
  VoiceProviderDescriptor
} from "@fable/protocol";

export type SpeechToTextAvailability =
  | { status: "available" }
  | {
      status: "unsupported" | "unavailable" | "permission-denied";
      message: string;
    };

export type SpeechToTextErrorCode = VoiceFailureCode;

export class SpeechToTextError extends Error {
  constructor(
    readonly code: SpeechToTextErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SpeechToTextError";
  }
}

export interface SpeechToTextSession {
  /** The only source of a completed transcript. Settles at natural or requested end. */
  completion: Promise<string>;
  stop(): void;
  cancel(): void;
  dispose(): void;
}

export interface SpeechToTextProvider {
  descriptor: VoiceProviderDescriptor;
  /** Side-effect-free capability detection. It must not prompt for microphone access. */
  capability: VoiceCapability;
  processingDisclosure: string;
  availability(): SpeechToTextAvailability;
  /** Resolves only once the platform confirms that recognition has started. */
  start(options?: { signal?: AbortSignal }): Promise<SpeechToTextSession>;
}

interface BrowserRecognitionResult {
  readonly 0: { transcript: string };
  readonly isFinal: boolean;
}

interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<BrowserRecognitionResult>;
      }) => void)
    | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

type BrowserRecognitionConstructor = new () => BrowserRecognition;

type BrowserSpeechEnvironment = Window & {
  SpeechRecognition?: BrowserRecognitionConstructor;
  webkitSpeechRecognition?: BrowserRecognitionConstructor;
};

const BROWSER_SPEECH_DESCRIPTOR: VoiceProviderDescriptor = {
  id: "browser-speech",
  kind: "remote",
  label: "Browser speech service",
  retainsAudio: false,
  setupHint: "Speech recognition is unavailable in this desktop webview."
};

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 5_000;

function constructorFor(environment: BrowserSpeechEnvironment) {
  return environment.SpeechRecognition ?? environment.webkitSpeechRecognition;
}

export function detectBrowserSpeechCapability(
  environment: BrowserSpeechEnvironment = window
): VoiceCapability {
  return constructorFor(environment)
    ? { status: "supported", provider: BROWSER_SPEECH_DESCRIPTOR }
    : {
        status: "unavailable",
        provider: BROWSER_SPEECH_DESCRIPTOR,
        reason: BROWSER_SPEECH_DESCRIPTOR.setupHint!
      };
}

function platformError(error: string, started: boolean): SpeechToTextError {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return new SpeechToTextError(
        "permission-denied",
        "Microphone permission was denied. Allow microphone access in system or browser settings, then try again."
      );
    case "audio-capture":
    case "language-not-supported":
      return new SpeechToTextError(
        "unavailable",
        "Dictation is unavailable because the speech service or microphone cannot be accessed. Text input is still available."
      );
    case "no-speech":
      return new SpeechToTextError(
        "empty-result",
        "No speech was detected. Your typed prompt was left unchanged."
      );
    case "aborted":
      return new SpeechToTextError("cancelled", "Dictation was cancelled.");
    case "network":
      return new SpeechToTextError(
        started ? "runtime-failure" : "startup-failure",
        "The speech service could not be reached. Your typed prompt was left unchanged."
      );
    default:
      return new SpeechToTextError(
        started ? "runtime-failure" : "startup-failure",
        started
          ? "Dictation stopped unexpectedly. Your typed prompt was left unchanged."
          : "Dictation could not start. Text input is still available."
      );
  }
}

export function createBrowserSpeechProvider(
  environment: BrowserSpeechEnvironment = window
): SpeechToTextProvider {
  const capability = detectBrowserSpeechCapability(environment);
  const unavailableMessage = capability.status === "unavailable"
    ? capability.reason
    : "Dictation is not supported by this browser or desktop runtime. You can continue typing.";

  return {
    descriptor: BROWSER_SPEECH_DESCRIPTOR,
    capability,
    processingDisclosure:
      "Speech processing is provided by the operating system or browser and may use a remote service. Fable does not retain raw audio or persist a separate dictation transcript.",
    availability() {
      return constructorFor(environment)
        ? { status: "available" }
        : { status: "unsupported", message: unavailableMessage };
    },
    start({ signal } = {}) {
      const Constructor = constructorFor(environment);
      if (!Constructor) {
        return Promise.reject(
          new SpeechToTextError("unsupported", unavailableMessage)
        );
      }
      if (signal?.aborted) {
        return Promise.reject(
          new SpeechToTextError("cancelled", "Dictation was cancelled.")
        );
      }

      const recognition = new Constructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = environment.navigator.language || "en-GB";

      let started = false;
      let ended = false;
      let cancelled = false;
      let disposed = false;
      let abortRequested = false;
      let stopRequested = false;
      let completionSettled = false;
      let startSettled = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const finalSegments = new Map<number, string>();

      let resolveStart!: (session: SpeechToTextSession) => void;
      let rejectStart!: (error: SpeechToTextError) => void;
      let resolveCompletion!: (transcript: string) => void;
      let rejectCompletion!: (error: SpeechToTextError) => void;

      const completion = new Promise<string>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      // Consumers attach immediately after start resolves, but a platform error
      // can still race that hand-off. Mark the rejection observed at the seam.
      void completion.catch(() => undefined);

      const clearTimers = () => {
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        if (stopTimer !== undefined) clearTimeout(stopTimer);
        startupTimer = undefined;
        stopTimer = undefined;
      };

      const settleCompletion = (
        outcome: { transcript: string } | { error: SpeechToTextError }
      ) => {
        if (completionSettled) return;
        completionSettled = true;
        if ("error" in outcome) rejectCompletion(outcome.error);
        else resolveCompletion(outcome.transcript);
      };

      const detach = () => {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        signal?.removeEventListener("abort", abortFromSignal);
        clearTimers();
      };

      const failStart = (error: SpeechToTextError) => {
        if (startSettled) return;
        startSettled = true;
        rejectStart(error);
      };

      const abortOnce = () => {
        if (ended || abortRequested) return;
        abortRequested = true;
        try {
          recognition.abort();
        } catch {
          // Promises still settle even if the platform rejects teardown.
        }
      };

      const finishFromEnd = () => {
        if (ended) return;
        ended = true;
        if (!started) {
          const error = new SpeechToTextError(
            cancelled ? "cancelled" : "startup-failure",
            cancelled
              ? "Dictation was cancelled."
              : "Dictation ended before the microphone became active."
          );
          failStart(error);
          settleCompletion({ error });
          return;
        }
        if (cancelled) {
          settleCompletion({
            error: new SpeechToTextError("cancelled", "Dictation was cancelled.")
          });
          return;
        }
        const transcript = [...finalSegments.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => value.trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (!transcript) {
          settleCompletion({
            error: new SpeechToTextError(
              "empty-result",
              "No speech was detected. Your typed prompt was left unchanged."
            )
          });
          return;
        }
        settleCompletion({ transcript });
      };

      const session: SpeechToTextSession = {
        completion,
        stop() {
          if (disposed || ended || cancelled || stopRequested) return;
          stopRequested = true;
          try {
            recognition.stop();
            stopTimer = setTimeout(() => {
              settleCompletion({
                error: new SpeechToTextError(
                  "runtime-failure",
                  "Dictation did not finish cleanly. Your typed prompt was left unchanged."
                )
              });
              abortOnce();
            }, STOP_TIMEOUT_MS);
          } catch {
            settleCompletion({
              error: new SpeechToTextError(
                "runtime-failure",
                "Dictation could not stop cleanly. Your typed prompt was left unchanged."
              )
            });
          }
        },
        cancel() {
          if (disposed || ended || cancelled) return;
          cancelled = true;
          settleCompletion({
            error: new SpeechToTextError("cancelled", "Dictation was cancelled.")
          });
          abortOnce();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          if (!ended && !cancelled) {
            cancelled = true;
          }
          abortOnce();
          detach();
          finalSegments.clear();
        }
      };

      function abortFromSignal() {
        cancelled = true;
        const error = new SpeechToTextError("cancelled", "Dictation was cancelled.");
        failStart(error);
        settleCompletion({ error });
        abortOnce();
      }

      recognition.onstart = () => {
        if (cancelled || disposed || startSettled) return;
        started = true;
        startSettled = true;
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        startupTimer = undefined;
        resolveStart(session);
      };
      recognition.onresult = (event) => {
        if (!started || ended || cancelled || disposed) return;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result?.isFinal || finalSegments.has(index)) continue;
          const transcript = result[0]?.transcript?.trim();
          if (transcript) finalSegments.set(index, transcript);
        }
      };
      recognition.onerror = (event) => {
        if (cancelled || disposed) return;
        const error = platformError(event.error, started);
        if (!started) failStart(error);
        settleCompletion({ error });
      };
      recognition.onend = finishFromEnd;

      const startPromise = new Promise<SpeechToTextSession>((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });

      signal?.addEventListener("abort", abortFromSignal, { once: true });
      startupTimer = setTimeout(() => {
        const error = new SpeechToTextError(
          "startup-failure",
          "Dictation did not start in time. You can continue typing."
        );
        failStart(error);
        settleCompletion({ error });
        abortOnce();
      }, START_TIMEOUT_MS);

      try {
        recognition.start();
      } catch {
        const failure = new SpeechToTextError(
          "startup-failure",
          "Dictation could not start. Text input is still available."
        );
        failStart(failure);
        settleCompletion({ error: failure });
        abortOnce();
        detach();
      }

      return startPromise.catch((error) => {
        abortOnce();
        detach();
        throw error;
      });
    }
  };
}
