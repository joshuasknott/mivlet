import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { WorkspaceHistory } from "./WorkspaceHistory";

const draft = vi.hoisted(() => ({ setReplyWork: vi.fn(), setText: vi.fn() }));
vi.mock("../hooks/useScopedComposer", () => ({ useScopedComposer: () => draft }));
vi.mock("../components/work/WorkDetails", () => ({ WorkDetails: ({ item }: { item: { prompt: string } }) => <p>Details: {item.prompt}</p> }));

const props = () => ({
  room: { id: "room", facilitatorId: "agent" },
  runtime: { accountWorkspaceStatus: { activeContextOwner: { internalUserId: "user" } }, agents: [{ id: "agent", name: "Mira" }] },
  service: { workspaceId: "workspace", stop: vi.fn().mockResolvedValue(undefined), report: vi.fn() },
  state: { data: { work: [
    { id: "root", rootId: "root", conversationId: "room", agentId: "agent", agentName: "Mira", prompt: "Main request", userRequest: "Main request", status: "completed" },
    { id: "child", rootId: "root", parentId: "root", conversationId: "delegated", agentId: "agent", agentName: "Mira", prompt: "Delegated task", status: "completed" },
    { id: "other", rootId: "other", conversationId: "elsewhere", prompt: "Unrelated request", status: "completed" },
  ] } },
  selectedWorkId: null,
  onOpenConversation: vi.fn(),
} as unknown as ComponentProps<typeof WorkspaceHistory>);

it("keeps delegated assignments in their conversation's history and opens details in the panel", () => {
  render(<WorkspaceHistory {...props()} />);
  expect(screen.getByText("Delegated task")).toBeVisible();
  expect(screen.queryByText("Unrelated request")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Details" })[1]);
  expect(screen.getByRole("region", { name: "History details" })).toBeVisible();
  expect(screen.getByText("Details: Delegated task")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
  expect(screen.getByText("Delegated task")).toBeVisible();
});

it("prepares an assignment follow-up in the owning conversation", () => {
  const input = props();
  render(<WorkspaceHistory {...input} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Follow up" })[1]);
  expect(draft.setReplyWork).toHaveBeenCalledWith("child");
  expect(draft.setText).toHaveBeenCalledWith("@[Mira](agent:agent), ");
  expect(input.onOpenConversation).toHaveBeenCalledWith("room");
});
