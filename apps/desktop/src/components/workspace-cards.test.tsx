import { render, screen, within } from "@testing-library/react";
import type { RunContextReceipt } from "@fable/protocol";
import { describe, expect, it } from "vitest";
import { RunContextSummary, citationsForRun } from "./workspace-cards";

const receipt: RunContextReceipt = {
  version: 1,
  runId: "run-1",
  assembledAt: "2026-07-11T12:00:00.000Z",
  scope: { level: "project", projectId: "project-1" },
  citations: [{
    sourceId: "source-1", title: "Launch notes", snippet: "Launch in August.",
    provenance: "Local file", freshness: "Today", trust: "untrusted", pinned: false,
    score: 0.9, ranking: { relevance: 0.9, recency: 0.5, authority: 0.5, pin: 0, feedback: 0 }
  }],
  contributions: [
    { id: "memory-1", kind: "memory", reason: "memory-approved" },
    { id: "source-1", kind: "source", reason: "retrieved" },
    { id: "source-2", kind: "source", reason: "retrieved" }
  ]
};

describe("RunContextSummary", () => {
  it("shows only concise labels from the closed reason vocabulary", () => {
    render(<RunContextSummary receipt={receipt} />);
    const summary = screen.getByLabelText("Context used");
    expect(summary).toHaveTextContent("Approved memory");
    expect(summary).toHaveTextContent("Retrieved source (2)");
    expect(summary).toHaveTextContent("1 source");
    expect(summary).toHaveTextContent("Launch notes");
    expect(summary).toHaveTextContent("Local file - Today - Retrieved source");
    expect(summary).toHaveTextContent("Launch in August");
    expect(summary).not.toHaveTextContent("0.9");
  });

  it("stays hidden when no bounded context contributed", () => {
    const { container } = render(<RunContextSummary receipt={{ ...receipt, citations: [], contributions: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("describes non-citation context without claiming zero sources", () => {
    render(<RunContextSummary receipt={{ ...receipt, citations: [] }} />);
    const summary = screen.getByLabelText("Context used");
    expect(summary).toHaveTextContent("Memory and context");
    expect(summary).toHaveTextContent("Approved memory");
    expect(summary).not.toHaveTextContent("0 sources");
  });

  it("keeps two responses bound to their own immutable citation snapshots", () => {
    const receipts = {
      "run-a": { ...receipt, runId: "run-a" },
      "run-b": { ...receipt, runId: "run-b", citations: [{ ...receipt.citations[0], sourceId: "source-b", title: "Later source" }] }
    };
    expect(citationsForRun("run-a", receipts).map((citation) => citation.sourceId)).toEqual(["source-1"]);
    expect(citationsForRun("run-b", receipts).map((citation) => citation.sourceId)).toEqual(["source-b"]);
    expect(citationsForRun("missing", receipts)).toEqual([]);

    render(<>
      <RunContextSummary receipt={receipts["run-a"]} />
      <RunContextSummary receipt={receipts["run-b"]} />
    </>);
    const summaries = screen.getAllByLabelText("Context used");
    expect(within(summaries[0]).getByText("Launch notes")).toBeInTheDocument();
    expect(within(summaries[0]).queryByText("Later source")).not.toBeInTheDocument();
    expect(within(summaries[1]).getByText("Later source")).toBeInTheDocument();
    expect(within(summaries[1]).queryByText("Launch notes")).not.toBeInTheDocument();
  });
});
