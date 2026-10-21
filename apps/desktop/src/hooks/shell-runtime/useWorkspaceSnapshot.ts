import type { MivletAgentProfile, RuntimeSnapshot, WorkspaceManageRequest } from "@mivlet/protocol";
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
import { manageWorkspace } from "../../runtime/domains/workspace-management";
import { reconcileWorkspaceAgents } from "../../lib/workspace-agent-reconciliation";

/** Owns snapshot hydration, failure recovery, and the identity-bound trailing writer. */
export function useWorkspaceSnapshot(options: {
  shellState: PersistedShellState;
  workspaceIdentityRef: RefObject<string | null>;
  workspaceScopeGeneration: number;
  activeWorkspaceScope: { workspaceId: string } | null;
  onReset: () => void;
  onHydrate: (state: PersistedShellState) => void;
  onAgentsChanged: (agents: MivletAgentProfile[], revision: number, activeAgentId: string) => void;
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
    generation: number;
    workspaceId: string;
    snapshot: RuntimeSnapshot;
  } | null>(null);
  const snapshotWrites = useRef<Promise<unknown>>(Promise.resolve());
  const agentRevision = useRef(shellState.agentRevision ?? 0);
  const scopeIsCurrent = (
    identity: string,
    workspaceId: string,
    generation: number,
  ) =>
    Boolean(
      identity &&
        workspaceIdentityRef.current === identity &&
        hydratedWorkspaceRef.current === identity &&
        callbacks.current.activeWorkspaceScope?.workspaceId === workspaceId &&
        callbacks.current.workspaceScopeGeneration === generation,
    );
  const saveSnapshotForScope = async (
    snapshot: RuntimeSnapshot,
    workspaceId: string,
    identity: string,
    generation: number,
  ) => {
    if (!scopeIsCurrent(identity, workspaceId, generation))
      throw new Error("The workspace changed before its settings could be saved.");
    const result = await saveRuntimeSnapshot(snapshot, workspaceId);
    if (!scopeIsCurrent(identity, workspaceId, generation))
      throw new Error("The workspace changed before its settings could be saved.");
    return result;
  };
  const writeSnapshot = (snapshot: RuntimeSnapshot, workspaceId: string) => {
    const identity = workspaceIdentityRef.current;
    const generation = workspaceScopeGeneration;
    const next = snapshotWrites.current
      .catch(() => undefined)
      .then(() => {
        if (!identity || !scopeIsCurrent(identity, workspaceId, generation))
          throw new Error(
            "The workspace changed before its settings could be saved.",
          );
        // A timer queued before a native roster change must not save its old
        // roster with a new revision. Read the reconciled current state instead.
        const nextSnapshot = (snapshot.agentRevision ?? 0) === agentRevision.current
          ? snapshot
          : shellStateToRuntimeSnapshot(shellStateRef.current);
        return saveSnapshotForScope(nextSnapshot, workspaceId, identity, generation);
      });
    snapshotWrites.current = next;
    return next;
  };
  const flushSnapshot = async (state?: PersistedShellState) => {
    const identity = workspaceIdentityRef.current;
    const workspaceId = activeWorkspaceScope?.workspaceId;
    const generation = workspaceScopeGeneration;
    if (
      !runtimeSnapshotReady ||
      !workspaceId ||
      !identity ||
      !scopeIsCurrent(identity, workspaceId, generation)
    )
      throw new Error("Wait for workspace settings to load.");
    if (snapshotTimerRef.current !== null)
      window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = null;
    pendingSnapshotRef.current = null;
    await writeSnapshot(
      shellStateToRuntimeSnapshot(state ?? shellStateRef.current),
      workspaceId,
    );
    // A scope can change while the native write is in flight. Never let the
    // caller commit UI state after that boundary has moved.
    if (
      workspaceIdentityRef.current !== identity ||
      hydratedWorkspaceRef.current !== identity ||
      callbacks.current.activeWorkspaceScope?.workspaceId !== workspaceId ||
      callbacks.current.workspaceScopeGeneration !== generation
    ) {
      throw new Error("The workspace changed before its settings could be saved.");
    }
  };

  const manageWorkspaceFromChat = (request: Omit<WorkspaceManageRequest, "workspaceId" | "expectedAgentRevision">) => {
    const identity = workspaceIdentityRef.current;
    const workspaceId = activeWorkspaceScope?.workspaceId;
    const generation = workspaceScopeGeneration;
    const assertCurrent = () => {
      if (!runtimeSnapshotReady || !identity || !workspaceId
        || workspaceIdentityRef.current !== identity || hydratedWorkspaceRef.current !== identity
        || callbacks.current.activeWorkspaceScope?.workspaceId !== workspaceId
        || callbacks.current.workspaceScopeGeneration !== generation) {
        throw new Error("The workspace changed before its settings could be saved.");
      }
    };
    const cancelPendingWrite = () => {
      if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
      pendingSnapshotRef.current = null;
    };
    const next = snapshotWrites.current.catch(() => undefined).then(async () => {
      assertCurrent();
      cancelPendingWrite();
      const before = shellStateRef.current;
      await saveSnapshotForScope(
        shellStateToRuntimeSnapshot(before),
        workspaceId!,
        identity!,
        generation,
      );
      assertCurrent();
      const result = await manageWorkspace({ ...request, workspaceId: workspaceId!, expectedAgentRevision: agentRevision.current });
      assertCurrent();
      const current = shellStateRef.current;
      const merged = reconcileWorkspaceAgents(before.agents ?? [], current.agents ?? [], result.agents);
      const activeAgentId = merged.agents.some(agent => agent.id === current.activeAgentId)
        ? current.activeAgentId!
        : merged.agents.find(agent => agent.id === result.activeAgentId)?.id ?? merged.agents[0]?.id;
      if (!activeAgentId) throw new Error("The workspace action returned no usable agent. Reload the workspace.");
      agentRevision.current = result.agentRevision;
      const state = { ...current, agents: merged.agents, agentRevision: result.agentRevision, activeAgentId };
      // Update the ref before React renders, so an already queued flush sees
      // the saved roster and settings changes made while the tool was running.
      shellStateRef.current = state;
      cancelPendingWrite();
      if (JSON.stringify(current.agents) !== JSON.stringify(merged.agents)
        || current.agentRevision !== result.agentRevision || current.activeAgentId !== activeAgentId) {
        callbacks.current.onAgentsChanged(merged.agents, result.agentRevision, activeAgentId);
      }
      if (merged.conflict) setLastAction("The saved chat change overlapped an agent settings edit. Review that agent's current settings.");
      else if (result.receipt.operation !== "inspect") setLastAction(result.receipt.summary);
      // Preserve unrelated changes made while native execution was in flight.
      // A failed trailing save must not misreport an already committed tool as
      // failed or encourage the model to repeat its effect.
      try {
        await saveSnapshotForScope(
          shellStateToRuntimeSnapshot(state),
          workspaceId!,
          identity!,
          generation,
        );
      } catch {
        assertCurrent();
        setLastAction("The chat change was saved. Some simultaneous settings could not be saved; reload before editing them again.");
      }
      assertCurrent();
      return result;
    });
    snapshotWrites.current = next;
    return next;
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
      generation: workspaceScopeGeneration,
      workspaceId: activeWorkspaceScope.workspaceId,
      snapshot: shellStateToRuntimeSnapshot(shellState),
    };
    pendingSnapshotRef.current = pending;
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null;
      pendingSnapshotRef.current = null;
      if (
        workspaceIdentityRef.current !== pending.identity ||
        hydratedWorkspaceRef.current !== pending.identity ||
        callbacks.current.workspaceScopeGeneration !== pending.generation
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
          hydratedWorkspaceRef.current === pending.identity &&
          callbacks.current.workspaceScopeGeneration === pending.generation
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
    const hydrationGeneration = workspaceScopeGeneration;
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
        if (
          !active ||
          workspaceIdentityRef.current !== hydrationIdentity ||
          callbacks.current.workspaceScopeGeneration !== hydrationGeneration
        ) {
          return;
        }
        hydratedWorkspaceRef.current = hydrationIdentity;
        setRuntimeSnapshotReady(true);
        agentRevision.current = snapshot?.agentRevision ?? 0;
        if (!snapshot) return;

        const recovered = shellStateFromRuntimeSnapshot(
          snapshot,
          defaultShellState,
        );
        callbacks.current.onHydrate(recovered);
        setLastAction("Recovered workspace from local runtime");
      })
      .catch((error) => {
        if (
          active &&
          workspaceIdentityRef.current === hydrationIdentity &&
          callbacks.current.workspaceScopeGeneration === hydrationGeneration
        ) {
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
    agentRevision.current = 0;
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
      manageWorkspaceFromChat,
    },
    invalidate,
    shouldReload: () => snapshotLoadFailedRef.current,
  };
}
