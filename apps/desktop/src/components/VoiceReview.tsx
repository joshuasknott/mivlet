import type { ReturnTypeUseVoice } from "../lib/voice-types";

export function VoiceReview({
  voice,
  onReturnToText
}: {
  voice: ReturnTypeUseVoice;
  onReturnToText?: () => void;
}) {
  const { state } = voice;
  if (state.status === "idle" || state.status === "disabled") return null;

  const message =
    state.status === "active"
      ? "Listening only after your explicit action."
      : state.status === "processing"
        ? "Processing speech…"
        : state.status === "successful"
          ? "Review the transcript, then place it in the composer."
          : state.status === "permission-denied"
            ? state.message
            : state.status === "unavailable"
              ? `${state.reason} You can keep typing.`
              : state.status === "failed"
                ? state.message
                : "Dictation cancelled. You can keep typing.";
  const isFailure =
    state.status === "permission-denied" ||
    state.status === "unavailable" ||
    state.status === "failed";

  const returnToText = () => {
    voice.reset();
    onReturnToText?.();
  };

  return (
    <section className="voice-review" aria-label="Voice input review">
      <p
        className="voice-review__status"
        role={isFailure ? "alert" : "status"}
        aria-live={isFailure ? "assertive" : "polite"}
      >
        {message}
      </p>
      <small>
        {voice.processingDisclosure} Fable does not store audio or temporary dictation transcripts.
      </small>
      {state.status === "successful" ? (
        <>
          <textarea
            value={state.transcript}
            onChange={(event) => voice.updateTranscript(event.target.value)}
            aria-label="Voice transcript"
            rows={3}
          />
          <div>
            <button type="button" onClick={returnToText}>Discard</button>
            <button type="button" onClick={voice.accept}>Use in composer</button>
          </div>
        </>
      ) : null}
      {state.status === "active" ? (
        <div>
          <button type="button" onClick={() => void voice.cancel()}>Cancel recording</button>
          <button type="button" onClick={() => void voice.stop()}>Stop and review</button>
        </div>
      ) : null}
      {state.status === "cancelled" || isFailure ? (
        <button type="button" onClick={returnToText}>
          Return to text input
        </button>
      ) : null}
    </section>
  );
}
