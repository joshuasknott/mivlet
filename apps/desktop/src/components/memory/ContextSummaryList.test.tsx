import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContextSummaryRecord } from "@fable/protocol";
import { ContextSummaryList } from "./ContextSummaryList";

function summary(overrides: Partial<ContextSummaryRecord> = {}): ContextSummaryRecord {
  return {
    id: "summary-1",
    threadId: "thread-1",
    scope: { level: "thread", threadId: "thread-1" },
    fromSequence: 1,
    throughSequence: 8,
    revision: 2,
    text: "Decisions:\n- Keep the blue design.",
    sourceMessageIds: ["message-1"],
    sourceRevisionIds: ["revision-1"],
    derivedMemoryIds: [],
    derivedMemoryRevisions: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides
  };
}

describe("ContextSummaryList", () => {
  it("shows live summaries with coverage, revision and provenance", () => {
    render(<ContextSummaryList summaries={[summary()]} />);
    expect(screen.getByRole("heading", { name: "Derived conversation summaries" })).toBeVisible();
    expect(screen.getByText(/Keep the blue design/)).toBeVisible();
    expect(screen.getByText(/messages 1–8 · revision 2/)).toBeVisible();
  });

  it("never renders stale or invalidated summaries", () => {
    render(
      <ContextSummaryList
        summaries={[
          summary({ id: "live", text: "Live derived context." }),
          summary({ id: "stale", staleAt: "2026-09-03T00:00:00.000Z", text: "Removed fact." })
        ]}
      />
    );
    expect(screen.getByText("Live derived context.")).toBeVisible();
    expect(screen.queryByText("Removed fact.")).toBeNull();
  });

  it("routes a derived-memory forget action through the caller's callback", () => {
    const onForgetMemory = vi.fn();
    render(
      <ContextSummaryList
        summaries={[summary({ derivedMemoryIds: ["memory-1"] })]}
        onForgetMemory={onForgetMemory}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Forget memory memory-1" }));
    expect(onForgetMemory).toHaveBeenCalledWith("memory-1");
  });

  it("shows an empty label when no summaries exist", () => {
    render(<ContextSummaryList summaries={[]} emptyLabel="Nothing compacted yet." />);
    expect(screen.getByText("Nothing compacted yet.")).toBeVisible();
  });
});
