/** Energy-based turn detection with pre-roll, hysteresis and bounded utterances. */
export class VoiceTurnDetector {
  private preRoll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private active = false;
  private voicedMs = 0;
  private silenceMs = 0;
  private totalMs = 0;
  private noiseFloor = 0.002;

  constructor(private readonly sampleRate: number, private readonly onStart: () => void, private readonly onTurn: (wav: Uint8Array) => void, private readonly onSilence: () => void = () => {}) {}

  reset() {
    this.preRoll = [];
    this.frames = [];
    this.active = false;
    this.voicedMs = this.silenceMs = this.totalMs = 0;
  }

  push(frame: Float32Array): number {
    const ms = frame.length / this.sampleRate * 1000;
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
    const threshold = Math.max(0.012, Math.min(0.06, this.noiseFloor * 3));
    const voiced = rms > (this.active ? threshold * 0.65 : threshold);
    if (!this.active) {
      if (!voiced) this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
      this.preRoll.push(frame);
      while (this.preRoll.length > Math.ceil(350 / ms)) this.preRoll.shift();
      this.voicedMs = voiced ? this.voicedMs + ms : 0;
      if (this.voicedMs >= 140) {
        this.active = true;
        this.frames = this.preRoll;
        this.preRoll = [];
        this.totalMs = this.frames.reduce((sum, item) => sum + item.length / this.sampleRate * 1000, 0);
        this.onStart();
      }
    } else {
      this.frames.push(frame);
      this.totalMs += ms;
      this.silenceMs = voiced ? 0 : this.silenceMs + ms;
      if (voiced) this.voicedMs += ms;
      if (this.silenceMs >= 900 || this.totalMs >= 60_000) this.finish();
    }
    return Math.min(1, rms * 10);
  }

  finish() {
    if (!this.active) return;
    const frames = this.frames;
    const useful = this.voicedMs >= 160;
    this.reset();
    if (useful) this.onTurn(encodeVoiceWav(frames, this.sampleRate));
    else this.onSilence();
  }
}

/** Downsample to mono 24 kHz PCM, the only recording format the call accepts. */
export function encodeVoiceWav(frames: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const input = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { input.set(frame, offset); offset += frame.length; }
  const rate = 24_000;
  const count = Math.min(rate * 60, Math.floor(input.length * rate / sampleRate));
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const write = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * sampleRate / rate);
    const end = Math.max(start + 1, Math.floor((i + 1) * sampleRate / rate));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
