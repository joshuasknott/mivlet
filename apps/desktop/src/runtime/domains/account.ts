import type { AccountWorkspaceStatus, IdentityStatus } from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
import type { RuntimeAdapter } from "../ports";
import { readWithDeadline } from "../read-deadline";

/** Native identity opens an account-owned local workspace. Hosted inventory is
 * optional; changing the account tears down and restarts the native process. */
interface AccountRuntimePort {
  loadIdentityStatus(): Promise<IdentityStatus | null>;
  prepareIdentitySignIn(): Promise<string | null>;
  cancelIdentitySignIn(attemptId: string): Promise<boolean>;
  beginIdentitySignIn(
    attemptId: string,
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
        return await readWithDeadline(
          adapter.invoke<IdentityStatus>("identity_status"),
          "Account verification took too long. Try again.",
        );
      } catch (error) {
        return {
          enabled: true,
          state: "error",
          message: toRuntimeError(error).message,
          scopes: [],
        };
      }
    },
    prepareIdentitySignIn: () =>
      native
        ? invoke<string>("identity_prepare_sign_in")
        : Promise.resolve(null),
    cancelIdentitySignIn: (attemptId) =>
      native
        ? invoke<boolean>("identity_cancel_sign_in", { attemptId })
        : Promise.resolve(true),
    beginIdentitySignIn: (attemptId, mode = "sign-in") =>
      native
        ? invoke("identity_begin_sign_in", { mode, attemptId })
        : Promise.resolve(null),
    beginIdentityRecovery: () =>
      native ? invoke("identity_begin_recovery") : Promise.resolve(null),
    refreshIdentity: () =>
      native ? invoke("identity_refresh") : Promise.resolve(null),
    signOutIdentity: () =>
      native ? invoke("identity_sign_out") : Promise.resolve(null),
    loadWorkspaceStatus: () =>
      native
        ? readWithDeadline(
            invoke<AccountWorkspaceStatus>("account_workspace_status"),
            "Loading your account workspace took too long. Try again.",
          )
        : Promise.resolve(null),
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
export const prepareRuntimeIdentitySignIn = () =>
  accountPort().prepareIdentitySignIn();
export const cancelRuntimeIdentitySignIn = (attemptId: string) =>
  accountPort().cancelIdentitySignIn(attemptId);
export const beginRuntimeIdentitySignIn = (
  attemptId: string,
  mode: "sign-in" | "sign-up" = "sign-in",
) => accountPort().beginIdentitySignIn(attemptId, mode);
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
