import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceConversationState } from "@fable/protocol";
import { VoiceConversationController, type VoiceConversationAudio, type VoicePromptControl } from "./conversation-controller";
import type { VoiceConversationPort } from "./conversation";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const scope = { workspaceId: "workspace", agentId: "agent", threadId: "thread" };
function fixture() {
  let callbacks!: Parameters<VoiceConversationAudio["open"]>[0];
  let state!: VoiceConversationState;
  const microphone = { close: vi.fn(), setEnabled: vi.fn(), finish: vi.fn(), echoCancellation: true };
  const session = { ...scope, sessionId: "session", expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
  const port: VoiceConversationPort = {
    start: vi.fn(async () => session), heartbeat: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), end: vi.fn(async () => {}),
    transcribe: vi.fn(async () => ({ transcript: "Hello there" })), speak: vi.fn(async () => ({ audioBase64: "audio" })),
  };
  const play = vi.fn(async (_audio: string, _signal: AbortSignal, playing: () => void) => { playing(); });
  const prompt = vi.fn(async (_text: string, control: VoicePromptControl) => { control.onText("Hello. How can I help?"); });
  const controller = new VoiceConversationController({ scope, voice: "marin", port, audio: { open: async (options) => { callbacks = options; return microphone; }, play }, onPrompt: prompt, onState: (value) => { state = value; }, onLevel: vi.fn() });
  const talk = () => { callbacks.onStart(); callbacks.onTurn(new Uint8Array([1, 2])); };
  return { controller, port, microphone, session, prompt, play, talk, state: () => state, callbacks: () => callbacks };
}
afterEach(() => { vi.useRealTimers(); });

