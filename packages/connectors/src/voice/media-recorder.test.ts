import { describe, expect, it, vi } from "vitest";
import { createOpenAiRecordingProvider, type NativeSpeechPort, type StagedRecordingReceipt } from "./media-recorder";

function fixture() {
  let now = 1_000;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  class Recorder {
    state: RecordingState = "inactive";
    mimeType = "audio/webm";
    onstart: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = "recording"; queueMicrotask(() => this.onstart?.()); }
    stop() {
      if (this.state !== "recording") return;
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const recorder = new Recorder();
  const receipt: StagedRecordingReceipt = {
    stagedRecordingToken: "token", workspaceId: "local-workspace", recordingId: "speech-recording1",
    bytesDigest: "digest", model: "gpt-4o-mini-transcribe", expiresAt: "2099-01-01T00:00:00Z",
    durationMs: 1_000, sizeBytes: 5, mediaType: "audio/webm"
  };
  const native: NativeSpeechPort = {
    prepareRecording: vi.fn(async (request) => ({ ...receipt, recordingId: request.recordingId })),
    transcribeRecording: vi.fn(async () => ({ transcript: "reviewed words" })),
    cancelRecording: vi.fn(async () => undefined)
  };
  const provider = createOpenAiRecordingProvider({
    connected: true, workspaceId: "local-workspace", native,
    environment: {
      getUserMedia: async () => stream,
      createRecorder: () => recorder as unknown as MediaRecorder,
      isTypeSupported: (type) => type.startsWith("audio/webm"),
      randomId: () => "recording1",
      now: () => now
    }
  });
  return { provider, native, recorder, track, advance: (ms: number) => { now += ms; } };
}

describe("reviewed OpenAI recording provider", () => {
  it("records locally and does not stage or upload before explicit review authorization", async () => {
    const value = fixture();
    const session = await value.provider.start();
    value.advance(1_000);
    session.stop();
    const review = await session.review;
    expect(review).toMatchObject({ sizeBytes: 5, durationMs: 1_000, model: "gpt-4o-mini-transcribe" });
    expect(value.native.prepareRecording).not.toHaveBeenCalled();
    expect(value.native.transcribeRecording).not.toHaveBeenCalled();

    session.authorize?.();
    await expect(session.completion).resolves.toBe("reviewed words");
    expect(value.native.prepareRecording).toHaveBeenCalledOnce();
    expect(value.native.transcribeRecording).toHaveBeenCalledOnce();
    expect(value.track.stop).toHaveBeenCalled();
    session.dispose();
  });

  it("cancels a reviewed recording without staging it and ignores repeated actions", async () => {
    const value = fixture();
    const session = await value.provider.start();
    session.stop();
    await session.review;
    session.cancel(); session.cancel();
    await expect(session.completion).rejects.toMatchObject({ code: "cancelled" });
    expect(value.native.prepareRecording).not.toHaveBeenCalled();
    expect(value.native.cancelRecording).not.toHaveBeenCalled();
  });

  it("fails closed when the direct OpenAI connection is unavailable", async () => {
    const value = fixture();
    const provider = createOpenAiRecordingProvider({ connected: false, workspaceId: "local-workspace", native: value.native, environment: null });
    expect(provider.availability()).toMatchObject({ status: "unavailable" });
    await expect(provider.start()).rejects.toMatchObject({ code: "unavailable" });
  });
});
