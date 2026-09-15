import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechProvider,
  SpeechToTextError,
  type SpeechToTextProvider,
  type SpeechToTextSession
} from "@mivlet/connectors";
import type { VoiceCapability } from "@mivlet/protocol";
import { useVoice } from "./useVoice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionFixture() {
  const result = deferred<string>();
  const session: SpeechToTextSession = {
    completion: result.promise,
    stop: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn()
  };
  return { result, session };
}

function providerFixture(
  start: SpeechToTextProvider["start"],
  availability: ReturnType<SpeechToTextProvider["availability"]> = {
    status: "available"
  },
  capability: VoiceCapability = {
    status: "supported",
    provider: { id: "test", kind: "local", label: "Test speech", retainsAudio: false }
  }
): SpeechToTextProvider {
  return {
    descriptor: {
      id: "test",
      kind: "local",
      label: "Test speech",
      retainsAudio: false
    },
    processingDisclosure: "Processed by the test platform.",
    capability,
    availability: () => availability,
    start
  };
}

describe("useVoice", () => {
  it("gates listening on confirmed start, stops, and inserts one transcript", async () => {
    const fixture = sessionFixture();
    const started = deferred<SpeechToTextSession>();
    const onTranscript = vi.fn();
    const provider = providerFixture(vi.fn(() => started.promise));
    const { result } = renderHook(() => useVoice(provider, onTranscript));

    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start();
    });
    expect(result.current.state.status).toBe("starting");
    await act(async () => {
      started.resolve(fixture.session);
      await starting;
    });
    expect(result.current.state.status).toBe("listening");

    act(result.current.stop);
    expect(result.current.state.status).toBe("stopping");
    expect(result.current.state.message).toBe("Stopping dictation…");
    expect(fixture.session.stop).toHaveBeenCalledOnce();
    await act(async () => fixture.result.resolve(" dictated once "));
    expect(["processing", "success"]).toContain(result.current.state.status);
    await waitFor(() => expect(result.current.state.status).toBe("success"));
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("dictated once");
    expect(result.current.state.status).toBe("success");
    expect(fixture.session.dispose).toHaveBeenCalledOnce();
  });

  it("holds a recorded draft for explicit review before transcription", async () => {
    const transcript = deferred<string>();
    const review = deferred<{
      recordingId: string; durationMs: number; sizeBytes: number; mediaType: string;
      providerLabel: string; model: "gpt-4o-mini-transcribe"; maxDurationMs: number;
    }>();
    const authorize = vi.fn();
    const session: SpeechToTextSession = {
      completion: transcript.promise,
      review: review.promise,
      authorize,
      stop: vi.fn(), cancel: vi.fn(), dispose: vi.fn()
    };
    const onTranscript = vi.fn();
    const provider = providerFixture(async () => session);
    const { result } = renderHook(() => useVoice(provider, onTranscript));
    await act(result.current.start);
    act(result.current.stop);
    await act(async () => review.resolve({
      recordingId: "recording-1", durationMs: 2_000, sizeBytes: 512,
      mediaType: "audio/webm", providerLabel: "OpenAI transcription",
      model: "gpt-4o-mini-transcribe", maxDurationMs: 120_000
    }));
    expect(result.current.state.status).toBe("reviewing");
    expect(result.current.review).toMatchObject({ recordingId: "recording-1", sizeBytes: 512 });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();

    act(result.current.authorize);
    expect(authorize).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("processing");
    await act(async () => transcript.resolve("reviewed transcript"));
    await waitFor(() => expect(result.current.state.status).toBe("success"));
    expect(onTranscript).toHaveBeenCalledWith("reviewed transcript");
  });

  it("blocks double activation while startup is pending", async () => {
    const fixture = sessionFixture();
    const started = deferred<SpeechToTextSession>();
    const start = vi.fn(() => started.promise);
    const { result } = renderHook(() =>
      useVoice(providerFixture(start), vi.fn())
    );

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.start();
      void result.current.start();
    });
    expect(start).toHaveBeenCalledOnce();
    await act(async () => {
      started.resolve(fixture.session);
      await first;
    });
    act(result.current.cancel);
  });

  it("remains operational through the React StrictMode lifecycle probe", async () => {
    const fixture = sessionFixture();
    const provider = providerFixture(async () => fixture.session);
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(() => useVoice(provider, vi.fn()), { wrapper });

    await act(result.current.start);

    expect(result.current.state.status).toBe("listening");
    expect(fixture.session.cancel).not.toHaveBeenCalled();
  });

  it("cancels pending startup and disposes a stale late session", async () => {
    const fixture = sessionFixture();
    const started = deferred<SpeechToTextSession>();
    const cancelled = vi.fn();
    const provider = providerFixture(() => started.promise);
    const { result } = renderHook(() =>
      useVoice(provider, vi.fn(), {
        onCancel: cancelled
      })
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start();
    });
    act(result.current.cancel);
    expect(result.current.state.status).toBe("cancelled");
    expect(cancelled).toHaveBeenCalledOnce();

    await act(async () => {
      started.resolve(fixture.session);
      await pending;
    });
    expect(fixture.session.cancel).toHaveBeenCalledOnce();
    expect(fixture.session.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["permission-denied", "permission-denied"],
    ["unavailable", "unavailable"],
    ["startup-failure", "error"],
    ["runtime-failure", "error"],
    ["empty-result", "error"]
  ] as const)("surfaces %s without inserting text", async (code, status) => {
    const onTranscript = vi.fn();
    const provider = providerFixture(() =>
      Promise.reject(new SpeechToTextError(code, `Failure: ${code}`))
    );
    const { result } = renderHook(() => useVoice(provider, onTranscript));

    await act(result.current.start);
    expect(result.current.state.status).toBe(status);
    expect(result.current.state.errorCode).toBe(code);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("represents disabled and unsupported states honestly", () => {
    const unsupported = providerFixture(
      vi.fn(),
      { status: "unsupported", message: "Not supported here." }
    );
    const first = renderHook(() => useVoice(unsupported, vi.fn()));
    expect(first.result.current.state.status).toBe("unsupported");
    expect(first.result.current.canStart).toBe(false);

    const available = providerFixture(vi.fn());
    const second = renderHook(() =>
      useVoice(available, vi.fn(), { disabled: true })
    );
    expect(second.result.current.state.status).toBe("disabled");
    expect(second.result.current.canStart).toBe(false);
  });

  it("exposes the provider capability descriptor", () => {
    const start = vi.fn();
    const capability: VoiceCapability = {
      status: "unavailable",
      provider: { id: "test", kind: "local", label: "Test", retainsAudio: false },
      reason: "No speech API."
    };
    const provider = providerFixture(start, { status: "unavailable", message: "No speech API." }, capability);
    const { result } = renderHook(() => useVoice(provider, vi.fn()));
    expect(result.current.capability).toEqual(capability);
  });

  it("cancels and disposes without updating after teardown", async () => {
    const fixture = sessionFixture();
    const provider = providerFixture(async () => fixture.session);
    const onTranscript = vi.fn();
    const rendered = renderHook(() => useVoice(provider, onTranscript));
    await act(rendered.result.current.start);
    rendered.unmount();
    expect(fixture.session.cancel).toHaveBeenCalledOnce();
    expect(fixture.session.dispose).toHaveBeenCalledOnce();

    fixture.result.resolve("too late");
    await Promise.resolve();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("ignores stale completion after cancellation and a new start", async () => {
    const first = sessionFixture();
    const second = sessionFixture();
    const start = vi
      .fn<SpeechToTextProvider["start"]>()
      .mockResolvedValueOnce(first.session)
      .mockResolvedValueOnce(second.session);
    const onTranscript = vi.fn();
    const provider = providerFixture(start);
    const { result } = renderHook(() => useVoice(provider, onTranscript));

    await act(result.current.start);
    act(result.current.cancel);
    await act(result.current.start);
    await act(async () => {
      first.result.resolve("stale");
      second.result.resolve("current");
    });

    await waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());
    expect(onTranscript).toHaveBeenCalledWith("current");
  });

  it("tears down active recognition when dictation becomes disabled", async () => {
    const fixture = sessionFixture();
    const provider = providerFixture(async () => fixture.session);
    const rendered = renderHook(
      ({ disabled }) => useVoice(provider, vi.fn(), { disabled }),
      { initialProps: { disabled: false } }
    );

    await act(rendered.result.current.start);
    rendered.rerender({ disabled: true });

    expect(rendered.result.current.state.status).toBe("disabled");
    expect(fixture.session.cancel).toHaveBeenCalledOnce();
    expect(fixture.session.dispose).toHaveBeenCalledOnce();
  });

  it("resets lifecycle state silently when the composer hides", async () => {
    const fixture = sessionFixture();
    const onCancel = vi.fn();
    const provider = providerFixture(async () => fixture.session);
    const { result } = renderHook(() =>
      useVoice(provider, vi.fn(), { onCancel })
    );

    await act(result.current.start);
    act(result.current.reset);

    expect(result.current.state.status).toBe("idle");
    expect(fixture.session.cancel).toHaveBeenCalledOnce();
    expect(fixture.session.dispose).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("normalizes unknown failures without exposing provider details", async () => {
    const provider = providerFixture(() =>
      Promise.reject(new Error("token=secret-provider-detail"))
    );
    const { result } = renderHook(() => useVoice(provider, vi.fn()));

    await act(result.current.start);

    expect(result.current.state).toMatchObject({
      status: "error",
      message: "Dictation failed. Your typed prompt was left unchanged."
    });
    expect(result.current.state.message).not.toContain("secret-provider-detail");
  });

  it("returns focus through the callback when a terminal state is dismissed", async () => {
    const onReturnToText = vi.fn();
    const provider = providerFixture(() =>
      Promise.reject(new SpeechToTextError("runtime-failure", "Safe failure."))
    );
    const { result } = renderHook(() =>
      useVoice(provider, vi.fn(), { onCancel: onReturnToText })
    );
    await act(result.current.start);

    act(result.current.dismiss);

    expect(result.current.state.status).toBe("idle");
    expect(onReturnToText).toHaveBeenCalledOnce();
  });
});

interface FakeRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}

function browserVoiceFixture() {
  const recognitions: Array<{
    onstart: (() => void) | null;
    onresult: ((event: FakeRecognitionEvent) => void) | null;
    onerror: ((event: { error: string; message?: string }) => void) | null;
    onend: (() => void) | null;
    abort: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onstart: (() => void) | null = null;
    onresult: ((event: FakeRecognitionEvent) => void) | null = null;
    onerror: ((event: { error: string; message?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();

    constructor() {
      recognitions.push(this);
    }
  }

  const provider = createBrowserSpeechProvider({
    SpeechRecognition: FakeSpeechRecognition,
    navigator: { language: "en-GB" }
  } as never);

  const latest = () => recognitions[recognitions.length - 1];

  return {
    provider,
    recognitions,
    latest,
    emitStart() {
      act(() => latest().onstart?.());
    },
    emitResult(transcript: string, resultIndex = 0) {
      act(() =>
        latest().onresult?.({
          resultIndex,
          results: [{ 0: { transcript }, isFinal: true }]
        })
      );
    },
    emitError(error: string, message?: string) {
      act(() => latest().onerror?.({ error, message }));
    },
    emitEnd() {
      act(() => latest().onend?.());
    }
  };
}

describe("useVoice against the real browser speech boundary", () => {
  it("surfaces a start failure and restores the start control", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    expect(result.current.state.status).toBe("starting");
    fixture.emitError("network");
    await act(async () => started);

    expect(result.current.state.status).toBe("error");
    expect(result.current.state.errorCode).toBe("startup-failure");
    expect(result.current.canStart).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("maps permission denial without inserting text", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitError("not-allowed");
    await act(async () => started);

    expect(result.current.state.status).toBe("permission-denied");
    expect(result.current.state.errorCode).toBe("permission-denied");
    expect(result.current.canStart).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("inserts a final result delivered between stop and end exactly once", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    expect(result.current.state.status).toBe("listening");

    act(result.current.stop);
    expect(result.current.state.status).toBe("stopping");
    fixture.emitResult("late final");
    fixture.emitEnd();

    await waitFor(() => expect(result.current.state.status).toBe("success"));
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("late final");
  });

  it("delivers each round's transcript to its own session on rapid stop/start", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    act(result.current.stop);
    fixture.emitResult("first");
    fixture.emitEnd();
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("first"));

    act(() => {
      started = result.current.start();
    });
    expect(fixture.recognitions).toHaveLength(2);
    fixture.emitStart();
    await act(async () => started);
    expect(result.current.state.status).toBe("listening");
    act(result.current.stop);
    fixture.emitResult("second");
    fixture.emitEnd();
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("second"));

    expect(onTranscript).toHaveBeenCalledTimes(2);
  });

  it("never inserts a late transcript into a different conversation scope", async () => {
    const fixture = browserVoiceFixture();
    const firstScope = vi.fn();
    const secondScope = vi.fn();
    const { result, rerender } = renderHook(
      ({ onTranscript }) => useVoice(fixture.provider, onTranscript),
      { initialProps: { onTranscript: firstScope } }
    );

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    expect(result.current.state.status).toBe("listening");

    rerender({ onTranscript: secondScope });
    fixture.emitResult("cross scope");
    fixture.emitEnd();

    await waitFor(() => expect(firstScope).toHaveBeenCalled());
    expect(firstScope).toHaveBeenCalledWith("cross scope");
    expect(secondScope).not.toHaveBeenCalled();
  });

  it("settles one transcript across duplicate results and duplicate end events", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    act(result.current.stop);
    fixture.emitResult("only once");
    fixture.emitResult("only once", 0);
    fixture.emitEnd();
    fixture.emitEnd();
    fixture.emitResult("too late", 0);

    await waitFor(() => expect(result.current.state.status).toBe("success"));
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("only once");
  });

  it("drops late callbacks and detaches the recognizer on unmount", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const rendered = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = rendered.result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    const recognition = fixture.latest();
    rendered.unmount();

    expect(recognition.abort).toHaveBeenCalledOnce();
    fixture.emitResult("too late");
    fixture.emitEnd();
    fixture.emitError("network");
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(recognition.onresult).toBeNull();
    expect(recognition.onerror).toBeNull();
    expect(recognition.onend).toBeNull();
  });

  it("reports a runtime failure after listening without leaving the UI recording", async () => {
    const fixture = browserVoiceFixture();
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, onTranscript));

    let started!: Promise<void>;
    act(() => {
      started = result.current.start();
    });
    fixture.emitStart();
    await act(async () => started);
    expect(result.current.state.status).toBe("listening");

    fixture.emitError("network");

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.errorCode).toBe("runtime-failure");
    expect(result.current.canStart).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
