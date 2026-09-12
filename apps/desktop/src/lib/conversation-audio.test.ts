import { afterEach, describe, expect, it, vi } from "vitest";
import { openConversationMicrophone, playConversationAudio } from "./conversation-audio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function options(signal: AbortSignal) {
  return { signal, onStart: vi.fn(), onTurn: vi.fn(), onSilence: vi.fn(), onLevel: vi.fn(), onError: vi.fn() };
}
afterEach(() => vi.unstubAllGlobals());

describe("voice microphone resource lifetime", () => {
  it("stops a microphone granted after the user has already ended voice", async () => {
    const permission = deferred<MediaStream>();
    const stop = vi.fn();
    const track = { stop, onended: null };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission.promise } });
    vi.stubGlobal("AudioContext", vi.fn()); vi.stubGlobal("AudioWorkletNode", vi.fn());
    const abort = new AbortController();
    const opening = openConversationMicrophone(options(abort.signal));
    abort.abort();
    permission.resolve({ getTracks: () => [track] } as unknown as MediaStream);
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledOnce(); expect(AudioContext).not.toHaveBeenCalled();
  });
  it("closes tracks and context when End arrives during worklet loading", async () => {
    const loaded = deferred<void>(); const stop = vi.fn(), close = vi.fn(async () => {});
    const addModule = vi.fn(() => loaded.promise);
    const track = { stop, onended: null };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    vi.stubGlobal("AudioContext", class { resume = async () => {}; close = close; audioWorklet = { addModule }; });
    vi.stubGlobal("AudioWorkletNode", vi.fn());
    const abort = new AbortController(); const opening = openConversationMicrophone(options(abort.signal));
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledOnce());
    abort.abort(); loaded.resolve();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(AudioWorkletNode).not.toHaveBeenCalled();
  });
  it("stops playback and revokes its temporary audio URL immediately on interruption", async () => {
    const pause = vi.fn(), load = vi.fn(), removeAttribute = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:voice"), revokeObjectURL });
    vi.stubGlobal("Audio", class {
      onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
      pause = pause; load = load; removeAttribute = removeAttribute; play = async () => {};
    });
    const abort = new AbortController(); const playing = vi.fn();
    const playback = playConversationAudio("AQI=", abort.signal, playing);
    abort.abort();
    await expect(playback).rejects.toMatchObject({ name: "AbortError" });
    expect(pause).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice"); expect(playing).not.toHaveBeenCalled();
  });
});
