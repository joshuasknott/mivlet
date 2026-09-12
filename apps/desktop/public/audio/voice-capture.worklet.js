// Transfer microphone frames in ~40 ms batches. No recording, network or storage
// happens on the audio thread. The output is silent to prevent microphone echo.
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const sample of samples) {
        this.buffer[this.offset++] = sample;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mivlet-voice-capture", VoiceCaptureProcessor);
