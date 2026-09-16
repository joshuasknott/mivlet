import type { ExternalAuthenticationFacts, WorkspaceRole } from "../spine/identity.js";

// ---------------------------------------------------------------------------
// Optional Mivlet account state.
//
// The account is an opt-in boundary for hosted computers and future sync. It
// never owns the local conversation workspace, provider credentials, or local
// execution authority. Refresh/session credentials remain inside the native
// OS-keyring boundary.
// ---------------------------------------------------------------------------

export type AccountSessionState =
  | "disabled"
  | "signed-out"
  | "signed-in"
  | "offline"
  | "refreshing"
  | "expired"
  | "revoked"
  | "error";

export interface VerifiedAccountDisplayAttributes {
  displayName?: string;
  /** Present only when the identity provider marks the address as verified. */
  email?: string;
}

/** Secret-free facts from a validated external account session. */
export interface AccountAuthenticationFacts extends ExternalAuthenticationFacts {
  verifiedDisplayAttributes?: VerifiedAccountDisplayAttributes;
}

export interface IdentityStatus {
  enabled: boolean;
  state: AccountSessionState;
  message: string;
  issuer?: string;
  audience?: string;
  scopes: string[];
  authentication?: AccountAuthenticationFacts;
}

export type AccountWorkspaceLifecycleState =
  | "disabled"
  | "signed-out"
  | "bootstrapping"
  | "ready"
  | "offline"
  | "expired"
  | "revoked"
  | "error";

/** Hosted account workspace available to the optional computer service. */
export interface AccountWorkspaceSummary {
  fableWorkspaceId: string;
  localWorkspaceId: string;
  name: string;
  workspaceStatus: "active" | "locked" | "pending-deletion" | "deleted";
  workspaceRevision: number;
  policyRevision: number;
  memberId: string;
  role: WorkspaceRole;
  membershipStatus: "active" | "suspended" | "removed";
  membershipRevision: number;
  updatedAt: string;
}

export interface ActiveWorkspaceSelection {
  localWorkspaceId: string;
  fableWorkspaceId?: string;
  name: string;
  source: "hosted" | "local" | "unbound" | "preview";
}

export interface AccountDeviceSummary {
  deviceId: string;
  kind: "desktop" | "mobile" | "web";
  label: string;
  status: "pending" | "active" | "revoked";
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/**
 * Secret-free native state for the always-local workspace plus any optional
 * hosted account inventory. The active workspace and active context owner are
 * installation-local even when an account is signed in.
 */
export interface AccountWorkspaceStatus {
  configured: boolean;
  state: AccountWorkspaceLifecycleState;
  message: string;
  /** True when the installation-local workspace is ready. */
  accountBound: boolean;
  /** Hosted account workspaces; empty while signed out or unconfigured. */
  workspaces: AccountWorkspaceSummary[];
  activeWorkspace: ActiveWorkspaceSelection;
  activeContextOwner?: {
    internalUserId: string;
    memberId?: string;
  };
  /** Hosted account devices; empty while signed out or unconfigured. */
  devices: AccountDeviceSummary[];
}
