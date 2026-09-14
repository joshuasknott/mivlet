import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem } from "@fable/protocol";
import { WorkDetails } from "./WorkDetails";

const item = (patch: Partial<CollaborationWorkItem> = {}): CollaborationWorkItem => ({
  id: "work", rootId: "work", workspaceId: "workspace", conversationId: "room",
  agentId: "agent", agentName: "Researcher", prompt: "Read the brief and summarize", userRequest: "Summarize the brief for me",
  status: "awaiting-user", reason: "Steering saved. Review prior outcomes before continuing; no external effect was replayed.",
  permissionMode: "trusted-scope",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: true, generation: 2,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 1, tokenUsage: 120,
  maxTurns: 12, maxTokens: 64000, runIds: ["run-one"], currentRunId: undefined, modelOptionId: "codex::fixture",
  outputs: [{ runId: "run-one", conversationId: "room", text: "A saved report.", evidence: "agent-report", createdAt: "2026-09-12T10:10:00Z" }],
  capturedContext: {
    mode: "snapshot",
    source: { workspaceId: "workspace", kind: "conversation", id: "room" },
    sourceRevision: "42",
    capturedAt: "2026-09-12T10:00:00Z",
    text: "{\"history\":[]}",
    version: 1,
  },
  steering: [{ id: "s1", text: "Narrow to the intro", createdAt: "2026-09-12T10:05:00Z" }],
  attachments: [
    { id: "brief", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt" },
    { id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 2048, availability: "image-input" },
  ],
  createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:05:00Z",
  ...patch,
});

describe("Work details", () => {
  it("keeps the original request visible and explains uncertain outcomes", () => {
    render(<WorkDetails item={item()} onOpen={vi.fn()} onStop={vi.fn()} onContinue={vi.fn()} onSteer={vi.fn()} />);
    expect(screen.getByText("Summarize the brief for me")).toBeVisible();
    expect(screen.getByText("Read the brief and summarize")).toBeVisible();
    expect(screen.getByText(/external effects are uncertain/)).toBeVisible();
    expect(screen.getByText("Narrow to the intro")).toBeVisible();
  });

  it("records deliberate steering at the current generation", () => {
    const onSteer = vi.fn();
    render(<WorkDetails item={item()} onOpen={vi.fn()} onStop={vi.fn()} onContinue={vi.fn()} onSteer={onSteer} />);
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    fireEvent.change(screen.getByPlaceholderText(/safe boundary/), { target: { value: "Add the conclusion" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply steering" }));
    expect(onSteer).toHaveBeenCalledWith("work", 2, "Add the conclusion");
  });

  it("requires explicit reconciliation before continuing started work", () => {
    const onContinue = vi.fn();
    render(<WorkDetails item={item()} onOpen={vi.fn()} onStop={vi.fn()} onContinue={onContinue} onSteer={vi.fn()} />);
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledWith("work", 2);
  });

  it("promotes a saved outcome through the explicit memory callback", () => {
    const onPromote = vi.fn();
    render(<WorkDetails item={item()} onOpen={vi.fn()} onStop={vi.fn()} onContinue={vi.fn()} onSteer={vi.fn()} onPromote={onPromote} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    expect(onPromote).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-one" }),
      expect.objectContaining({ id: "work" }),
    );
  });
});