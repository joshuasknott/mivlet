import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceMemberList, AccountWorkspaceMemberSummary } from "@fable/protocol";
import { StrictMode } from "react";
import { WorkspaceSettingsView } from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  loadInvitations: vi.fn(),
  acceptInvitation: vi.fn(),
  loadMembers: vi.fn(),
  changeMember: vi.fn(),
  createInvitation: vi.fn()
}));

vi.mock("../../runtime", () => ({
  loadRuntimePendingInvitations: mocks.loadInvitations,
  acceptRuntimePendingInvitation: mocks.acceptInvitation,
  loadRuntimeWorkspaceMembers: mocks.loadMembers,
  changeRuntimeWorkspaceMember: mocks.changeMember,
  createRuntimeWorkspaceInvitation: mocks.createInvitation
}));

afterEach(cleanup);

function member(overrides: Partial<AccountWorkspaceMemberSummary> = {}): AccountWorkspaceMemberSummary {
  return {
    memberActionRef: "action-ref-alex",
    role: "editor",
    status: "active",
    revision: 4,
    displayName: "Alex",
    isCurrentUser: false,
    management: {
      allowedRoles: ["owner", "admin", "editor", "viewer"],
      allowedActions: ["suspend", "remove"]
    },
    ...overrides
  };
}

