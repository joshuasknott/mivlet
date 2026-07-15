import { fireEvent, render, screen, within } from "@testing-library/react";
import type { RunContextReceipt } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { CitedApprovalCard, MissionHumanInputCard, MissionPlanSummary, MissionRunReceipt, NewCitedMissionAction, ParallelMissionPlanSummary, ProviderRouteSummary, RunContextSummary, citationsForRun, runContextAudienceLabel } from "./workspace-cards";

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
    expect(summary).toHaveTextContent("Cost ceilingUnknown for this model");
    expect(summary).not.toHaveTextContent("provider-route-secret");
    expect(summary).not.toHaveTextContent("workspace-private");
    expect(summary).not.toHaveTextContent("boundary-private");
  });

  it("shows persisted per-run usage and source-attributed token and cost ceilings", () => {
    render(<ProviderRouteSummary
      route={{
        workspaceId: "workspace-private" as never,
        selection: {
          providerRouteId: "provider-route-secret" as never,
          selectedAt: "2026-07-13T12:00:00Z" as never,
          reason: "Selected OpenAI GPT-5 for model.generate.",
          boundaryPolicyRef: "boundary-private",
          cost: {
            reference: "official-price|reviewed=2026-07-13",
            currencyCode: "USD",
            inputRateMinorUnits: 125,
            outputRateMinorUnits: 1000,
            unitTokens: 1_000_000,
            sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5",
            reviewedAt: "2026-07-13T00:00:00Z" as never,
            estimatedInputTokens: 400,
            estimatedOutputTokens: 2_048,
            estimatedCostMinorUnits: 3
          }
        }
      }}
      usage={{ inputTokens: 120, outputTokens: 80, costUsd: 0.00095 }}
    />);
    const summary = screen.getByLabelText("Route receipt");
    expect(summary).toHaveTextContent("400 input estimate · 2048 output max");
    expect(summary).toHaveTextContent("USD 0.03 estimated maximum");
    expect(summary).toHaveTextContent("120 input · 80 output");
    expect(summary).toHaveTextContent("$0.000950");
    expect(summary).not.toHaveTextContent("provider-route-secret");
    expect(summary).not.toHaveTextContent("workspace-private");
    expect(summary).not.toHaveTextContent("boundary-private");
    expect(summary).not.toHaveTextContent("official-price");
  });

  it("shows the review date retained by source-attributed mission pricing", () => {
    render(<MissionRunReceipt receipt={{
      acceptanceStatus: "accepted", acceptanceSummary: "Required policy acceptance is complete.",
      provider: "openai", model: "gpt-5", routeReason: "Selected exact route.",
      inputTokens: 120, outputTokens: 80, toolCalls: 1, durationMs: 1250, attemptNumber: 2, sourceCount: 1,
      trust: "provider-generated-with-external-evidence", maxInputTokens: 2_000,
      maxOutputTokens: 1_000, maxToolCalls: 1, maxDurationMs: 60_000, maxAttempts: 2,
      costAmount: "0.00095", costCurrency: "USD",
      pricingReference: "https://developers.openai.com/api/docs/models/gpt-5|reviewed=2026-07-13|standard-input-usd-per-1m=1.25|standard-output-usd-per-1m=10"
    }} />);
    expect(screen.getByText("Policy acceptance met")).toBeInTheDocument();
    expect(screen.getByText("Provider time 1.3s / 60s · attempt 2 / 2")).toBeInTheDocument();
    expect(screen.getByText("Standard API list price · reviewed 13 Jul 2026")).toBeInTheDocument();
  });

  it("shows a compact plan without exposing internal mission authority", () => {
    render(<MissionPlanSummary plan={{
      title: "Connected work brief", summary: "What changed?", executionLabel: "One focused research step",
      step: { title: "Research and write", objective: "Search, then write.", capability: "Search connected work sources", output: "A trustworthy Markdown brief." },
      acceptance: ["Use only attested citations."],
      budget: { maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2 }
    }} />);
    const plan = screen.getByLabelText("Mission plan");
    expect(plan).toHaveTextContent("One focused research step");
    expect(plan).toHaveTextContent("Search connected work sources");
    expect(plan).toHaveTextContent("Accepted when: Use only attested citations.");
    expect(plan).toHaveTextContent("2 attempts including restart recovery");
    expect(plan).not.toHaveTextContent("mission-");
    expect(plan).not.toHaveTextContent("knowledge.content.search");
  });

  it("shows the independent worker plan and deterministic join limits", () => {
    render(<ParallelMissionPlanSummary plan={{
      title: "Compare two approaches",
      summary: "Generate two approaches for the onboarding flow.",
      executionLabel: "Two workers · deterministic join",
      steps: [
        { title: "Practical approach", objective: "Prefer low complexity.", output: "Required Markdown approach" },
        { title: "Alternative approach", objective: "Explore higher upside.", output: "Required Markdown approach" },
        { title: "Compare", objective: "Join both exact outputs.", output: "Draft comparison artifact" }
      ],
      acceptance: ["Both independently generated outputs must reach the durable all-workers join."],
      budget: { maxWorkers: 2, maxDurationMs: 90_000, maxOutputTokens: 2_048, maxAttempts: 1 }
    }} />);
    const plan = screen.getByLabelText("Parallel mission plan");
    expect(plan).toHaveTextContent("Two workers · deterministic join");
    expect(plan).toHaveTextContent("Practical approach");
    expect(plan).toHaveTextContent("Alternative approach");
    expect(plan).toHaveTextContent("Join both exact outputs.");
    expect(plan).toHaveTextContent("2 workers at once");
    expect(plan).not.toHaveTextContent("mission-");
  });

  it("makes the fresh-authority boundary explicit before starting another mission", () => {
    const onStart = vi.fn();
    const { rerender } = render(<NewCitedMissionAction disabled={false} starting={false} onStart={onStart} />);
    const action = screen.getByLabelText("New mission option");
    expect(action).toHaveTextContent("Starts fresh with the current scope, provider route, access, and approvals.");
    fireEvent.click(screen.getByRole("button", { name: "Run again as a new mission" }));
    expect(onStart).toHaveBeenCalledOnce();

    rerender(<NewCitedMissionAction disabled starting onStart={onStart} />);
    expect(screen.getByRole("button", { name: "Starting new mission..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Starting new mission..." })).toHaveAttribute("aria-busy", "true");
  });

  it("keeps artifact creation explicit after policy checks pass", () => {
    const onApprove = vi.fn();
    const onKeepDraft = vi.fn();
    render(<CitedApprovalCard
      requestedAt="2026-07-13T10:00:00Z"
      busy={false}
      onApprove={onApprove}
      onKeepDraft={onKeepDraft}
    />);
    const card = screen.getByLabelText("Cited brief approval");
    expect(card).toHaveTextContent("No artifact has been created yet.");
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep as draft" }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onKeepDraft).toHaveBeenCalledOnce();
  });

  it("collects bounded typed mission input in one accessible form", () => {
    const onSubmit = vi.fn();
    render(<MissionHumanInputCard
      prompt="Confirm the launch details before the mission continues."
      requestedAt="2026-07-13T10:00:00Z"
      busy={false}
      fields={[
        { key: "owner", label: "Launch owner", help: "Use the accountable person's name.", kind: "text", required: true, sensitive: false },
        { key: "seats", label: "Seat count", kind: "number", required: true, sensitive: false },
        { key: "region", label: "Region", kind: "choice", required: true, sensitive: false, choices: ["UK", "EU"] },
        { key: "confirmed", label: "Details confirmed", kind: "boolean", required: true, sensitive: false },
        { key: "launch_at", label: "Launch time", kind: "date-time", required: true, sensitive: false }
      ]}
      onSubmit={onSubmit}
    />);

    expect(screen.getByRole("form", { name: "Mission needs input" })).toHaveTextContent(
      "Confirm the launch details before the mission continues."
    );
    fireEvent.change(screen.getByLabelText(/Launch owner/), { target: { value: "Alex" } });
    fireEvent.change(screen.getByLabelText(/Seat count/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/Region/), { target: { value: "UK" } });
    fireEvent.click(screen.getByLabelText("Details confirmed"));
    fireEvent.change(screen.getByLabelText(/Launch time/), { target: { value: "2026-07-20T09:30" } });
    fireEvent.submit(screen.getByRole("form", { name: "Mission needs input" }));

    expect(onSubmit).toHaveBeenCalledWith([
      { fieldKey: "owner", value: "Alex" },
      { fieldKey: "seats", value: 25 },
      { fieldKey: "region", value: "UK" },
      { fieldKey: "confirmed", value: true },
      { fieldKey: "launch_at", value: new Date("2026-07-20T09:30").toISOString() }
    ]);
  });

  it("locks the human-input form while submitting and surfaces a safe error", () => {
    render(<MissionHumanInputCard
      prompt="Choose a region."
      requestedAt="2026-07-13T10:00:00Z"
      busy
      error="Fable could not continue this mission."
      fields={[{ key: "region", label: "Region", kind: "choice", required: true, sensitive: false, choices: ["UK", "EU"] }]}
      onSubmit={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "Continuing..." })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Region/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Fable could not continue this mission.");
  });

  it("submits only the selected immutable artifact-version identifiers", () => {
    const onSubmit = vi.fn();
    render(<MissionHumanInputCard
      prompt="Choose the artifact to plan a revision for."
      requestedAt="2026-07-13T10:00:00Z"
      busy={false}
      fields={[{ key: "sourceArtifact", label: "Source artifact", kind: "artifact", required: true, sensitive: false }]}
      artifactOptions={[{
        artifactId: "artifact-1",
        artifactVersionId: "artifact-version-2",
        label: "Launch brief",
        versionLabel: "Version 2"
      }]}
      onSubmit={onSubmit}
    />);
    fireEvent.change(screen.getByRole("combobox", { name: /Source artifact/ }), { target: { value: "0" } });
    fireEvent.submit(screen.getByRole("form", { name: "Mission needs input" }));
    expect(onSubmit).toHaveBeenCalledWith([{
      fieldKey: "sourceArtifact",
      value: { artifactId: "artifact-1", artifactVersionId: "artifact-version-2" }
    }]);
  });
});
