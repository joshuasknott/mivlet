import type { AccountWorkspaceStatus, IdentityStatus } from "@mivlet/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasTauriRuntime } from "../../lib/persistence";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../../runtime-scope";
import {
  beginRuntimeIdentityRecovery,
  beginRuntimeIdentitySignIn,
  prepareRuntimeIdentitySignIn,
  cancelRuntimeIdentitySignIn,
  clearRuntimeAccountWorkspaceSession,
  loadRuntimeAccountWorkspaceStatus,
  loadRuntimeIdentityStatus,
  reconcileRuntimeAccountWorkspace,
  refreshRuntimeIdentity,
  signOutRuntimeIdentity,
} from "../../runtime/domains/account";
import {
  DEFAULT_ACCOUNT_WORKSPACE_STATUS,
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_ACCOUNT_WORKSPACE_STATUS,
  PREVIEW_IDENTITY_STATUS,
} from "./defaults";

/** Owns account requests and the synchronous boundary between workspace identities. */
export function useAccountWorkspace(options: {
  onScopeChange: () => void;
  shouldReload: () => boolean;
  setLastAction: (message: string) => void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const setLastAction = (message: string) =>
    callbacks.current.setLastAction(message);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>(() =>
    hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS,
  );
  const [identityPending, setIdentityPending] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(hasTauriRuntime());
  const loginRef = useRef<{
    prepared: Promise<string | null>;
    cancelled: boolean;
  } | null>(null);
  const identityReadGeneration = useRef(0);
  const [accountWorkspaceStatus, setAccountWorkspaceStatus] =
    useState<AccountWorkspaceStatus>(() =>
      hasTauriRuntime()
        ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
        : PREVIEW_ACCOUNT_WORKSPACE_STATUS,
    );
  const [accountWorkspacePending, setAccountWorkspacePending] =
    useState(hasTauriRuntime());
  const accountWorkspaceFallback = hasTauriRuntime()
    ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
    : PREVIEW_ACCOUNT_WORKSPACE_STATUS;
  const [workspaceScopeGeneration, setWorkspaceScopeGeneration] = useState(0);
  const workspaceIdentityRef = useRef<string | null>(null);
  const accountRequestGenerationRef = useRef(0);
  const activeWorkspaceScope =
    accountWorkspaceStatus.accountBound &&
    (accountWorkspaceStatus.state === "ready" ||
      accountWorkspaceStatus.state === "offline")
      ? { workspaceId: accountWorkspaceStatus.activeWorkspace.localWorkspaceId }
      : null;
  const applyAccountWorkspaceStatus = useCallback(
    (status: AccountWorkspaceStatus) => {
      const canUseWorkspace =
        status.accountBound &&
        (status.state === "ready" || status.state === "offline") &&
        status.activeWorkspace.localWorkspaceId.length > 0;
      const identity = canUseWorkspace
        ? JSON.stringify([
            status.activeWorkspace.localWorkspaceId,
            status.activeContextOwner?.internalUserId ?? "",
            status.activeContextOwner?.memberId ?? "",
          ])
        : null;
      const changed = workspaceIdentityRef.current !== identity;
      const reload = callbacks.current.shouldReload();
      if (changed || reload) {
        // Settle old promises before dropping the visible queue or changing the
        // active native data scope. Historical requests never become permits.
        callbacks.current.onScopeChange();
        workspaceIdentityRef.current = identity;
      }
      if (canUseWorkspace) {
        setActiveRuntimeDataScope(status.activeWorkspace.localWorkspaceId);
      } else {
        clearActiveRuntimeDataScope();
      }
      setAccountWorkspaceStatus(status);
      if (changed || reload)
        setWorkspaceScopeGeneration((current) => current + 1);
    },
    [],
  );

  const refreshAccountWorkspace = useCallback(
    async (reconcile = false) => {
      const requestGeneration = ++accountRequestGenerationRef.current;
      setAccountWorkspacePending(true);
      try {
        const status = reconcile
          ? await reconcileRuntimeAccountWorkspace()
          : await loadRuntimeAccountWorkspaceStatus();
        if (requestGeneration !== accountRequestGenerationRef.current) {
          return status ?? accountWorkspaceFallback;
        }
        applyAccountWorkspaceStatus(status ?? accountWorkspaceFallback);
        return status ?? accountWorkspaceFallback;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Mivlet could not load account workspaces.";
        let localFallback = accountWorkspaceFallback;
        if (reconcile && hasTauriRuntime()) {
          try {
            // Hosted reconciliation is optional. If it fails, re-read the
            // native local status so the validated account owner survives;
            // the static boot fallback is not an authority-bearing identity.
            localFallback =
              (await loadRuntimeAccountWorkspaceStatus()) ?? localFallback;
          } catch {
            // Preserve the original reconciliation failure below.
          }
        }
        const failed: AccountWorkspaceStatus = {
          ...localFallback,
          message: localFallback.accountBound
            ? `Account workspace ready. Hosted refresh failed: ${message}`
            : `Account workspace unavailable: ${message}`,
        };
        if (requestGeneration === accountRequestGenerationRef.current) {
          applyAccountWorkspaceStatus(failed);
        }
        return failed;
      } finally {
        if (requestGeneration === accountRequestGenerationRef.current) {
          setAccountWorkspacePending(false);
        }
      }
    },
    [applyAccountWorkspaceStatus],
  );

  const refreshIdentityStatus = useCallback(async () => {
    const generation = ++identityReadGeneration.current;
    const status = await loadRuntimeIdentityStatus();
    if (generation !== identityReadGeneration.current) return;
    setIdentityStatus(
      status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS),
    );
    setIdentityLoading(false);
  }, []);

  useEffect(() => {
    void refreshIdentityStatus();
  }, [refreshIdentityStatus]);

  useEffect(() => {
    if (hasTauriRuntime()) void refreshAccountWorkspace(false);
  }, [refreshAccountWorkspace]);

  const signInIdentity = useCallback(
    async (mode: "sign-in" | "sign-up" = "sign-in") => {
      if (loginRef.current) return;
      ++identityReadGeneration.current;
      const attempt = {
        prepared: prepareRuntimeIdentitySignIn(),
        cancelled: false,
      };
      loginRef.current = attempt;
      setIdentityPending(true);
      setIdentityStatus((current) => ({
        ...current,
        message:
          "Continue in your browser. Mivlet will reopen when your account is ready.",
      }));
      try {
        const attemptId = await attempt.prepared;
        if (attempt.cancelled) return;
        const status = await beginRuntimeIdentitySignIn(
          attemptId ?? "preview",
          mode,
        );
        if (attempt.cancelled || loginRef.current !== attempt) return;
        const next =
          status ??
          (hasTauriRuntime()
            ? DEFAULT_IDENTITY_STATUS
            : PREVIEW_IDENTITY_STATUS);
        setIdentityStatus(next);
        if (next.state === "signed-in") {
          await refreshAccountWorkspace(false);
        }
        setLastAction(next.message);
      } catch (error) {
        if (attempt.cancelled || loginRef.current !== attempt) return;
        const message =
          error instanceof Error
            ? error.message
            : "Mivlet cloud sign-in is unavailable.";
        setIdentityStatus((current) => ({
          ...current,
          state: current.enabled ? "error" : "disabled",
          message,
        }));
        setLastAction(message);
      } finally {
        if (loginRef.current === attempt && !attempt.cancelled) {
          loginRef.current = null;
          setIdentityPending(false);
        }
      }
    },
    [refreshAccountWorkspace],
  );

  const cancelIdentitySignIn = useCallback(async () => {
    const attempt = loginRef.current;
    if (!attempt) return;
    attempt.cancelled = true;
    try {
      const id = await attempt.prepared.catch(() => null);
      const cancelled = !id || (await cancelRuntimeIdentitySignIn(id));
      if (!cancelled) {
        attempt.cancelled = false;
        setIdentityStatus((current) => ({
          ...current,
          message:
            "Your account is verified. Mivlet is reopening your workspace…",
        }));
        return;
      }
      if (loginRef.current === attempt) {
        loginRef.current = null;
        setIdentityPending(false);
        setIdentityStatus((current) => ({
          ...current,
          message: "Sign-in cancelled. Choose Log in or Create an account.",
        }));
      }
    } catch (error) {
      attempt.cancelled = false;
      throw error;
    }
  }, []);

  const recoverIdentity = useCallback(async () => {
    setIdentityPending(true);
    try {
      const status = await beginRuntimeIdentityRecovery();
      const next =
        status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      if (next.state === "signed-in") await refreshAccountWorkspace(false);
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet account recovery is unavailable.";
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [refreshAccountWorkspace]);

  const refreshIdentity = useCallback(async () => {
    setIdentityPending(true);
    try {
      const status = await refreshRuntimeIdentity();
      if (status) {
        setIdentityStatus(status);
        setLastAction(status.message);
        if (status.state === "signed-in") await refreshAccountWorkspace(false);
      } else {
        await refreshIdentityStatus();
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet cloud identity could not refresh.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message,
      }));
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [refreshAccountWorkspace, refreshIdentityStatus]);

  const signOutIdentity = useCallback(async () => {
    ++accountRequestGenerationRef.current;
    ++identityReadGeneration.current;
    setIdentityLoading(false);
    setIdentityPending(true);
    try {
      const status = await signOutRuntimeIdentity();
      if (!status && hasTauriRuntime())
        throw new Error("Mivlet could not confirm sign out. Try again.");
      await clearRuntimeAccountWorkspaceSession();
      applyAccountWorkspaceStatus({
        ...DEFAULT_ACCOUNT_WORKSPACE_STATUS,
        message:
          "Signed out of Mivlet. Your workspace is saved on this device.",
      });
      const next =
        status ??
        (hasTauriRuntime()
          ? DEFAULT_IDENTITY_STATUS
          : {
              enabled: true,
              state: "signed-out" as const,
              scopes: [],
              message: "Preview account signed out.",
            });
      setIdentityStatus(next);
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Mivlet could not sign out.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message,
      }));
      setLastAction(message);
      throw new Error(message);
    } finally {
      setIdentityPending(false);
    }
  }, [applyAccountWorkspaceStatus]);

  const reconcileAccountWorkspace = useCallback(async () => {
    await refreshIdentityStatus();
    const status = await refreshAccountWorkspace(false);
    setLastAction(status.message);
  }, [refreshIdentityStatus, refreshAccountWorkspace]);

  return {
    runtime: {
      identityStatus,
      identityPending,
      accountWorkspaceStatus,
      accountWorkspacePending: accountWorkspacePending || identityLoading,
      signInIdentity,
      cancelIdentitySignIn,
      recoverIdentity,
      refreshIdentity,
      signOutIdentity,
      reconcileAccountWorkspace,
    },
    workspaceScopeGeneration,
    workspaceIdentityRef,
    activeWorkspaceScope,
  };
}
