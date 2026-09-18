import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, MivletAgentProfile } from "@mivlet/protocol";
import { CoordinationActivity } from "./CoordinationActivity";

describe("conversation coordination activity", () => {
  it("keeps assignments inspectable and distinguishes whole-effort and individual cancellation", () => {
    const onStop = vi.fn();
    const onInspect = vi.fn();
    const onFollowUp = vi.fn();
    const root = { id: "root", rootId: "root", agentId: "lead", agentName: "Lead", status: "waiting", userRequest: "Review implementation", prompt: "Coordinate the review" } as CollaborationWorkItem;
    const child = { ...root, id: "child", parentId: "root", agentId: "reviewer", agentName: "Reviewer", status: "failed", prompt: "Review changes", reason: "Reconnect provider" } as CollaborationWorkItem;
    render(<CoordinationActivity work={[root, child]} agents={[{ id: "lead", name: "Lead" } as MivletAgentProfile, { id: "reviewer", name: "Reviewer" } as MivletAgentProfile]} onStop={onStop} onInspect={onInspect} onFollowUp={onFollowUp} />);
    fireEvent.click(screen.getByText("Activity · 1 active"));
    expect(screen.getByText("Reconnect provider")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop effort" }));
    expect(onStop).toHaveBeenLastCalledWith("root");
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    expect(onFollowUp).toHaveBeenCalledWith("lead", "Lead", "root");
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[1]);
    expect(onInspect).toHaveBeenCalledWith("child");
  });
  it("lets the user close a failed effort and release its retained resource claims", () => {
    const onStop = vi.fn();
    const work = { id: "failed", rootId: "failed", agentId: "lead", agentName: "Lead", status: "failed", userRequest: "Update report", prompt: "Update report", resourceClaims: ["connector:drive"] } as CollaborationWorkItem;
    render(<CoordinationActivity work={[work]} agents={[]} onStop={onStop} onInspect={vi.fn()} onFollowUp={vi.fn()} />);
    fireEvent.click(screen.getByText("Activity · 1 assignments"));
    fireEvent.click(screen.getByRole("button", { name: "Stop effort" }));
    expect(onStop).toHaveBeenCalledWith("failed");
  });
});
