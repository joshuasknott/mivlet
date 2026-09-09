import type { SpeechRecordingReview, SpeechToTextProvider, SpeechToTextSession } from "./stt-boundary";
import { SpeechToTextError } from "./stt-boundary";

export const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe" as const;
export const MAX_RECORDING_DURATION_MS = 120_000;
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

export interface StagedRecordingReceipt {
  stagedRecordingToken: string;
  workspaceId: string;
  recordingId: string;
  bytesDigest: string;
  model: typeof OPENAI_TRANSCRIPTION_MODEL;
  expiresAt: string;
  mediaType: string;
  sizeBytes: number;
  durationMs: number;
}

export interface NativeSpeechPort {
  prepareRecording(request: {
    workspaceId: string;
    recordingId: string;
    mimeType: string;
    durationMs: number;
    audioBase64: string;
  }): Promise<StagedRecordingReceipt>;
  transcribeRecording(receipt: StagedRecordingReceipt): Promise<{ transcript: string }>;
  cancelRecording(request: { workspaceId: string; recordingId: string; stagedRecordingToken: string }): Promise<void>;
}

interface RecordingEnvironment {
  getUserMedia(): Promise<MediaStream>;
  createRecorder(stream: MediaStream, mimeType?: string): MediaRecorder;
  isTypeSupported(mimeType: string): boolean;
  randomId(): string;
  now(): number;
}

function browserEnvironment(): RecordingEnvironment | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return null;
  return {
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createRecorder: (stream, mimeType) => new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    randomId: () => crypto.randomUUID(),
    now: () => Date.now()
  };
}

function preferredMimeType(environment: RecordingEnvironment): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((value) => environment.isTypeSupported(value));
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function failure(error: unknown, fallback: string): SpeechToTextError {
  if (error instanceof SpeechToTextError) return error;
  const message = typeof error === "string" && error.length <= 240 ? error : fallback;
  return new SpeechToTextError("runtime-failure", message);
}

