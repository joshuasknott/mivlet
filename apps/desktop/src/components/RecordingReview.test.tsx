import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingReview } from "./RecordingReview";

describe("RecordingReview", () => {
  it("shows the exact metered destination and requires an explicit action", () => {
    const confirm = vi.fn(); const cancel = vi.fn();
    render(<RecordingReview review={{
      recordingId: "recording-1", durationMs: 61_000, sizeBytes: 1_572_864,
      mediaType: "audio/webm", providerLabel: "OpenAI transcription",
      model: "gpt-4o-mini-transcribe", maxDurationMs: 120_000
    }} onConfirm={confirm} onCancel={cancel} />);
    expect(screen.getByText("1m 1s · 1.5 MB")).toBeInTheDocument();
    expect(screen.getByText(/One-time metered upload to OpenAI transcription using gpt-4o-mini-transcribe/)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upload & transcribe" }));
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
