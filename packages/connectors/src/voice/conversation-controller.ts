import type { ConversationVoice, VoiceConversationScope, VoiceConversationSession, VoiceConversationState } from "@mivlet/protocol";
import { bytesToBase64, takeSpeechChunk, type VoiceConversationPort } from "./conversation";

export interface VoiceMicrophone {
  setEnabled(enabled: boolean): void;
  finish(): void;
  close(): void;
  echoCancellation: boolean;
}
export interface VoiceConversationAudio {
  open(options: { signal: AbortSignal; onStart: () => void; onTurn: (wav: Uint8Array) => void; onSilence: () => void; onLevel: (level: number) => void; onError: (message: string) => void }): Promise<VoiceMicrophone>;
  play(audioBase64: string, signal: AbortSignal, onPlaying: () => void): Promise<void>;
}
export interface VoicePromptControl { signal: AbortSignal; scope: VoiceConversationScope; onText: (text: string) => void }
export const INITIAL_CONVERSATION_STATE: VoiceConversationState = {
  phase: "ready", muted: false, userCaption: "", agentCaption: "", error: null, startedAt: null, voiceInterruptionAvailable: false, generation: 0,
};
interface Turn {
  generation: number;
  abort: AbortController;
  ready: Promise<void>;
  agentWork?: Promise<void>;
  speech: Promise<void>;
  prefetchGate: Promise<void>;
  buffer: string;
  text: string;
  spokenChars: number;
  speechCapped: boolean;
  finished: boolean;
}

