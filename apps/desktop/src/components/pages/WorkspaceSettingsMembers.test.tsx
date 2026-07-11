import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceMemberList } from "@fable/protocol";
import { StrictMode } from "react";
import { WorkspaceSettingsView } from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  loadInvitations: vi.fn(),
  acceptInvitation: vi.fn(),
  loadMembers: vi.fn()
}));

vi.mock("../../runtime", () => ({
  loadRuntimePendingInvitations: mocks.loadInvitations,
  acceptRuntimePendingInvitation: mocks.acceptInvitation,
  loadRuntimeWorkspaceMembers: mocks.loadMembers
}));

afterEach(cleanup);

function roster(
  workspaceId = "workspace-a",
  members: AccountWorkspaceMemberList["members"] = [
    {
      memberId: "member-secret-1",
      role: "owner",
      status: "active",
      revision: 2,
      displayName: "Josh",
      emailHint: "j***@example.com",
      isCurrentUser: true
    },
    {
      memberId: "member-secret-2",
      role: "editor",
      status: "suspended",
      isCurrentUser: false,
      revision: 4
    }
  ]
): AccountWorkspaceMemberList {
  return { workspaceId, actorRole: "owner", members };
}

function view(props: Partial<React.ComponentProps<typeof WorkspaceSettingsView>> = {}) {
  return (
    <WorkspaceSettingsView
      workspaceName="Atlas"
      fableWorkspaceId="workspace-a"
      accountContextKey="account-a"
      onStatus={() => {}}
      onInvitationAccepted={() => {}}
      {...props}
    />
  );
}

describe("workspace member roster", () => {
  beforeEach(() => {
    mocks.loadInvitations.mockReset();
    mocks.acceptInvitation.mockReset();
    mocks.loadMembers.mockReset();
    mocks.loadInvitations.mockResolvedValue({ invitations: [] });
  });

  it("shows a calm human-readable roster without rendering member ids", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    const rendered = render(view());

    expect(await screen.findByText("Josh · You")).toBeInTheDocument();
    expect(screen.getByText("j***@example.com · Owner · Active")).toBeInTheDocument();
    expect(screen.getByText("Workspace member")).toBeInTheDocument();
    expect(screen.getByText("Can edit · Paused")).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent("member-secret-1");
    expect(rendered.container).not.toHaveTextContent("member-secret-2");
    expect(screen.queryByRole("button", { name: /remove|pause|role|save/i })).not.toBeInTheDocument();
  });

  it("is honest when the native account service is unavailable", async () => {
    mocks.loadMembers.mockResolvedValue(null);
    render(view());

    expect(await screen.findByText(/available in the Fable desktop app when your account is online/i)).toBeInTheDocument();
    expect(screen.queryByText("Josh")).not.toBeInTheDocument();
  });

  it("keeps loading, error, retry, and empty states truthful", async () => {
    let rejectFirst: (reason: Error) => void = () => {};
    mocks.loadMembers
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(roster("workspace-a", []));
    render(view());

    expect(screen.getByText("Loading people…")).toBeInTheDocument();
    await waitFor(() => expect(mocks.loadMembers).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectFirst(new Error("offline"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t be loaded/i);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No people are listed yet.")).toBeInTheDocument();
  });

  it("clears immediately and rejects stale completion on account and workspace switch", async () => {
    let finishA: (value: AccountWorkspaceMemberList) => void = () => {};
    let finishB: (value: AccountWorkspaceMemberList) => void = () => {};
    mocks.loadMembers
      .mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishB = resolve; }));

    const rendered = render(view());
    rendered.rerender(view({
      workspaceName: "Beacon",
      fableWorkspaceId: "workspace-b",
      accountContextKey: "account-b"
    }));

    expect(screen.queryByText("Josh · You")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.loadMembers).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishA(roster("workspace-a"));
    });
    expect(screen.queryByText("Josh · You")).not.toBeInTheDocument();

    await act(async () => {
      finishB(roster("workspace-b", [{
        memberId: "member-secret-b",
        role: "viewer",
        status: "active",
        revision: 1,
        displayName: "Beacon member",
        isCurrentUser: false
      }]));
    });
    expect(await screen.findByText("Beacon member")).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent("member-secret-b");
  });

  it("does not duplicate a same-context load through Strict Mode or an ordinary rerender", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    const rendered = render(<StrictMode>{view()}</StrictMode>);
    await screen.findByText("Josh · You");
    rendered.rerender(<StrictMode>{view({ workspaceName: "Atlas renamed" })}</StrictMode>);
    await waitFor(() => expect(mocks.loadMembers).toHaveBeenCalledTimes(1));
  });
});
