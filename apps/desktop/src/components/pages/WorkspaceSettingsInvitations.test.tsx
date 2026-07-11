import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPendingInvitation } from "@fable/protocol";
import { WorkspaceSettingsView } from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  accept: vi.fn()
}));

vi.mock("../../runtime", () => ({
  loadRuntimePendingInvitations: mocks.load,
  acceptRuntimePendingInvitation: mocks.accept
}));

afterEach(cleanup);

function pending(invitationId = "invite-1"): AccountPendingInvitation {
  return {
    invitation: {
      workspaceId: "workspace-1" as never,
      authority: "convex",
      schemaVersion: 1 as never,
      revision: 1 as never,
      createdByInternalUserId: "user-1" as never,
      createdAt: "2026-07-11T09:00:00.000Z" as never,
      updatedAt: "2026-07-11T09:00:00.000Z" as never,
      invitationId: invitationId as never,
      status: "pending",
      role: "editor",
      inviterMemberId: "member-1" as never,
      recipientConstraint: { kind: "internal-user", internalUserId: "user-2" as never },
      expiresAt: "2026-07-18T09:00:00.000Z" as never
    },
    selection: { kind: "direct-inbox", invitationId: invitationId as never }
  };
}

function renderInbox(onInvitationAccepted = vi.fn().mockResolvedValue(undefined)) {
  render(
    <WorkspaceSettingsView
      workspaceName="My workspace"
      onStatus={() => {}}
      onInvitationAccepted={onInvitationAccepted}
    />
  );
  return onInvitationAccepted;
}

describe("workspace invitation inbox", () => {
  beforeEach(() => {
    mocks.load.mockReset();
    mocks.accept.mockReset();
  });

  it("loads addressed invitations and accepts the exact selected id once", async () => {
    mocks.load.mockResolvedValue({ invitations: [pending()] });
    let finishAccept: (value: unknown) => void = () => {};
    mocks.accept.mockImplementation(() => new Promise((resolve) => { finishAccept = resolve; }));
    const refreshed = renderInbox();

    expect(await screen.findByText("Workspace invitation")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Accept invitation" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(mocks.accept).toHaveBeenCalledWith("invite-1");
    expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();

    finishAccept({ result: { status: "accepted" }, accountWorkspace: {} });
    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/workspace is now available from the workspace selector/i)).toHaveFocus();
    expect(screen.getByText("No pending invitations.")).toBeInTheDocument();
  });

  it("keeps rejected invitations visible and never reports success", async () => {
    mocks.load.mockResolvedValue({ invitations: [pending("invite-rejected")] });
    mocks.accept.mockResolvedValue({ result: { status: "rejected", error: {} }, accountWorkspace: {} });
    const refreshed = renderInbox();

    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/invitation is no longer available/i)).toBeInTheDocument();
    expect(refreshed).not.toHaveBeenCalled();
    expect(screen.getByText("Workspace invitation")).toBeInTheDocument();
    expect(screen.queryByText(/workspace is now available/i)).not.toBeInTheDocument();
  });

  it("shows honest load, desktop-service, and acceptance errors", async () => {
    mocks.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null);
    renderInbox();
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t be loaded/i);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/require the Fable desktop account service/i)).toBeInTheDocument();
    expect(screen.queryByText(/WIP|coming soon|accepted/i)).not.toBeInTheDocument();
  });

  it("surfaces acceptance transport errors without removing the invitation", async () => {
    mocks.load.mockResolvedValue({ invitations: [pending("invite-offline")] });
    mocks.accept.mockRejectedValue(new Error("offline"));
    renderInbox();
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/couldn’t be accepted/i)).toBeInTheDocument();
    expect(screen.getByText("Workspace invitation")).toBeInTheDocument();
  });

  it("keeps accepted truth when the parent workspace refresh fails", async () => {
    mocks.load.mockResolvedValue({ invitations: [pending("invite-refresh")] });
    mocks.accept.mockResolvedValue({ result: { status: "accepted" }, accountWorkspace: {} });
    const refreshed = vi.fn().mockRejectedValue(new Error("refresh offline"));
    renderInbox(refreshed);
    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/invitation accepted.*couldn’t refresh yet/i)).toBeInTheDocument();
    expect(screen.getByText("No pending invitations.")).toBeInTheDocument();
    expect(screen.queryByText(/invitation couldn’t be accepted/i)).not.toBeInTheDocument();
  });
});
