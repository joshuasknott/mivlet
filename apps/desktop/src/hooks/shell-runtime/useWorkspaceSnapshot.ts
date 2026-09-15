import type { RuntimeSnapshot } from "@fable/protocol";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import {
  hasTauriRuntime,
  persistShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot,
} from "../../lib/persistence";
import type { PersistedShellState } from "../../lib/types";
import {
  loadRuntimeSnapshot,
  saveRuntimeSnapshot,
} from "../../runtime/domains/workspace";
import { defaultShellState } from "./defaults";

/** Owns snapshot hydration, failure recovery, and the identity-bound trailing writer. */
export function useWorkspaceSnapshot(options: {
  shellState: PersistedShellState;
  workspaceIdentityRef: RefObject<string | null>;
  workspaceScopeGeneration: number;
  activeWorkspaceScope: { workspaceId: string } | null;
  onReset: () => void;
  onHydrate: (state: PersistedShellState) => void;
  setLastAction: (message: string) => void;
}) {
  const {
    shellState,
    workspaceIdentityRef,
    workspaceScopeGeneration,
    activeWorkspaceScope,
  } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const setLastAction = (message: string) =>
    callbacks.current.setLastAction(message);
  const hydratedWorkspaceRef = useRef<string | null>(null);
  const snapshotLoadFailedRef = useRef(false);
  const [runtimeSnapshotReady, setRuntimeSnapshotReady] = useState(false);
  const [runtimeSnapshotError, setRuntimeSnapshotError] = useState<
    string | null
  >(null);
  // Coalesce account and settings changes into one trailing native write.
  // Conversation drafts have their own scoped writer and never enter this snapshot.
  const shellStateRef = useRef(shellState);
  shellStateRef.current = shellState;
  // Track whether a debounced localStorage write is still pending so an unmount
  // flush can guarantee the final settings land in storage. Rapid changes reset
  // the timer; only the trailing write fires.
  const persistTimerRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const pendingSnapshotRef = useRef<{
    identity: string;
    workspaceId: string;
    snapshot: RuntimeSnapshot;
  } | null>(null);
  const snapshotWrites = useRef<Promise<unknown>>(Promise.resolve());
  const writeSnapshot = (snapshot: RuntimeSnapshot, workspaceId: string) => {
    const identity = workspaceIdentityRef.current;
    const next = snapshotWrites.current
      .catch(() => undefined)
      .then(() => {
        if (!identity || workspaceIdentityRef.current !== identity)
          throw new Error(
            "The workspace changed before its settings could be saved.",
          );
        return saveRuntimeSnapshot(snapshot, workspaceId);
      });
    snapshotWrites.current = next;
    return next;
  };
  const flushSnapshot = async () => {
    const identity = workspaceIdentityRef.current;
    if (
      !runtimeSnapshotReady ||
      !activeWorkspaceScope ||
      !identity ||
      hydratedWorkspaceRef.current !== identity
    )
      throw new Error("Wait for workspace settings to load.");
    if (snapshotTimerRef.current !== null)
      window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = null;
    pendingSnapshotRef.current = null;
    await writeSnapshot(
      shellStateToRuntimeSnapshot(shellStateRef.current),
      activeWorkspaceScope.workspaceId,
    );
  };

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistShellState(shellStateRef.current);
    }, 300);
  }, [shellState]);

  // Flush any pending localStorage write on unmount so the final state persists.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persistShellState(shellStateRef.current);
      }
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    const identity = workspaceIdentityRef.current;
    if (
      !runtimeSnapshotReady ||
      !activeWorkspaceScope ||
      !identity ||
      hydratedWorkspaceRef.current !== identity
    ) {
      return;
    }

    // Debounced to coalesce rapid profile and workspace setting changes
    // into a single trailing snapshot save. Bind both the captured snapshot and
    // its owner/workspace so a later scope cannot receive this write.
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
    }
    const pending = {
      identity,
      workspaceId: activeWorkspaceScope.workspaceId,
      snapshot: shellStateToRuntimeSnapshot(shellState),
    };
    pendingSnapshotRef.current = pending;
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null;
      pendingSnapshotRef.current = null;
      if (
        workspaceIdentityRef.current !== pending.identity ||
        hydratedWorkspaceRef.current !== pending.identity
      )
        return;
      void writeSnapshot(pending.snapshot, pending.workspaceId).catch(
        (error) => {
          setLastAction(
            error instanceof Error
              ? error.message
              : "Mivlet could not save runtime snapshot.",
          );
        },
      );
    }, 300);
  }, [activeWorkspaceScope?.workspaceId, runtimeSnapshotReady, shellState]);

  // Flush any pending snapshot save on unmount so the final state is captured.
  useEffect(() => {
    return () => {
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
        const pending = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;
        if (
          pending &&
          workspaceIdentityRef.current === pending.identity &&
          hydratedWorkspaceRef.current === pending.identity
        ) {
          void writeSnapshot(pending.snapshot, pending.workspaceId).catch(
            () => undefined,
          );
        }
      }
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;
    if (!activeWorkspaceScope) {
      hydratedWorkspaceRef.current = null;
      setRuntimeSnapshotReady(false);
      return () => {
        active = false;
      };
    }

    // Fast Refresh may replay effects while preserving the live gate and run.
    // A completed hydration of this exact owner/workspace needs no replay.
    const hydrationIdentity = workspaceIdentityRef.current;
    if (hasTauriRuntime() && hydrationIdentity === null) return;
    if (
      hydrationIdentity !== null &&
      hydratedWorkspaceRef.current === hydrationIdentity
    )
      return;

    // A switch is a hard tenant boundary. Drop everything that can have been
    // loaded for the prior scope before any new asynchronous hydration lands.
    // Preview is an intentional in-memory fixture, so retain its seeded data.
    if (hasTauriRuntime()) {
      callbacks.current.onReset();
    }
    snapshotLoadFailedRef.current = false;
    setRuntimeSnapshotError(null);
    void loadRuntimeSnapshot(activeWorkspaceScope.workspaceId)
      .then((snapshot: RuntimeSnapshot | null) => {
        if (!active || workspaceIdentityRef.current !== hydrationIdentity) {
          return;
        }
        hydratedWorkspaceRef.current = hydrationIdentity;
        setRuntimeSnapshotReady(true);
        if (!snapshot) return;

        const recovered = shellStateFromRuntimeSnapshot(
          snapshot,
          defaultShellState,
        );
        callbacks.current.onHydrate(recovered);
        setLastAction("Recovered workspace from local runtime");
      })
      .catch((error) => {
        if (active && workspaceIdentityRef.current === hydrationIdentity) {
          hydratedWorkspaceRef.current = null;
          snapshotLoadFailedRef.current = true;
          setRuntimeSnapshotReady(false);
          const message =
            error instanceof Error
              ? error.message
              : "Mivlet could not load the saved workspace.";
          setRuntimeSnapshotError(message);
          setLastAction(message);
        }
      });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  // Called synchronously by the account owner before replacing its identity.
  const invalidate = () => {
    hydratedWorkspaceRef.current = null;
    if (snapshotTimerRef.current !== null)
      window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = null;
    pendingSnapshotRef.current = null;
    setRuntimeSnapshotReady(false);
  };
  return {
    runtime: {
      runtimeSnapshotReady,
      runtimeSnapshotError,
      flushSnapshot,
    },
    invalidate,
    shouldReload: () => snapshotLoadFailedRef.current,
  };
}
