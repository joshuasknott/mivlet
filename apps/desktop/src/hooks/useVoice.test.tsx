import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SpeechToTextError,
  type SpeechToTextProvider,
  type SpeechToTextSession
} from "@fable/connectors";
import { useVoice } from "./useVoice";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(
  overrides: Partial<SpeechToTextProvider> = {}
): {
  provider: SpeechToTextProvider;
  result: ReturnType<typeof deferred<string>>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const result = deferred<string>();
  const stop = vi.fn(async () => {});
  const cancel = vi.fn(async () => result.reject(new SpeechToTextError("cancelled", "Cancelled.")));
  const dispose = vi.fn(async () => {});
  const session: SpeechToTextSession = { result: result.promise, stop, cancel, dispose };
  return {
    result,
    stop,
    cancel,
    dispose,
    provider: {
      descriptor: { id: "test", kind: "local", label: "Test", retainsAudio: false },
      capability: {
        status: "supported",
        provider: { id: "test", kind: "local", label: "Test", retainsAudio: false }
      },
      processingDisclosure: "Processed locally.",
      start: vi.fn(async () => session),
      ...overrides
    }
  };
}

describe("useVoice", () => {
  it("is disabled by default and never touches the provider", async () => {
    const voice = fixture();
    const { result } = renderHook(() => useVoice(voice.provider, false, vi.fn()));
    expect(result.current.state.status).toBe("disabled");
    await act(result.current.start);
    expect(voice.provider.start).not.toHaveBeenCalled();
  });

  it("surfaces unavailable capability without starting", async () => {
    const voice = fixture({
      capability: {
        status: "unavailable",
        provider: { id: "test", kind: "local", label: "Test", retainsAudio: false },
        reason: "No speech API."
      }
    });
    const { result } = renderHook(() => useVoice(voice.provider, true, vi.fn()));
    expect(result.current.state).toEqual({ status: "unavailable", reason: "No speech API." });
    await act(result.current.start);
    expect(voice.provider.start).not.toHaveBeenCalled();
  });

  it("runs explicit active, processing, successful review, edit, and accept states", async () => {
    const voice = fixture();
    const accept = vi.fn();
    const { result } = renderHook(() => useVoice(voice.provider, true, accept));

    await act(result.current.start);
    expect(result.current.state.status).toBe("active");
    await act(result.current.stop);
    expect(result.current.state.status).toBe("processing");
    await act(async () => voice.result.resolve(" review me "));
    expect(result.current.state).toEqual({ status: "successful", transcript: "review me" });
    act(() => result.current.updateTranscript("edited transcript"));
    act(result.current.accept);
    expect(accept).toHaveBeenCalledWith("edited transcript");
    expect(result.current.state.status).toBe("idle");
    expect(voice.dispose).toHaveBeenCalledOnce();
  });

  it("classifies permission denial and runtime failure", async () => {
    const denial = fixture({
      start: vi.fn(async () => {
        throw new SpeechToTextError("permission-denied", "Allow microphone access and retry.");
      })
    });
    const denied = renderHook(() => useVoice(denial.provider, true, vi.fn()));
    await act(denied.result.current.start);
    expect(denied.result.current.state).toEqual({
      status: "permission-denied",
      message: "Allow microphone access and retry."
    });

    const failure = fixture();
    const failed = renderHook(() => useVoice(failure.provider, true, vi.fn()));
    await act(failed.result.current.start);
    await act(async () => failure.result.reject(new SpeechToTextError("network", "Service offline.")));
    expect(failed.result.current.state).toEqual({
      status: "failed",
      code: "network",
      message: "Service offline."
    });
  });

  it("blocks repeated activation and disposes a late session after cancellation", async () => {
    const pending = deferred<SpeechToTextSession>();
    const lateResult = deferred<string>();
    lateResult.promise.catch(() => {});
    const cancel = vi.fn(async () => lateResult.reject(new SpeechToTextError("cancelled", "Cancelled.")));
    const dispose = vi.fn(async () => {});
    const provider = fixture({
      start: vi.fn(() => pending.promise)
    }).provider;
    const { result } = renderHook(() => useVoice(provider, true, vi.fn()));

    act(() => {
      void result.current.start();
      void result.current.start();
    });
    expect(provider.start).toHaveBeenCalledOnce();
    await act(result.current.cancel);
    expect(result.current.state.status).toBe("cancelled");
    await act(async () => pending.resolve({
      result: lateResult.promise,
      stop: async () => {},
      cancel,
      dispose
    }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("cancelled");
  });

  it("cancels and disposes when disabled or unmounted, ignoring stale success", async () => {
    const voice = fixture();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useVoice(voice.provider, enabled, vi.fn()),
      { initialProps: { enabled: true } }
    );
    await act(result.current.start);
    rerender({ enabled: false });
    expect(result.current.state.status).toBe("disabled");
    await waitFor(() => {
      expect(voice.cancel).toHaveBeenCalledOnce();
      expect(voice.dispose).toHaveBeenCalledOnce();
    });
    await act(async () => voice.result.resolve("stale transcript"));
    expect(result.current.state.status).toBe("disabled");

    const second = fixture();
    const mounted = renderHook(() => useVoice(second.provider, true, vi.fn()));
    await act(mounted.result.current.start);
    unmount();
    mounted.unmount();
    await waitFor(() => {
      expect(second.cancel).toHaveBeenCalledOnce();
      expect(second.dispose).toHaveBeenCalledOnce();
    });
  });
});
