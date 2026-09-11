import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechProvider,
  detectBrowserSpeechCapability,
  SpeechToTextError
} from "./stt-boundary";

function recognitionFixture() {
  let current!: FakeRecognition;

  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onstart: (() => void) | null = null;
    onresult:
      | ((event: {
          resultIndex: number;
          results: ArrayLike<{
            0: { transcript: string };
            isFinal: boolean;
          }>;
        }) => void)
      | null = null;
    onerror: ((event: { error: string; message?: string }) => void) | null =
      null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();

    constructor() {
      current = this;
    }

    emitStart() {
      this.onstart?.();
    }

    emitResult(
      results: Array<{
        transcript: string;
        final: boolean;
      }>,
      resultIndex = 0
    ) {
      this.onresult?.({
        resultIndex,
        results: results.map(({ transcript, final }) => ({
          0: { transcript },
          isFinal: final
        }))
      });
    }

    emitError(error: string, message?: string) {
      this.onerror?.({ error, message });
    }

    emitEnd() {
      this.onend?.();
    }
  }

  const provider = createBrowserSpeechProvider({
    SpeechRecognition: FakeRecognition,
    navigator: { language: "en-GB" }
  } as never);

  return {
    provider,
    recognition: () => current
  };
}

describe("browser speech-to-text boundary", () => {
  it("reports unsupported runtimes without pretending to start", async () => {
    const provider = createBrowserSpeechProvider({
      navigator: { language: "en-GB" }
    } as never);

    expect(provider.availability().status).toBe("unsupported");
    await expect(provider.start()).rejects.toMatchObject({
      code: "unsupported"
    });
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

  it("does not resolve start until the platform confirms listening", async () => {
    const fixture = recognitionFixture();
    let resolved = false;
    const pending = fixture.provider.start().then((session) => {
      resolved = true;
      return session;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    fixture.recognition().emitStart();
    const session = await pending;
    expect(resolved).toBe(true);
    session.cancel();
    session.dispose();
  });

  it("commits ordered final results once and ignores interim or repeated finals", async () => {
    const fixture = recognitionFixture();
    const pending = fixture.provider.start();
    fixture.recognition().emitStart();
    const session = await pending;

    fixture.recognition().emitResult([
      { transcript: "interim", final: false }
    ]);
    fixture.recognition().emitResult([
      { transcript: "hello", final: true },
      { transcript: "world", final: true }
    ]);
    fixture.recognition().emitResult(
      [
        { transcript: "duplicate", final: true },
        { transcript: "world", final: true }
      ],
      0
    );
    session.stop();
    session.stop();
    fixture.recognition().emitEnd();
    fixture.recognition().emitEnd();

    await expect(session.completion).resolves.toBe("hello world");
    expect(fixture.recognition().stop).toHaveBeenCalledOnce();
    session.dispose();
    expect(fixture.recognition().onresult).toBeNull();
  });

  it("includes a final result delivered between stop and natural end", async () => {
    const fixture = recognitionFixture();
    const pending = fixture.provider.start();
    fixture.recognition().emitStart();
    const session = await pending;

    session.stop();
    fixture.recognition().emitResult([
      { transcript: "finalized", final: true }
    ]);
    fixture.recognition().emitEnd();

    await expect(session.completion).resolves.toBe("finalized");
    expect(fixture.recognition().stop).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("ignores final results delivered after the recognizer ended", async () => {
    const fixture = recognitionFixture();
    const pending = fixture.provider.start();
    fixture.recognition().emitStart();
    const session = await pending;

    fixture.recognition().emitResult([
      { transcript: "committed", final: true }
    ]);
    fixture.recognition().emitEnd();
    fixture.recognition().emitResult(
      [{ transcript: "late", final: true }],
      0
    );

    await expect(session.completion).resolves.toBe("committed");
    session.dispose();
    expect(fixture.recognition().onresult).toBeNull();
  });

  it("maps permission denial before start and runtime failures after start", async () => {
    const denied = recognitionFixture();
    const deniedStart = denied.provider.start();
    denied.recognition().emitError("not-allowed");
    await expect(deniedStart).rejects.toMatchObject({
      code: "permission-denied"
    });

    const failed = recognitionFixture();
    const failedStart = failed.provider.start();
    failed.recognition().emitStart();
    const session = await failedStart;
    failed.recognition().emitError("network");
    await expect(session.completion).rejects.toMatchObject({
      code: "runtime-failure"
    });
    session.dispose();
  });

  it("treats service policy denial as permission denial and hides platform detail", async () => {
    const denied = recognitionFixture();
    const deniedStart = denied.provider.start();
    denied.recognition().emitError(
      "service-not-allowed",
      "token=secret-platform-detail"
    );

    await expect(deniedStart).rejects.toEqual(
      new SpeechToTextError(
        "permission-denied",
        "Microphone permission was denied. Allow microphone access in system or browser settings, then try again."
      )
    );
  });

  it("treats natural end without final speech as an empty result", async () => {
    const fixture = recognitionFixture();
    const pending = fixture.provider.start();
    fixture.recognition().emitStart();
    const session = await pending;
    fixture.recognition().emitResult([
      { transcript: "not final", final: false }
    ]);
    fixture.recognition().emitEnd();

    await expect(session.completion).rejects.toEqual(
      expect.objectContaining<Partial<SpeechToTextError>>({
        code: "empty-result"
      })
    );
    session.dispose();
  });

  it("cancels and disposes active recognition idempotently", async () => {
    const fixture = recognitionFixture();
    const pending = fixture.provider.start();
    fixture.recognition().emitStart();
    const session = await pending;

    session.cancel();
    session.cancel();
    await expect(session.completion).rejects.toMatchObject({
      code: "cancelled"
    });
    expect(fixture.recognition().abort).toHaveBeenCalledOnce();
    session.dispose();
    session.dispose();
    expect(fixture.recognition().onend).toBeNull();
  });

  it("normalizes synchronous platform start failures", async () => {
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart = null;
      onresult = null;
      onerror = null;
      onend = null;
      start() {
        throw new DOMException("platform detail");
      }
      stop() {}
      abort() {}
    }
    const provider = createBrowserSpeechProvider({
      SpeechRecognition: FakeRecognition,
      navigator: { language: "en-GB" }
    } as never);
    await expect(provider.start()).rejects.toEqual(
      new SpeechToTextError(
        "startup-failure",
        "Dictation could not start. Text input is still available."
      )
    );
  });

  it("times out startup, aborts once, and rejects with safe copy", async () => {
    vi.useFakeTimers();
    try {
      const fixture = recognitionFixture();
      const pending = fixture.provider.start();
      const assertion = expect(pending).rejects.toEqual(
        new SpeechToTextError(
          "startup-failure",
          "Dictation did not start in time. You can continue typing."
        )
      );

      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      expect(fixture.recognition().abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stopping and aborts exactly once", async () => {
    vi.useFakeTimers();
    try {
      const fixture = recognitionFixture();
      const pendingStart = fixture.provider.start();
      fixture.recognition().emitStart();
      const session = await pendingStart;
      session.stop();
      const assertion = expect(session.completion).rejects.toMatchObject({
        code: "runtime-failure"
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      session.dispose();
      expect(fixture.recognition().abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts pending startup exactly once when its signal is cancelled", async () => {
    const fixture = recognitionFixture();
    const controller = new AbortController();
    const pending = fixture.provider.start({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.recognition().abort).toHaveBeenCalledOnce();
  });
});
