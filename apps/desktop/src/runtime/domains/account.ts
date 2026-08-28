import type {
  AccountInvitationAcceptanceOutcome,
  AccountPendingInvitationList,
  AccountWorkspaceInvitationCreateOutcome,
  AccountWorkspaceInvitationCreateRequest,
  AccountWorkspaceMemberChangeOutcome,
  AccountWorkspaceMemberChangeRequest,
  AccountWorkspaceMemberList,
  AccountWorkspaceStatus,
  CloudMutationOutboxRow,
  CloudSyncEnqueueRequest,
  CloudSyncFlushResult,
  CloudSyncPullResult,
  CloudSyncStatus,
  CloudWorkspaceLinkState,
  IdentityStatus,
} from "@fable/protocol";
import { getActiveRuntimeDataScope } from "../../runtime-scope";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

export interface AccountRuntimePort {
  loadIdentityStatus(): Promise<IdentityStatus | null>;
  beginIdentitySignIn(): Promise<IdentityStatus | null>;
  beginIdentityRecovery(): Promise<IdentityStatus | null>;
  refreshIdentity(): Promise<IdentityStatus | null>;
  signOutIdentity(): Promise<IdentityStatus | null>;
  loadWorkspaceStatus(): Promise<AccountWorkspaceStatus | null>;
  reconcileWorkspace(): Promise<AccountWorkspaceStatus | null>;
  createWorkspace(name: string): Promise<AccountWorkspaceStatus | null>;
  selectWorkspace(
    fableWorkspaceId: string,
  ): Promise<AccountWorkspaceStatus | null>;
  revokeDevice(deviceId: string): Promise<AccountWorkspaceStatus | null>;
  clearWorkspaceSession(): Promise<void | null>;
  loadPendingInvitations(): Promise<AccountPendingInvitationList | null>;
  loadWorkspaceMembers(
    fableWorkspaceId: string,
  ): Promise<AccountWorkspaceMemberList | null>;
  changeWorkspaceMember(
    request: AccountWorkspaceMemberChangeRequest,
  ): Promise<AccountWorkspaceMemberChangeOutcome | null>;
  createWorkspaceInvitation(
    request: AccountWorkspaceInvitationCreateRequest,
  ): Promise<AccountWorkspaceInvitationCreateOutcome | null>;
  acceptPendingInvitation(
    invitationId: string,
  ): Promise<AccountInvitationAcceptanceOutcome | null>;
  loadCloudSyncStatus(workspaceId?: string): Promise<CloudSyncStatus | null>;
  loadCloudSyncLinkState(
    workspaceId?: string,
  ): Promise<CloudWorkspaceLinkState | null>;
  enqueueCloudSyncMutation(
    request: CloudSyncEnqueueRequest,
  ): Promise<CloudMutationOutboxRow | null>;
  flushCloudSyncOutbox(
    workspaceId?: string,
  ): Promise<CloudSyncFlushResult | null>;
  pullCloudSyncAfterCursor(
    workspaceId?: string,
  ): Promise<CloudSyncPullResult | null>;
}

