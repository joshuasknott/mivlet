import type { SpeechRecordingReview } from "@fable/connectors/voice";

function durationLabel(durationMs: number) {
  const seconds = Math.max(1, Math.ceil(durationMs / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function sizeLabel(sizeBytes: number) {
  return sizeBytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`
    : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecordingReview({
  review,
  onConfirm,
  onCancel
}: {
  review: SpeechRecordingReview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="recording-review" aria-labelledby="recording-review-title">
      <div className="recording-review__copy">
        <strong id="recording-review-title">Upload this recording?</strong>
        <span>{durationLabel(review.durationMs)} · {sizeLabel(review.sizeBytes)}</span>
        <small>
          One-time metered upload to {review.providerLabel} using {review.model}. Fable does not save the audio.
        </small>
      </div>
      <div className="recording-review__actions">
        <button type="button" className="composer-chip" onClick={onCancel}>Cancel</button>
        <button type="button" className="composer-chip recording-review__confirm" onClick={onConfirm}>
          Upload &amp; transcribe
        </button>
      </div>
    </section>
  );
}
