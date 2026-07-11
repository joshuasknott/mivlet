import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptRuntimePendingInvitation,
  changeRuntimeWorkspaceMember,
  createRuntimeWorkspaceInvitation,
  loadRuntimePendingInvitations,
  loadRuntimeWorkspaceMembers
} from "./runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("membership invitation runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
  });

  it("does not simulate an invitation inbox outside Tauri", async () => {
    await expect(loadRuntimePendingInvitations()).resolves.toBeNull();
    await expect(loadRuntimeWorkspaceMembers("workspace-a")).resolves.toBeNull();
    await expect(changeRuntimeWorkspaceMember({
      memberActionRef: "member-action-a",
      action: "suspend",
      expectedRevision: 2
    })).resolves.toBeNull();
    await expect(createRuntimeWorkspaceInvitation({
      invitationActionRef: "invitation-action-a",
      email: "person@example.com",
      role: "editor"
    })).resolves.toBeNull();
    await expect(acceptRuntimePendingInvitation("invitation-a")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invokes only the fixed inbox commands with the allowed invitation id", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce({ invitations: [] })
      .mockResolvedValueOnce({ workspaceId: "workspace-a", actorRole: "owner", members: [] })
      .mockResolvedValueOnce({ status: "accepted", message: "Workspace access updated." })
      .mockResolvedValueOnce({ status: "accepted", invitationId: "invite-a" })
      .mockResolvedValueOnce({ result: { status: "rejected" }, accountWorkspace: {} });

    await loadRuntimePendingInvitations();
    await loadRuntimeWorkspaceMembers("workspace-a");
    await changeRuntimeWorkspaceMember({
      memberActionRef: "member-action-a",
      action: "change-role",
      expectedRevision: 2,
      role: "viewer"
    });
    await createRuntimeWorkspaceInvitation({
      invitationActionRef: "invitation-action-a",
      email: "person@example.com",
      role: "editor"
    });
    await acceptRuntimePendingInvitation("invitation-a");

    expect(mocks.invoke.mock.calls).toEqual([
      ["account_membership_pending_invitations"],
      ["account_workspace_members", { fableWorkspaceId: "workspace-a" }],
      ["account_workspace_member_change", { request: {
        memberActionRef: "member-action-a",
        action: "change-role",
        expectedRevision: 2,
        role: "viewer"
      } }],
      ["account_workspace_invitation_create", { request: {
        invitationActionRef: "invitation-action-a",
        email: "person@example.com",
        role: "editor"
      } }],
      ["account_membership_accept_invitation", { invitationId: "invitation-a" }]
    ]);
  });

  it("surfaces native failures without inventing a successful outcome", async () => {
    setNative(true);
    mocks.invoke.mockRejectedValueOnce({ message: "The invitation is unavailable." });
    await expect(acceptRuntimePendingInvitation("invitation-a"))
      .rejects.toThrow("The invitation is unavailable.");
  });
});
