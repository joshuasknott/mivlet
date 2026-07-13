import { render, screen, within } from "@testing-library/react";
import type { RunContextReceipt } from "@fable/protocol";
import { describe, expect, it } from "vitest";
import { MissionRunReceipt, ProviderRouteSummary, RunContextSummary, citationsForRun, runContextAudienceLabel } from "./workspace-cards";

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
    expect(summary).toHaveTextContent("Audience not recorded");
    expect(summary).not.toHaveTextContent("0.9");
  });

  it("labels private and shared v2 audiences without exposing member ids", () => {
    const privateReceipt: RunContextReceipt = {
      ...receipt,
      version: 2,
      audience: {
        authority: "local",
        visibility: "member-private",
        actingMemberId: "member-private" as never
      }
    };
    const sharedReceipt: RunContextReceipt = {
      ...receipt,
      version: 2,
      audience: {
        authority: "convex",
        visibility: "workspace-shared",
        actingMemberId: "member-shared" as never
      }
    };
    expect(runContextAudienceLabel(privateReceipt)).toBe("Only you");
    expect(runContextAudienceLabel(sharedReceipt)).toBe("Workspace");

    render(<RunContextSummary receipt={privateReceipt} />);
    const summary = screen.getByLabelText("Context used");
    expect(summary).toHaveTextContent("AudienceOnly you");
    expect(summary).not.toHaveTextContent("member-private");
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

  it("shows the durable route reason without exposing opaque authority ids", () => {
    render(<ProviderRouteSummary route={{
      workspaceId: "workspace-private" as never,
      selection: {
        providerRouteId: "provider-route-secret" as never,
        selectedAt: "2026-07-12T12:00:00Z" as never,
        reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.",
        boundaryPolicyRef: "boundary-private"
      }
    }} />);
    const summary = screen.getByLabelText("Route receipt");
    expect(summary).toHaveTextContent("Checked before connecting");
    expect(summary).toHaveTextContent("Selected OpenAI GPT-5");
    expect(summary).toHaveTextContent("This workspace");
    expect(summary).not.toHaveTextContent("provider-route-secret");
    expect(summary).not.toHaveTextContent("workspace-private");
    expect(summary).not.toHaveTextContent("boundary-private");
  });

  it("shows the review date retained by source-attributed mission pricing", () => {
    render(<MissionRunReceipt receipt={{
      provider: "openai", model: "gpt-5", routeReason: "Selected exact route.",
      inputTokens: 120, outputTokens: 80, toolCalls: 1, sourceCount: 1,
      trust: "provider-generated-with-external-evidence", maxInputTokens: 2_000,
      maxOutputTokens: 1_000, maxToolCalls: 1, maxDurationMs: 60_000, maxAttempts: 1,
      costAmount: "0.00095", costCurrency: "USD",
      pricingReference: "https://developers.openai.com/api/docs/models/gpt-5|reviewed=2026-07-13|standard-input-usd-per-1m=1.25|standard-output-usd-per-1m=10"
    }} />);
    expect(screen.getByText("Standard API list price · reviewed 13 Jul 2026")).toBeInTheDocument();
  });
});
