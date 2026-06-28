import type { ReturnTypeUseVoice } from "../lib/voice-types";

export function VoiceReview({ voice }: { voice: ReturnTypeUseVoice }) {
  if (voice.state.status === "idle") return null;
  return (
    <section className="voice-review" aria-label="Voice input review">
      <p className="voice-review__status">
        {voice.state.status === "recording"
          ? "Listening only while you hold this session open."
          : voice.state.status === "processing"
            ? "Processing speech…"
            : voice.state.status === "error"
              ? voice.state.error
              : "Review the transcript before sending."}
      </p>
      <small>{voice.processingDisclosure} Raw audio is not retained by Fable.</small>
      {voice.state.status === "review" ? (
        <>
          <textarea
            value={voice.state.transcript}
            onChange={(event) => voice.updateTranscript(event.target.value)}
            aria-label="Voice transcript"
            rows={3}
          />
          <div>
            <button type="button" onClick={voice.cancel}>Discard</button>
            <button type="button" onClick={voice.submit}>Submit transcript</button>
          </div>
        </>
      ) : null}
      {voice.state.status === "recording" ? (
        <div>
          <button type="button" onClick={voice.cancel}>Cancel recording</button>
          <button type="button" onClick={voice.stop}>Stop and review</button>
        </div>
      ) : null}
      {voice.state.status === "error" ? (
        <button type="button" onClick={voice.cancel}>Dismiss</button>
      ) : null}
    </section>
  );
}
