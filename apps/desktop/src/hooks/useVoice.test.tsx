import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SpeechToTextError,
  type SpeechToTextProvider,
  type SpeechToTextSession
} from "@fable/connectors";
import type { VoiceCapability } from "@fable/protocol";
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
    expect(fixture.session.stop).toHaveBeenCalledOnce();
    await act(async () => fixture.result.resolve(" dictated once "));
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("dictated once");
    expect(result.current.state.status).toBe("success");
    expect(fixture.session.dispose).toHaveBeenCalledOnce();
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

    expect(onTranscript).toHaveBeenCalledOnce();
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
});
