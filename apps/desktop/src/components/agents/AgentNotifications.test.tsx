import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, FableAgentProfile } from "@fable/protocol";
import { AgentNotifications } from "./AgentNotifications";

const agent = { id: "ava", name: "Ava" } as FableAgentProfile;
const work = (status: CollaborationWorkItem["status"]): CollaborationWorkItem => ({ id: "work", agentId: "ava", conversationId: "chat", status } as CollaborationWorkItem);
describe("agent notifications", () => {
  it("does not replay historical work, announces new transitions once and opens the exact conversation", () => {
    const open = vi.fn();
    const view = render(<AgentNotifications agents={[agent]} work={[work("completed")]} onOpen={open} />);
    expect(screen.queryByText("Ava finished.")).toBeNull();
    view.rerender(<AgentNotifications agents={[agent]} work={[work("running")]} onOpen={open} />);
    view.rerender(<AgentNotifications agents={[agent]} work={[work("completed")]} onOpen={open} />);
    view.rerender(<AgentNotifications agents={[agent]} work={[work("completed")]} onOpen={open} />);
    expect(screen.queryByText("Ava finished.")).toBeNull();
    view.rerender(<AgentNotifications agents={[agent]} work={[work("failed")]} onOpen={open} />);
    expect(screen.getAllByText("Ava could not finish.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(open).toHaveBeenCalledWith("chat");
    expect(screen.queryByText("Ava finished.")).toBeNull();
  });
  it("honours mute without replaying missed notices when enabled again", () => {
    const muted = { ...agent, notificationsEnabled: false };
    const view = render(<AgentNotifications agents={[muted]} work={[work("running")]} onOpen={vi.fn()} />);
    view.rerender(<AgentNotifications agents={[muted]} work={[work("awaiting-approval")]} onOpen={vi.fn()} />);
    view.rerender(<AgentNotifications agents={[agent]} work={[work("awaiting-approval")]} onOpen={vi.fn()} />);
    expect(screen.queryByText("Ava needs your approval.")).toBeNull();
    view.rerender(<AgentNotifications agents={[agent]} work={[work("failed")]} onOpen={vi.fn()} />);
    expect(screen.getByText("Ava could not finish.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Ava could not finish." }));
    expect(screen.queryByText("Ava could not finish.")).toBeNull();
  });
});
