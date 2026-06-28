import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SpeechToTextProvider } from "@fable/connectors";
import { useVoice } from "./useVoice";

function provider(start?: SpeechToTextProvider["start"]): {
  provider: SpeechToTextProvider;
  dispose: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  return {
    dispose,
    cancel,
    provider: {
      descriptor: {
        id: "test",
        kind: "local",
        label: "Test local",
        retainsAudio: false
      },
      processingDisclosure: "Processed locally.",
      start:
        start ??
        vi.fn(async () => ({
          stop: async () => "reviewed transcript",
          cancel,
          dispose
        }))
    }
  };
}

describe("useVoice", () => {
  it("records deliberately, processes, reviews, edits, and submits", async () => {
    const fixture = provider();
    const submit = vi.fn();
    const { result } = renderHook(() => useVoice(fixture.provider, submit));

    await act(result.current.start);
    expect(result.current.state.status).toBe("recording");
    await act(result.current.stop);
    expect(result.current.state.status).toBe("review");
    expect(fixture.dispose).toHaveBeenCalledOnce();
    act(() => result.current.updateTranscript("edited transcript"));
    act(result.current.submit);
    expect(submit).toHaveBeenCalledWith("edited transcript");
    expect(result.current.state.status).toBe("idle");
  });

  it("disposes temporary audio/session state after cancellation and STT failure", async () => {
    const fixture = provider();
    const { result } = renderHook(() => useVoice(fixture.provider, vi.fn()));
    await act(result.current.start);
    await act(result.current.cancel);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();

    const failedDispose = vi.fn(async () => {});
    const failed: SpeechToTextProvider = {
      ...fixture.provider,
      start: async () => ({
        stop: async () => {
          throw new Error("STT unavailable");
        },
        cancel: async () => {},
        dispose: failedDispose
      })
    };
    const second = renderHook(() => useVoice(failed, vi.fn()));
    await act(second.result.current.start);
    await act(second.result.current.stop);
    expect(second.result.current.state.status).toBe("error");
    expect(second.result.current.state.error).toContain("STT unavailable");
    expect(failedDispose).toHaveBeenCalledOnce();
  });
});