function createAccountPort(adapter: RuntimeAdapter): AccountRuntimePort {
  const native = adapter.kind === "native";
  const invoke = <T>(command: string, args?: Record<string, unknown>) =>
    adapter.invoke<T>(command, args).catch((error: unknown) => {
      throw toRuntimeError(error);
    });
  const scopedWorkspace = (workspaceId?: string) =>
    workspaceId ?? getActiveRuntimeDataScope()?.workspaceId;

  return {
    async loadIdentityStatus() {
      if (!native) return null;
      try {
        return await adapter.invoke<IdentityStatus>("identity_status");
      } catch (error) {
        return {
          enabled: true,
          state: "error",
          message: toRuntimeError(error).message,
          scopes: [],
        };
      }
    },
    beginIdentitySignIn: () =>
      native ? invoke("identity_begin_sign_in") : Promise.resolve(null),
    beginIdentityRecovery: () =>
      native ? invoke("identity_begin_recovery") : Promise.resolve(null),
    refreshIdentity: () =>
      native ? invoke("identity_refresh") : Promise.resolve(null),
    signOutIdentity: () =>
      native ? invoke("identity_sign_out") : Promise.resolve(null),
    loadWorkspaceStatus: () =>
      native ? invoke("account_workspace_status") : Promise.resolve(null),
    reconcileWorkspace: () =>
      native ? invoke("account_workspace_reconcile") : Promise.resolve(null),
    createWorkspace: (name) =>
      native
        ? invoke("account_workspace_create", { name })
        : Promise.resolve(null),
    selectWorkspace: (fableWorkspaceId) =>
      native
        ? invoke("account_workspace_select", { fableWorkspaceId })
        : Promise.resolve(null),
    revokeDevice: (deviceId) =>
      native
        ? invoke("account_device_revoke", { deviceId })
        : Promise.resolve(null),
    clearWorkspaceSession: () =>
      native
        ? invoke<void>("account_workspace_clear_session")
        : Promise.resolve(null),
    loadPendingInvitations: () =>
      native
        ? invoke("account_membership_pending_invitations")
        : Promise.resolve(null),
    loadWorkspaceMembers: (fableWorkspaceId) =>
      native
        ? invoke("account_workspace_members", { fableWorkspaceId })
        : Promise.resolve(null),
    changeWorkspaceMember: (request) =>
      native
        ? invoke("account_workspace_member_change", { request })
        : Promise.resolve(null),
    createWorkspaceInvitation: (request) =>
      native
        ? invoke("account_workspace_invitation_create", { request })
        : Promise.resolve(null),
    acceptPendingInvitation: (invitationId) =>
      native
        ? invoke("account_membership_accept_invitation", { invitationId })
        : Promise.resolve(null),
    async loadCloudSyncStatus(workspaceId) {
      const scope = scopedWorkspace(workspaceId);
      if (!native || !scope) return null;
      try {
        return await adapter.invoke<CloudSyncStatus>("cloud_sync_status", {
          workspaceId: scope,
        });
      } catch {
        return null;
      }
    },
    async loadCloudSyncLinkState(workspaceId) {
      const scope = scopedWorkspace(workspaceId);
      if (!native || !scope) return null;
      try {
        return await adapter.invoke<CloudWorkspaceLinkState | null>(
          "cloud_sync_link_state",
          { workspaceId: scope },
        );
      } catch {
        return null;
      }
    },
    enqueueCloudSyncMutation: (request) => {
      const scope = getActiveRuntimeDataScope();
      if (!native || !scope || request.localWorkspaceId !== scope.workspaceId) {
        return Promise.resolve(null);
      }
      return invoke("cloud_sync_enqueue_shared_mutation", { request });
    },
    flushCloudSyncOutbox: (workspaceId) => {
      const scope = scopedWorkspace(workspaceId);
      return native && scope
        ? invoke("cloud_sync_flush_outbox", { workspaceId: scope })
        : Promise.resolve(null);
    },
    pullCloudSyncAfterCursor: (workspaceId) => {
      const scope = scopedWorkspace(workspaceId);
      return native && scope
        ? invoke("cloud_sync_pull_after_cursor", { workspaceId: scope })
        : Promise.resolve(null);
    },
  };
}

const ports = new WeakMap<RuntimeAdapter, AccountRuntimePort>();

function accountPort() {
  const adapter = getRuntimeAdapter();
  const existing = ports.get(adapter);
  if (existing) return existing;
  const port = createAccountPort(adapter);
  ports.set(adapter, port);
  return port;
}

export const loadRuntimeIdentityStatus = () =>
  accountPort().loadIdentityStatus();
export const beginRuntimeIdentitySignIn = () =>
  accountPort().beginIdentitySignIn();
export const beginRuntimeIdentityRecovery = () =>
  accountPort().beginIdentityRecovery();
export const refreshRuntimeIdentity = () => accountPort().refreshIdentity();
export const signOutRuntimeIdentity = () => accountPort().signOutIdentity();
export const loadRuntimeAccountWorkspaceStatus = () =>
  accountPort().loadWorkspaceStatus();
export const reconcileRuntimeAccountWorkspace = () =>
  accountPort().reconcileWorkspace();
export const createRuntimeAccountWorkspace = (name: string) =>
  accountPort().createWorkspace(name);
export const selectRuntimeAccountWorkspace = (fableWorkspaceId: string) =>
  accountPort().selectWorkspace(fableWorkspaceId);
export const revokeRuntimeAccountDevice = (deviceId: string) =>
  accountPort().revokeDevice(deviceId);
export const clearRuntimeAccountWorkspaceSession = () =>
  accountPort().clearWorkspaceSession();
export const loadRuntimePendingInvitations = () =>
  accountPort().loadPendingInvitations();
export const loadRuntimeWorkspaceMembers = (fableWorkspaceId: string) =>
  accountPort().loadWorkspaceMembers(fableWorkspaceId);
export const changeRuntimeWorkspaceMember = (
  request: AccountWorkspaceMemberChangeRequest,
) => accountPort().changeWorkspaceMember(request);
export const createRuntimeWorkspaceInvitation = (
  request: AccountWorkspaceInvitationCreateRequest,
) => accountPort().createWorkspaceInvitation(request);
export const acceptRuntimePendingInvitation = (invitationId: string) =>
  accountPort().acceptPendingInvitation(invitationId);
export const loadRuntimeCloudSyncStatus = (workspaceId?: string) =>
  accountPort().loadCloudSyncStatus(workspaceId);
export const loadRuntimeCloudSyncLinkState = (workspaceId?: string) =>
  accountPort().loadCloudSyncLinkState(workspaceId);
export const enqueueRuntimeCloudSyncMutation = (
  request: CloudSyncEnqueueRequest,
) => accountPort().enqueueCloudSyncMutation(request);
export const flushRuntimeCloudSyncOutbox = (workspaceId?: string) =>
  accountPort().flushCloudSyncOutbox(workspaceId);
export const pullRuntimeCloudSyncAfterCursor = (workspaceId?: string) =>
  accountPort().pullCloudSyncAfterCursor(workspaceId);
