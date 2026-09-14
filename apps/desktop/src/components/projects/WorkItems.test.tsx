import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem } from "@fable/protocol";
import type { WorkspaceExecution } from "../../lib/workspace-execution";
import { WorkItems, WorkRecovery } from "./WorkItems";
import { WorkspaceHistory } from "../conversation/WorkspaceHistory";
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

const item: CollaborationWorkItem = {
  id: "work", rootId: "work", workspaceId: "workspace", conversationId: "room",
  agentId: "agent", agentName: "Researcher", prompt: "Expanded execution context", userRequest: "Recover this request ".repeat(30),
  status: "failed", reason: "Computer status unavailable", permissionMode: "trusted-scope",
  dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, generation: 3,
  conversationGeneration: 1, contextRevision: 0, depth: 0, turnCount: 0, tokenUsage: 0,
  maxTurns: 12, maxTokens: 64000, runIds: [], modelOptionId: "codex::fixture", outputs: [],
  createdAt: "2026-09-12T10:00:00Z", updatedAt: "2026-09-12T10:00:00Z",
};
const service = (command = vi.fn().mockResolvedValue({})) => ({
  command,
  steer: async (id: string, expectedGeneration: number, text: string) =>
    command({ action: "steer-work", id, expectedGeneration, eventId: crypto.randomUUID(), text }),
} as unknown as WorkspaceExecution);

describe("failed work recovery", () => {
  it("preserves the complete user request and makes it expandable", () => {
    render(<WorkItems work={[item]} service={service()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show full request" }));
    expect(screen.getByText(item.userRequest.trim())).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy request" })).toBeVisible();
    expect(screen.queryByText(item.prompt)).toBeNull();
  });
  it("retries an unstarted request under its exact current generation", async () => {
    const command = vi.fn().mockResolvedValue({});
    render(<WorkRecovery item={item} service={service(command)} />);
    fireEvent.click(screen.getByText("Retry request…"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry with current model" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: "continue-work", id: "work", expectedGeneration: 3, reconcile: true }));
  });
  it("requires outcome review after a provider attempt and retains failed continuation guidance", async () => {
    const command = vi.fn().mockRejectedValue(new Error("Work changed; refresh first"));
    const view = render(<WorkRecovery item={{ ...item, runIds: ["run"], turnCount: 1 }} service={service(command)} />);
    fireEvent.click(screen.getByText("Continue…"));
    fireEvent.submit(view.container.querySelector("form")!);
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(view.container.querySelector("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Work changed; refresh first");
  });
  it("includes failed requests in the attention summary", () => {
    render(<WorkspaceHistory rooms={[]} work={[item]} indicators={{}} service={service()} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Work needing attention")).toHaveTextContent("Researcherfailed");
  });
  it("records deliberate steering under the item's exact generation", async () => {
    const command = vi.fn().mockResolvedValue({});
    render(<WorkItems work={[item]} service={service(command)} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText("Steer request…"));
    fireEvent.change(screen.getByPlaceholderText("Adjust the request…"), {
      target: { value: "Focus on the brief" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply steering" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: "steer-work",
        id: "work",
        expectedGeneration: 3,
        eventId: expect.any(String),
        text: "Focus on the brief",
      }),
    );
  });
  it("labels schedule-origin work and in-memory attachment recovery", () => {
    render(<WorkItems work={[{ ...item, origin: "schedule", attachments: [{ id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 4, availability: "transient" }] }]} service={service()} onOpen={vi.fn()} />);
    expect(screen.getByText("Scheduled")).toBeVisible();
    expect(screen.getByText(/in-memory inputs need reattaching/)).toBeVisible();
  });
});
