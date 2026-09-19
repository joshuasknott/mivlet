import type { AccountWorkspaceStatus, IdentityStatus } from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";

/** Native identity opens an account-owned local workspace. Hosted inventory is
 * optional; changing the account tears down and restarts the native process. */
export interface AccountRuntimePort {
  loadIdentityStatus(): Promise<IdentityStatus | null>;
  beginIdentitySignIn(
    mode?: "sign-in" | "sign-up",
  ): Promise<IdentityStatus | null>;
  beginIdentityRecovery(): Promise<IdentityStatus | null>;
  refreshIdentity(): Promise<IdentityStatus | null>;
  signOutIdentity(): Promise<IdentityStatus | null>;
  loadWorkspaceStatus(): Promise<AccountWorkspaceStatus | null>;
  reconcileWorkspace(): Promise<AccountWorkspaceStatus | null>;
  clearWorkspaceSession(): Promise<void | null>;
}

function createAccountPort(adapter: RuntimeAdapter): AccountRuntimePort {
  const native = adapter.kind === "native";
  const invoke = <T>(command: string, args?: Record<string, unknown>) =>
    adapter.invoke<T>(command, args).catch((error: unknown) => {
      throw toRuntimeError(error);
    });

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
    beginIdentitySignIn: (mode = "sign-in") =>
      native
        ? invoke("identity_begin_sign_in", { mode })
        : Promise.resolve(null),
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
    clearWorkspaceSession: () =>
      native
        ? invoke<void>("account_workspace_clear_session")
        : Promise.resolve(null),
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
export const beginRuntimeIdentitySignIn = (
  mode: "sign-in" | "sign-up" = "sign-in",
) => accountPort().beginIdentitySignIn(mode);
export const beginRuntimeIdentityRecovery = () =>
  accountPort().beginIdentityRecovery();
export const refreshRuntimeIdentity = () => accountPort().refreshIdentity();
export const signOutRuntimeIdentity = () => accountPort().signOutIdentity();
export const loadRuntimeAccountWorkspaceStatus = () =>
  accountPort().loadWorkspaceStatus();
export const reconcileRuntimeAccountWorkspace = () =>
  accountPort().reconcileWorkspace();
export const clearRuntimeAccountWorkspaceSession = () =>
  accountPort().clearWorkspaceSession();

export const runtimeAccountTheme = (value?: "light" | "dark") =>
  getRuntimeAdapter().invoke<"light" | "dark">("account_theme", { value });
