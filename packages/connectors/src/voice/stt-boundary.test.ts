import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechProvider,
  detectBrowserSpeechCapability,
  SpeechToTextError
} from "./stt-boundary";

describe("speech-to-text boundary", () => {
  it("reports processing honestly and disposes transcript state after success", async () => {
    let recognition: {
      onresult: ((event: never) => void) | null;
      onend: (() => void) | null;
      stop: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    };
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: never) => void) | null = null;
      onerror = null;
      onend: (() => void) | null = null;
      stop = vi.fn(() => this.onend?.());
      abort = vi.fn();
      start = vi.fn(() => {
        recognition = this;
        this.onresult?.({ results: [{ 0: { transcript: "review me" }, isFinal: true }] } as never);
      });
      constructor() {
        recognition = this;
      }
    }
    const provider = createBrowserSpeechProvider({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never);
    expect(provider.descriptor.kind).toBe("remote");
    expect(provider.descriptor.retainsAudio).toBe(false);
    const session = await provider.start();
    await session.stop();
    expect(await session.result).toBe("review me");
    await session.dispose();
    expect(recognition!.onresult).toBeNull();
  });

  it("detects support without constructing recognition or requesting permission", () => {
    const construct = vi.fn();
    class FakeRecognition {
      constructor() {
        construct();
      }
    }
    expect(detectBrowserSpeechCapability({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never).status).toBe("supported");
    expect(construct).not.toHaveBeenCalled();
    expect(detectBrowserSpeechCapability({
      navigator: { language: "en-GB" }
    } as never).status).toBe("unavailable");
  });

  it("maps browser permission denial to a typed, retryable failure", async () => {
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend = null;
      start() {
        queueMicrotask(() => this.onerror?.({ error: "not-allowed" }));
      }
      stop() {}
      abort() {}
    }
    const session = await createBrowserSpeechProvider({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never).start();
    await expect(session.result).rejects.toMatchObject({
      name: "SpeechToTextError",
      code: "permission-denied"
    });
    await session.dispose();
  });

  it("normalizes synchronous platform start failures", async () => {
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror = null;
      onend = null;
      start() {
        throw new DOMException("platform detail");
      }
      stop() {}
      abort() {}
    }
    await expect(createBrowserSpeechProvider({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never).start()).rejects.toEqual(
      new SpeechToTextError("failed", "Speech recognition could not start. Text input is still available.")
    );
  });

  it("cancels deliberate recording and disposes without retaining audio", async () => {
    const abort = vi.fn();
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {}
      abort() {
        abort();
      }
    }
    const session = await createBrowserSpeechProvider({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never).start();
    session.result.catch(() => {});
    await session.cancel();
    await session.dispose();
    expect(abort).toHaveBeenCalledOnce();
  });
});
