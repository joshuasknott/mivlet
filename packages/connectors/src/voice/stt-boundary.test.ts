import { describe, expect, it, vi } from "vitest";
import { createBrowserSpeechProvider } from "./stt-boundary";

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
    expect(await session.stop()).toBe("review me");
    await session.dispose();
    expect(recognition!.onresult).toBeNull();
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
    await session.cancel();
    await session.dispose();
    expect(abort).toHaveBeenCalledOnce();
  });
});