function roster(
  workspaceId = "workspace-a",
  members: AccountWorkspaceMemberList["members"] = [
    member({
      memberActionRef: "action-ref-current",
      role: "owner",
      status: "active",
      revision: 2,
      displayName: "Josh",
      emailHint: "j***@example.com",
      isCurrentUser: true,
      management: { allowedRoles: [], allowedActions: [], blockedReason: "current-member" }
    }),
    member({
      status: "suspended",
      management: {
        allowedRoles: ["owner", "admin", "editor", "viewer"],
        allowedActions: ["reactivate", "remove"]
      }
    })
  ]
): AccountWorkspaceMemberList {
  return {
    workspaceId,
    actorRole: "owner",
    invitationManagement: {
      available: true,
      allowedRoles: ["owner", "admin", "editor", "viewer"],
      message: "Invite someone by their verified email.",
      invitationActionRef: "invitation-action-a"
    },
    members
  };
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
    mocks.changeMember.mockReset();
    mocks.createInvitation.mockReset();
    mocks.loadInvitations.mockResolvedValue({ invitations: [] });
  });

  it("shows a calm human-readable roster without rendering action references", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    const rendered = render(view());

    expect(await screen.findByText("Josh · You")).toBeInTheDocument();
    expect(screen.getByText("j***@example.com · Owner · Active")).toBeInTheDocument();
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByText("Can edit · Paused")).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent("action-ref-current");
    expect(rendered.container).not.toHaveTextContent("action-ref-alex");
    expect(screen.getByText("Your own access is read-only here.")).toBeInTheDocument();
  });

  it("creates a verified-email invitation once without claiming an email was sent", async () => {
    mocks.loadMembers
      .mockResolvedValueOnce(roster())
      .mockResolvedValueOnce(roster());
    mocks.createInvitation.mockResolvedValue({
      status: "accepted",
      role: "editor",
      expiresAt: "2026-07-18T08:00:00.000Z",
      displayHint: "p***@example.com",
      message: "created"
    });
    const rendered = render(view());

    const email = await screen.findByLabelText("Email");
    fireEvent.change(email, { target: { value: "person@example.com" } });
    const invite = screen.getByRole("button", { name: "Invite" });
    act(() => {
      invite.click();
      invite.click();
    });

    await waitFor(() => expect(mocks.createInvitation).toHaveBeenCalledTimes(1));
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      invitationActionRef: "invitation-action-a",
      email: "person@example.com",
      role: "editor"
    });
    expect(await screen.findByText(/They’ll see it when they sign in with that verified email/i)).toHaveFocus();
    expect(rendered.container).not.toHaveTextContent("p***@example.com");
    expect(rendered.container).not.toHaveTextContent(/email sent/i);
    expect(email).toHaveValue("");
  });

  it("shows the hosted capability message and no form when invitation targeting is unavailable", async () => {
    const unavailable = roster();
    unavailable.invitationManagement = {
      available: false,
      allowedRoles: [],
      message: "Invites aren’t available in this build yet."
    };
    mocks.loadMembers.mockResolvedValue(unavailable);
    render(view());

    expect(await screen.findByText("Invites aren’t available in this build yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
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
        ...member(),
        memberActionRef: "action-ref-b",
        role: "viewer",
        status: "active",
        revision: 1,
        displayName: "Beacon member",
        management: { allowedRoles: [], allowedActions: [], blockedReason: "permission-denied" }
      }]));
    });
    expect(await screen.findByText("Beacon member")).toBeInTheDocument();
    expect(rendered.container).not.toHaveTextContent("action-ref-b");
  });

  it("uses only projected management and requires an explicit role save", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    mocks.changeMember.mockResolvedValue({ status: "accepted", message: "saved" });
    render(view());

    const role = await screen.findByRole("combobox", { name: "Role for Alex" });
    expect(role).toHaveValue("editor");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(role, { target: { value: "viewer" } });
    expect(mocks.changeMember).not.toHaveBeenCalled();
    const save = screen.getByRole("button", { name: "Save" });
    act(() => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(mocks.changeMember).toHaveBeenCalledTimes(1));
    expect(mocks.changeMember).toHaveBeenCalledWith({
      memberActionRef: "action-ref-alex",
      action: "change-role",
      expectedRevision: 4,
      role: "viewer"
    });
    expect(await screen.findByText("Role saved.")).toHaveFocus();
  });

  it("renders projected pause and restore actions and plain blocked reasons", async () => {
    mocks.loadMembers.mockResolvedValue(roster("workspace-a", [
      member({ management: { allowedRoles: [], allowedActions: ["suspend"] } }),
      member({ memberActionRef: "ref-restoring", displayName: "Morgan", status: "suspended", management: { allowedRoles: [], allowedActions: ["reactivate"] } }),
      member({ memberActionRef: "ref-sole", displayName: "Sole owner", role: "owner", management: { allowedRoles: [], allowedActions: [], blockedReason: "last-active-owner" } }),
      member({ memberActionRef: "ref-protected", displayName: "Protected", role: "owner", management: { allowedRoles: [], allowedActions: [], blockedReason: "owner-protected" } }),
      member({ memberActionRef: "ref-denied", displayName: "Denied", management: { allowedRoles: [], allowedActions: [], blockedReason: "permission-denied" } })
    ]));
    mocks.changeMember.mockResolvedValue({ status: "accepted", message: "done" });
    render(view());

    fireEvent.click(await screen.findByRole("button", { name: "Pause access" }));
    await waitFor(() => expect(mocks.changeMember).toHaveBeenCalledWith({
      memberActionRef: "action-ref-alex", action: "suspend", expectedRevision: 4
    }));
    expect(screen.getByRole("button", { name: "Restore access" })).toBeInTheDocument();
    expect(screen.getByText(/Every workspace needs an owner/i)).toBeInTheDocument();
    expect(screen.getByText(/Owners can only be managed by another owner/i)).toBeInTheDocument();
    expect(screen.getByText(/Only workspace owners and admins/i)).toBeInTheDocument();
  });

  it("requires focused confirmation before permanent removal", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    mocks.changeMember.mockResolvedValue({ status: "accepted", message: "removed" });
    render(view());

    fireEvent.click((await screen.findAllByRole("button", { name: "Remove" }))[0]);
    const dialog = screen.getByRole("dialog", { name: "Remove Alex from Atlas?" });
    expect(dialog).toHaveTextContent(/permanently removes their workspace access/i);
    expect(dialog).toHaveTextContent(/revokes linked devices/i);
    expect(dialog).toHaveTextContent(/can’t be undone/i);
    expect(screen.getByRole("button", { name: "Keep access" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep access" }));
    expect(mocks.changeMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(mocks.changeMember).toHaveBeenCalledWith({
      memberActionRef: "action-ref-alex", action: "remove", expectedRevision: 4
    }));
  });

  it("reloads conflicts without reporting success", async () => {
    mocks.loadMembers
      .mockResolvedValueOnce(roster("workspace-a", [member()]))
      .mockResolvedValueOnce(roster("workspace-a", [member({ revision: 5 })]));
    mocks.changeMember.mockResolvedValue({ status: "conflict", code: "stale-revision", message: "stale" });
    render(view());

    fireEvent.click(await screen.findByRole("button", { name: "Pause access" }));
    const conflictMessage = await screen.findByText(/Access changed elsewhere/i);
    await waitFor(() => expect(conflictMessage).toHaveFocus());
    await waitFor(() => expect(mocks.loadMembers).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Access paused.")).not.toBeInTheDocument();
  });

  it("ignores an action completion after switching account and workspace", async () => {
    mocks.loadMembers
      .mockResolvedValueOnce(roster("workspace-a", [member()]))
      .mockResolvedValueOnce(roster("workspace-b", [member({
        memberActionRef: "action-ref-b",
        displayName: "Beacon member",
        management: { allowedRoles: [], allowedActions: [], blockedReason: "permission-denied" }
      })]));
    let finishAction: (value: unknown) => void = () => {};
    mocks.changeMember.mockImplementation(() => new Promise((resolve) => { finishAction = resolve; }));
    const rendered = render(view());

    fireEvent.click(await screen.findByRole("button", { name: "Pause access" }));
    await waitFor(() => expect(mocks.changeMember).toHaveBeenCalledTimes(1));
    rendered.rerender(view({
      workspaceName: "Beacon",
      fableWorkspaceId: "workspace-b",
      accountContextKey: "account-b"
    }));
    expect(await screen.findByText("Beacon member")).toBeInTheDocument();
    await act(async () => {
      finishAction({ status: "accepted", message: "paused" });
    });
    expect(screen.queryByText("Access paused.")).not.toBeInTheDocument();
    expect(mocks.loadMembers).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate a same-context load through Strict Mode or an ordinary rerender", async () => {
    mocks.loadMembers.mockResolvedValue(roster());
    const rendered = render(<StrictMode>{view()}</StrictMode>);
    await screen.findByText("Josh · You");
    rendered.rerender(<StrictMode>{view({ workspaceName: "Atlas renamed" })}</StrictMode>);
    await waitFor(() => expect(mocks.loadMembers).toHaveBeenCalledTimes(1));
  });
});
