import { describe, expect, it, vi } from "vitest";
import { bytesToBase64, base64ToBytes, speechText, takeSpeechChunk } from "./conversation";
import { encodeVoiceWav, VoiceTurnDetector } from "./turn-detector";

describe("speech shaping", () => {
  it("reads prose while keeping code and URL destinations in chat", () => {
    expect(speechText("See [the guide](https://example.com).\n```ts\nconst secret = 4;\n```\n**Ready.**")).toBe("See the guide. Code is available in the conversation. Ready.");
    expect(takeSpeechChunk("A complete sentence. An unfinished" )).toEqual({ text: "A complete sentence.", rest: "An unfinished" });
    expect(takeSpeechChunk("```ts\nconst value = 1.")).toBeNull();
    expect(takeSpeechChunk("No full stop", true)).toEqual({ text: "No full stop", rest: "" });
  });
  it("keeps long sentences bounded without discarding their remainder", () => {
    let rest = `${"word ".repeat(400)}done.`; const chunks: string[] = [];
    while (rest) { const chunk = takeSpeechChunk(rest, true)!; expect(chunk.text.length).toBeLessThanOrEqual(600); chunks.push(chunk.text); rest = chunk.rest; }
    expect(chunks.join(" ")).toBe(`${"word ".repeat(400)}done.`);
  });
  it("base64 conversion survives binary audio and large buffers", () => {
    const bytes = Uint8Array.from({ length: 80_000 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("microphone turn detection", () => {
  const frame = (amplitude: number) => new Float32Array(2048).fill(amplitude);
  it("ignores silence and brief clicks, retains pre-roll, and sends after a pause", () => {
    const start = vi.fn(), turn = vi.fn(); const detector = new VoiceTurnDetector(48_000, start, turn);
    for (let i = 0; i < 30; i++) detector.push(frame(0.001));
    detector.push(frame(0.1)); detector.push(frame(0));
    expect(start).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) detector.push(frame(0.1));
    expect(start).toHaveBeenCalledOnce();
    for (let i = 0; i < 23; i++) detector.push(frame(0));
    expect(turn).toHaveBeenCalledOnce();
    const wav = turn.mock.calls[0][0] as Uint8Array;
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(24000); expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
  });
  it("discarding capture on mute never delivers previously heard words", () => {
    const turn = vi.fn(); const detector = new VoiceTurnDetector(48_000, vi.fn(), turn);
    for (let i = 0; i < 10; i++) detector.push(frame(0.1));
    detector.reset(); for (let i = 0; i < 30; i++) detector.push(frame(0));
    expect(turn).not.toHaveBeenCalled();
  });
  it("caps an utterance at a native-compatible minute and clips PCM safely", () => {
    const wav = encodeVoiceWav([new Float32Array(48_000 * 61).fill(2)], 48_000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 24_000 * 60 * 2); expect(view.getInt16(44, true)).toBe(32767);
  });
});