export function createOpenAiRecordingProvider({
  connected,
  workspaceId,
  native,
  environment = browserEnvironment()
}: {
  connected: boolean;
  workspaceId: string | null;
  native: NativeSpeechPort;
  environment?: RecordingEnvironment | null;
}): SpeechToTextProvider {
  const descriptor = {
    id: "openai-file-transcription",
    kind: "remote" as const,
    label: "OpenAI transcription",
    retainsAudio: false,
    setupHint: "Connect a direct OpenAI API key to use reviewed recording transcription."
  };
  const unavailable = !connected
    ? descriptor.setupHint
    : !workspaceId
      ? "Select an active workspace before recording."
      : "Audio recording is unavailable in this desktop runtime.";
  return {
    descriptor,
    capability: connected && workspaceId && environment
      ? { status: "supported", provider: descriptor }
      : { status: "unavailable", provider: descriptor, reason: unavailable },
    processingDisclosure: "After you stop, review the recording before a one-time metered upload to OpenAI using gpt-4o-mini-transcribe. Mivlet does not save raw audio.",
    availability() {
      return connected && workspaceId && environment
        ? { status: "available" }
        : { status: "unavailable", message: unavailable };
    },
    async start({ signal } = {}) {
      if (!connected || !workspaceId || !environment) throw new SpeechToTextError("unavailable", unavailable);
      if (signal?.aborted) throw new SpeechToTextError("cancelled", "Dictation was cancelled.");
      let stream: MediaStream;
      try { stream = await environment.getUserMedia(); }
      catch { throw new SpeechToTextError("permission-denied", "Microphone permission was denied. Allow microphone access, then try again."); }
      if (signal?.aborted) { stopTracks(stream); throw new SpeechToTextError("cancelled", "Dictation was cancelled."); }

      const recordingId = `speech-${environment.randomId().replace(/[^A-Za-z0-9_-]/g, "")}`;
      let recorder: MediaRecorder;
      try { recorder = environment.createRecorder(stream, preferredMimeType(environment)); }
      catch {
        stopTracks(stream);
        throw new SpeechToTextError("startup-failure", "Recording could not start. Text input is still available.");
      }
      const chunks: Blob[] = [];
      let sizeBytes = 0;
      let startedAt = 0;
      let settled = false;
      let cancelled = false;
      let disposed = false;
      let reviewReady = false;
      let authorized = false;
      let audio: Blob | null = null;
      let receipt: StagedRecordingReceipt | null = null;
      let recordedDurationMs = 0;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveStart!: (session: SpeechToTextSession) => void;
      let rejectStart!: (error: SpeechToTextError) => void;
      let resolveReview!: (review: SpeechRecordingReview) => void;
      let rejectReview!: (error: SpeechToTextError) => void;
      let resolveCompletion!: (transcript: string) => void;
      let rejectCompletion!: (error: SpeechToTextError) => void;
      const review = new Promise<SpeechRecordingReview>((resolve, reject) => { resolveReview = resolve; rejectReview = reject; });
      const completion = new Promise<string>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
      void review.catch(() => undefined); void completion.catch(() => undefined);

      const rejectAll = (error: SpeechToTextError) => {
        if (settled) return;
        settled = true;
        rejectStart(error); rejectReview(error); rejectCompletion(error);
      };
      const clearLocal = () => {
        chunks.length = 0; audio = null;
        if (startTimer) clearTimeout(startTimer); startTimer = undefined;
        if (timer) clearTimeout(timer); timer = undefined;
      };
      const cancelNative = () => {
        if (!receipt) return;
        void native.cancelRecording({ workspaceId, recordingId, stagedRecordingToken: receipt.stagedRecordingToken }).catch(() => undefined);
      };
      const transcribe = async () => {
        if (!reviewReady || !authorized || !audio || settled) return;
        try {
          const bytes = new Uint8Array(await audio.arrayBuffer());
          const audioBase64 = base64(bytes);
          bytes.fill(0);
          receipt = await native.prepareRecording({ workspaceId, recordingId, mimeType: audio.type, durationMs: recordedDurationMs, audioBase64 });
          clearLocal();
          if (cancelled || disposed) { cancelNative(); return; }
          const result = await native.transcribeRecording(receipt);
          if (cancelled || disposed || settled) return;
          settled = true;
          resolveCompletion(result.transcript);
        } catch (error) {
          clearLocal(); cancelNative();
          if (!settled) { settled = true; rejectCompletion(failure(error, "OpenAI transcription failed. The recording was discarded.")); }
        }
      };
      const session: SpeechToTextSession = {
        completion, review,
        authorize() { if (authorized || cancelled || disposed) return; authorized = true; void transcribe(); },
        stop() { if (recorder.state === "recording") recorder.stop(); },
        cancel() {
          if (cancelled) return; cancelled = true;
          if (recorder.state === "recording") recorder.stop();
          stopTracks(stream); clearLocal(); cancelNative();
          rejectAll(new SpeechToTextError("cancelled", "Dictation was cancelled."));
        },
        dispose() {
          if (disposed) return; disposed = true;
          if (!settled) session.cancel();
          recorder.onstart = recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
          stopTracks(stream); clearLocal();
        }
      };
      recorder.onstart = () => {
        if (cancelled || disposed || settled) return;
        startedAt = environment.now();
        if (startTimer) clearTimeout(startTimer); startTimer = undefined;
        timer = setTimeout(() => session.stop(), MAX_RECORDING_DURATION_MS);
        resolveStart(session);
      };
      recorder.ondataavailable = (event) => {
        if (cancelled || disposed || settled || !event.data.size) return;
        sizeBytes += event.data.size;
        if (sizeBytes > MAX_RECORDING_BYTES) {
          cancelled = true;
          if (recorder.state === "recording") recorder.stop();
          stopTracks(stream); clearLocal(); cancelNative();
          rejectAll(new SpeechToTextError("runtime-failure", "The recording exceeded 16 MiB and was discarded."));
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        stopTracks(stream); clearLocal(); cancelNative();
        rejectAll(new SpeechToTextError("runtime-failure", "Recording failed. Your typed prompt was left unchanged."));
      };
      recorder.onstop = () => {
        stopTracks(stream); if (timer) clearTimeout(timer); timer = undefined;
        if (cancelled || disposed || settled) return;
        audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
        chunks.length = 0;
        if (!audio.size || audio.size > MAX_RECORDING_BYTES) { rejectAll(new SpeechToTextError("empty-result", "No usable speech recording was captured.")); return; }
        reviewReady = true;
        recordedDurationMs = Math.min(MAX_RECORDING_DURATION_MS, Math.max(1, environment.now() - startedAt));
        resolveReview({ recordingId, durationMs: recordedDurationMs, sizeBytes: audio.size, mediaType: audio.type, providerLabel: descriptor.label, model: OPENAI_TRANSCRIPTION_MODEL, maxDurationMs: MAX_RECORDING_DURATION_MS });
        void transcribe();
      };
      const abort = () => session.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      completion.finally(() => signal?.removeEventListener("abort", abort)).catch(() => undefined);
      const started = new Promise<SpeechToTextSession>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
      startTimer = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
        stopTracks(stream); clearLocal();
        rejectAll(new SpeechToTextError("startup-failure", "Recording did not start in time. Text input is still available."));
      }, 8_000);
      try { recorder.start(1_000); } catch { session.cancel(); throw new SpeechToTextError("startup-failure", "Recording could not start. Text input is still available."); }
      return started;
    }
  };
}