/** Owns one call. Every asynchronous continuation is fenced by call and turn. */
export class VoiceConversationController {
  private value = { ...INITIAL_CONVERSATION_STATE };
  private callAbort?: AbortController;
  private session?: VoiceConversationSession;
  private microphone?: VoiceMicrophone;
  private turn?: Turn;
  private generation = 0;
  private paused = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    scope: VoiceConversationScope;
    port: VoiceConversationPort;
    audio: VoiceConversationAudio;
    voice: ConversationVoice;
    onPrompt: (text: string, control: VoicePromptControl) => Promise<void>;
    onState: (state: VoiceConversationState) => void;
    onLevel: (level: number) => void;
  }) {}

  private update(next: Partial<VoiceConversationState>) {
    this.value = { ...this.value, ...next };
    this.options.onState(this.value);
  }
  private isCurrent(turn: Turn) { return this.turn === turn && !turn.abort.signal.aborted && Boolean(this.session); }
  private listen() {
    if (!this.session) return;
    this.update({ phase: this.value.muted || this.paused ? "paused" : "listening" });
    this.syncMicrophone();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.end(), 3 * 60_000);
  }
  private syncMicrophone() {
    const outputActive = this.value.phase === "speaking";
    this.microphone?.setEnabled(!this.value.muted && !this.paused && (!outputActive || this.microphone.echoCancellation));
  }
  private fail(error: unknown) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Voice stopped unexpectedly. Please reconnect.";
    this.end();
    this.update({ phase: "error", error: message });
  }

  async start() {
    if (this.callAbort) return;
    const abort = new AbortController(); this.callAbort = abort;
    this.update({ ...INITIAL_CONVERSATION_STATE, phase: "connecting" });
    try {
      const session = await this.options.port.start(this.options.scope);
      if (abort.signal.aborted) { await this.options.port.end(session); return; }
      this.session = session;
      this.generation = 0;
      this.heartbeat = setInterval(() => {
        void this.options.port.heartbeat(session).catch((error) => { if (this.session === session) this.fail(error); });
      }, 10_000);
      this.deadline = setTimeout(() => this.end(), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
      const microphone = await this.options.audio.open({
        signal: abort.signal,
        onStart: () => { if (!abort.signal.aborted) this.beginTurn(); },
        onTurn: (wav) => { if (!abort.signal.aborted) void this.submitAudio(wav); },
        onSilence: () => { if (!abort.signal.aborted && this.value.phase === "hearing") this.listen(); },
        onLevel: (level) => { if (!abort.signal.aborted) this.options.onLevel(level); },
        onError: (message) => { if (!abort.signal.aborted) this.fail(message); },
      });
      if (abort.signal.aborted) { microphone.close(); return; }
      this.microphone = microphone;
      this.update({ startedAt: Date.now(), voiceInterruptionAvailable: microphone.echoCancellation });
      this.listen();
    } catch (error) {
      if (!abort.signal.aborted) {
        this.fail(error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in Windows privacy settings, then reconnect voice." : error);
      }
    }
  }

  /** Speech onset immediately silences playback; agent cancellation must settle before the next submission. */
  private beginTurn(force = false) {
    if (!this.session || (!force && (this.value.muted || this.paused))) return;
    const previous = this.turn;
    previous?.abort.abort();
    clearTimeout(this.idle);
    const session = this.session;
    const generation = ++this.generation;
    const turn: Turn = { generation, abort: new AbortController(), ready: Promise.resolve(), speech: Promise.resolve(), prefetchGate: Promise.resolve(), buffer: "", text: "", spokenChars: 0, speechCapped: false, finished: false };
    this.turn = turn;
    turn.ready = Promise.all([
      this.options.port.interrupt(session, generation),
      previous?.agentWork?.catch(() => undefined),
    ]).then(() => undefined);
    void turn.ready.catch((error) => { if (this.isCurrent(turn)) this.fail(error); });
    this.update({ phase: "hearing", error: null, generation });
  }

  private async submitAudio(wav: Uint8Array) {
    const turn = this.turn; const session = this.session;
    if (!turn || !session || !this.isCurrent(turn) || this.value.muted || this.paused) return;
    this.update({ phase: "transcribing" });
    try {
      await turn.ready;
      if (!this.isCurrent(turn)) return;
      const result = await this.options.port.transcribe({ session, generation: turn.generation, requestId: crypto.randomUUID(), audioBase64: bytesToBase64(wav) });
      if (!this.isCurrent(turn)) return;
      const text = result.transcript.trim();
      if (!text) { this.listen(); return; }
      this.update({ phase: "thinking", userCaption: text, agentCaption: "" });
      turn.agentWork = this.options.onPrompt(text, { signal: turn.abort.signal, scope: this.options.scope, onText: (delta) => {
        if (!this.isCurrent(turn)) return;
        turn.text += delta; turn.buffer += delta;
        this.update({ agentCaption: turn.text });
        this.queueSpeech(turn, false);
      } });
      await turn.agentWork;
      if (!this.isCurrent(turn)) return;
      this.queueSpeech(turn, true);
      turn.finished = true;
      await turn.speech;
      if (this.isCurrent(turn)) this.listen();
    } catch (error) { if (this.isCurrent(turn)) this.fail(error); }
  }

  private queueSpeech(turn: Turn, final: boolean) {
    for (;;) {
      const chunk = takeSpeechChunk(turn.buffer, final);
      if (!chunk) break;
      turn.buffer = chunk.rest;
      if (!chunk.text || turn.speechCapped) continue;
      const text = turn.spokenChars >= 6000 ? "The rest of this reply is available in the conversation." : chunk.text.slice(0, 1200);
      if (turn.spokenChars >= 6000) turn.speechCapped = true;
      turn.spokenChars += text.length;
      // Prepare at most one segment ahead of playback to avoid a network pause
      // between every sentence. Native concurrency stays bounded to two TTS calls.
      const prepared = turn.prefetchGate.then(async () => {
        if (!this.isCurrent(turn) || !this.session) return;
        return this.options.port.speak({ session: this.session, generation: turn.generation, requestId: crypto.randomUUID(), text, voice: this.options.voice });
      });
      void prepared.catch((error) => { if (this.isCurrent(turn)) this.fail(error); });
      turn.prefetchGate = turn.speech;
      turn.speech = turn.speech.then(async () => {
        const audio = await prepared;
        if (!audio || !this.isCurrent(turn)) return;
        await this.options.audio.play(audio.audioBase64, turn.abort.signal, () => {
          if (this.isCurrent(turn)) { this.update({ phase: "speaking" }); this.syncMicrophone(); }
        });
        if (this.isCurrent(turn)) { this.update({ phase: turn.finished ? "listening" : "thinking" }); this.syncMicrophone(); }
      });
      void turn.speech.catch((error) => { if (this.isCurrent(turn)) this.fail(error); });
    }
  }

  interrupt() {
    if (!this.session) return;
    // Explicit interruption also works on devices without echo cancellation.
    this.beginTurn(true);
    this.listen();
  }
  finishTurn() { this.microphone?.finish(); }
  setMuted(muted: boolean) {
    if (!this.session) return;
    const unsent = this.value.phase === "hearing" || this.value.phase === "transcribing";
    if (muted && unsent) this.interrupt();
    this.update({ muted }); this.syncMicrophone();
    if (unsent || this.value.phase === "listening" || this.value.phase === "paused") this.listen();
  }
  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    if (paused && (this.value.phase === "hearing" || this.value.phase === "transcribing")) this.interrupt();
    this.paused = paused;
    this.syncMicrophone();
    if (this.session && (this.value.phase === "listening" || this.value.phase === "paused")) this.listen();
  }
  end() {
    const session = this.session;
    this.session = undefined;
    this.turn?.abort.abort(); this.turn = undefined;
    this.callAbort?.abort(); this.callAbort = undefined;
    this.microphone?.close(); this.microphone = undefined;
    clearInterval(this.heartbeat); clearTimeout(this.deadline); clearTimeout(this.idle);
    if (session) void this.options.port.end(session).catch(() => undefined);
    this.options.onLevel(0);
    this.update({ phase: "ended" });
  }
}
