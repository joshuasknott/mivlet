import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { WorkspaceHistory } from "./WorkspaceHistory";
import { useScopedComposer } from "../hooks/useScopedComposer";

const draft = vi.hoisted(() => ({ setReplyWork: vi.fn(), setText: vi.fn() }));
vi.mock("../hooks/useScopedComposer", () => ({
  useScopedComposer: vi.fn(() => draft),
}));
vi.mock("../components/work/WorkDetails", () => ({
  WorkDetails: ({ item }: { item: { prompt: string } }) => (
    <p>Details: {item.prompt}</p>
  ),
}));

const props = () =>
  ({
    room: { id: "room", workspaceId: "workspace", facilitatorId: "agent" },
    runtime: {
      accountWorkspaceStatus: {
        activeContextOwner: { internalUserId: "user" },
      },
      agents: [{ id: "agent", name: "Mira" }],
    },
    service: {
      workspaceId: "workspace",
      stop: vi.fn().mockResolvedValue(undefined),
      report: vi.fn(),
    },
    state: {
      data: {
        conversations: [],
        work: [
          {
            id: "root",
            rootId: "root",
            workspaceId: "workspace",
            updatedAt: "2026-10-15",
            conversationId: "room",
            agentId: "agent",
            agentName: "Mira",
            prompt: "Main request",
            userRequest: "Main request",
            status: "completed",
          },
          {
            id: "child",
            rootId: "root",
            workspaceId: "workspace",
            updatedAt: "2026-10-15",
            parentId: "root",
            conversationId: "delegated",
            agentId: "agent",
            agentName: "Mira",
            prompt: "Delegated task",
            status: "completed",
          },
          {
            id: "other",
            rootId: "other",
            workspaceId: "workspace",
            updatedAt: "2026-10-15",
            conversationId: "elsewhere",
            prompt: "Unrelated request",
            status: "completed",
          },
        ],
      },
    },
    selectedWorkId: null,
    onOpenConversation: vi.fn(),
  }) as unknown as ComponentProps<typeof WorkspaceHistory>;

it("keeps delegated assignments in their conversation's history and opens details in the panel", () => {
  render(<WorkspaceHistory {...props()} />);
  expect(screen.getByText("Delegated task")).toBeVisible();
  expect(screen.queryByText("Unrelated request")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Details" })[1]);
  expect(
    screen.getByRole("region", { name: "Activity details" }),
  ).toBeVisible();
  expect(screen.getByText("Details: Delegated task")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to activity" }));
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

it("uses the originating conversation's draft when following up from a wider browsing scope", () => {
  const input = props();
  const sibling = { ...input.room!, id: "sibling", title: "Sibling" };
  const root = {
    ...input.state.data.work[0],
    id: "sibling-root",
    rootId: "sibling-root",
    conversationId: "sibling",
  };
  input.state.data.conversations = [input.room!, sibling];
  render(<WorkspaceHistory {...input} workItems={[root]} />);
  fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
  expect(useScopedComposer).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "sibling", workspaceId: "workspace" }),
  );
  expect(draft.setReplyWork).toHaveBeenLastCalledWith("sibling-root");
  expect(input.onOpenConversation).toHaveBeenLastCalledWith("sibling");
});

it("bounds work history while searching requests outside the first page", () => {
  const input = props();
  const work = Array.from({ length: 100 }, (_, index) => ({
    ...input.state.data.work[0],
    id: "root-" + index,
    rootId: "root-" + index,
    prompt: "Request " + index,
    userRequest: "Request " + index,
  }));
  render(<WorkspaceHistory {...input} workItems={work} />);
  expect(screen.queryByText("Request 99")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Request 99" },
  });
  expect(screen.getByRole("region", { name: "Request: Request 99" })).toBeVisible();
});