describe("voice conversation", () => {
  it("automatically submits utterances to the selected agent, speaks confirmed text, then listens again", async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.state().phase).toBe("listening");
    f.talk();
    await vi.waitFor(() => expect(f.play).toHaveBeenCalledTimes(2));
    expect(f.prompt).toHaveBeenCalledWith("Hello there", expect.objectContaining({ signal: expect.any(AbortSignal), onText: expect.any(Function) }));
    expect(f.state()).toMatchObject({ phase: "listening", userCaption: "Hello there", agentCaption: "Hello. How can I help?" });
    expect(f.port.transcribe).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, session: f.session }));
    const requests = vi.mocked(f.port.speak).mock.calls.map(([request]) => request.requestId);
    expect(new Set(requests).size).toBe(2);
    f.controller.end();
  });

  it("can speak a complete sentence while the agent is still generating", async () => {
    const f = fixture(); const done = deferred<void>();
    f.prompt.mockImplementationOnce(async (_text, control) => { control.onText("Let me check that. "); await done.promise; control.onText("It is ready."); });
    await f.controller.start(); f.talk();
    await vi.waitFor(() => expect(f.play).toHaveBeenCalledOnce());
    expect(f.state().agentCaption).toBe("Let me check that. ");
    done.resolve();
    await vi.waitFor(() => expect(f.play).toHaveBeenCalledTimes(2));
    f.controller.end();
  });

  it("prepares only one sentence ahead of playback", async () => {
    const f = fixture(); const firstPlayback = deferred<void>();
    f.prompt.mockImplementationOnce(async (_text, control) => control.onText("First sentence. Second sentence. Third sentence. Fourth sentence."));
    f.play.mockImplementationOnce(async (_audio, _signal, playing) => { playing(); await firstPlayback.promise; });
    await f.controller.start(); f.talk();
    await vi.waitFor(() => expect(f.play).toHaveBeenCalledOnce());
    expect(f.port.speak).toHaveBeenCalledTimes(2);
    firstPlayback.resolve();
    await vi.waitFor(() => expect(f.play).toHaveBeenCalledTimes(4));
    f.controller.end();
  });

  it("drops a late transcript after interruption and never submits it to the agent", async () => {
    const f = fixture(); const transcript = deferred<{ transcript: string }>();
    vi.mocked(f.port.transcribe).mockReturnValueOnce(transcript.promise);
    await f.controller.start(); f.talk();
    await vi.waitFor(() => expect(f.port.transcribe).toHaveBeenCalledOnce());
    f.controller.interrupt(); transcript.resolve({ transcript: "stale words" });
    await Promise.resolve(); await Promise.resolve();
    expect(f.prompt).not.toHaveBeenCalled(); expect(f.port.speak).not.toHaveBeenCalled();
    f.controller.end();
  });

  it("barge-in immediately aborts playback and fences late agent text", async () => {
    const f = fixture(); let playbackSignal!: AbortSignal; let control!: VoicePromptControl;
    const done = deferred<void>();
    f.prompt.mockImplementationOnce(async (_text, value) => { control = value; value.onText("First response. "); await done.promise; });
    f.play.mockImplementationOnce((_audio, signal, playing) => new Promise((resolve) => { playbackSignal = signal; playing(); signal.addEventListener("abort", () => resolve(), { once: true }); }));
    await f.controller.start(); f.talk();
    await vi.waitFor(() => expect(f.state().phase).toBe("speaking"));
    f.callbacks().onStart();
    expect(playbackSignal.aborted).toBe(true); expect(control.signal.aborted).toBe(true);
    control.onText("Stale response. ");
    expect(f.state().agentCaption).not.toContain("Stale");
    done.resolve(); f.controller.end();
  });

  it("waits for the interrupted agent to settle before submitting the next voice turn", async () => {
    const f = fixture(); const old = deferred<void>();
    f.prompt.mockImplementationOnce(async () => old.promise);
    await f.controller.start(); f.talk();
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    f.talk(); await Promise.resolve(); await Promise.resolve();
    expect(f.port.transcribe).toHaveBeenCalledOnce();
    old.resolve();
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(2));
    f.controller.end();
  });

  it("mute discards unsent speech; pending approvals pause capture and can still be interrupted", async () => {
    const f = fixture(); const done = deferred<void>(); let control!: VoicePromptControl;
    await f.controller.start(); f.callbacks().onStart(); f.controller.setMuted(true);
    f.callbacks().onTurn(new Uint8Array([1]));
    expect(f.port.transcribe).not.toHaveBeenCalled();
    expect(f.microphone.setEnabled).toHaveBeenLastCalledWith(false);
    f.controller.setMuted(false);
    f.prompt.mockImplementationOnce(async (_text, value) => { control = value; await done.promise; });
    f.talk(); await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    f.controller.setPaused(true);
    expect(f.microphone.setEnabled).toHaveBeenLastCalledWith(false);
    f.controller.interrupt(); expect(control.signal.aborted).toBe(true);
    done.resolve(); f.controller.end();
  });

  it("closes late microphone access when End is pressed during connection", async () => {
    const mic = deferred<Awaited<ReturnType<VoiceConversationAudio["open"]>>>();
    const f = fixture(); const stopped = vi.fn();
    const controller = new VoiceConversationController({ scope, voice: "marin", port: f.port, audio: { open: () => mic.promise, play: f.play }, onPrompt: f.prompt, onState: vi.fn(), onLevel: vi.fn() });
    const starting = controller.start();
    await Promise.resolve(); controller.end(); mic.resolve({ ...f.microphone, close: stopped }); await starting;
    expect(stopped).toHaveBeenCalledOnce(); expect(f.port.end).toHaveBeenCalledWith(f.session);
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("ends on expired native authority without reopening the microphone", async () => {
    vi.useFakeTimers(); const f = fixture();
    vi.mocked(f.port.heartbeat).mockRejectedValueOnce(new Error("Voice expired"));
    await f.controller.start(); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.state()).toMatchObject({ phase: "error", error: "Voice expired" });
    expect(f.microphone.close).toHaveBeenCalled(); expect(f.port.end).toHaveBeenCalled();
  });

  it("suspends capture during output when the microphone cannot cancel echo", async () => {
    const f = fixture(); f.microphone.echoCancellation = false;
    f.play.mockImplementationOnce(async (_audio, _signal, playing) => { playing(); expect(f.microphone.setEnabled).toHaveBeenLastCalledWith(false); });
    await f.controller.start(); f.talk(); await vi.waitFor(() => expect(f.play).toHaveBeenCalledTimes(2));
    expect(f.microphone.setEnabled).toHaveBeenLastCalledWith(true); f.controller.end();
  });
});
