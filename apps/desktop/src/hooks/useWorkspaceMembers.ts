import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountWorkspaceInvitationCreateOutcome,
  AccountWorkspaceInvitationCreateRequest,
  AccountWorkspaceMemberChangeOutcome,
  AccountWorkspaceMemberChangeRequest,
  AccountWorkspaceMemberList
} from "@fable/protocol";
import {
  changeRuntimeWorkspaceMember,
  createRuntimeWorkspaceInvitation,
  loadRuntimeWorkspaceMembers
} from "../runtime";

export type WorkspaceMembersState = "loading" | "ready" | "unavailable" | "error";

interface WorkspaceMembersSnapshot {
  contextKey: string;
  state: WorkspaceMembersState;
  roster: AccountWorkspaceMemberList | null;
}

const inFlightLoads = new Map<string, Promise<AccountWorkspaceMemberList | null>>();

function loadMembersOnce(requestKey: string, fableWorkspaceId: string) {
  const existing = inFlightLoads.get(requestKey);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => loadRuntimeWorkspaceMembers(fableWorkspaceId))
    .finally(() => {
      if (inFlightLoads.get(requestKey) === request) inFlightLoads.delete(requestKey);
    });
  inFlightLoads.set(requestKey, request);
  return request;
}

export function useWorkspaceMembers({
  accountContextKey,
  fableWorkspaceId
}: {
  accountContextKey: string;
  fableWorkspaceId: string | null;
}) {
  const contextKey = useMemo(
    () => JSON.stringify([accountContextKey, fableWorkspaceId]),
    [accountContextKey, fableWorkspaceId]
  );
  const [snapshot, setSnapshot] = useState<WorkspaceMembersSnapshot>({
    contextKey,
    state: "loading",
    roster: null
  });
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestRef = useRef(0);
  const currentContextRef = useRef(contextKey);
  const actionTokenRef = useRef<symbol | null>(null);
  const invitationTokenRef = useRef<symbol | null>(null);
  const actionContextRef = useRef(contextKey);
  const mountedRef = useRef(true);
  const [pendingAction, setPendingAction] = useState<{
    contextKey: string;
    memberActionRef: string;
    action: AccountWorkspaceMemberChangeRequest["action"];
  } | null>(null);
  const [invitationPending, setInvitationPending] = useState(false);

  currentContextRef.current = contextKey;
  if (actionContextRef.current !== contextKey) {
    actionContextRef.current = contextKey;
    actionTokenRef.current = null;
    invitationTokenRef.current = null;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionTokenRef.current = null;
      invitationTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    const requestKey = `${contextKey}:${reloadVersion}`;
    const request = ++requestRef.current;
    let active = true;
    setSnapshot({ contextKey, state: "loading", roster: null });

    if (!fableWorkspaceId) {
      setSnapshot({ contextKey, state: "unavailable", roster: null });
      return () => {
        active = false;
      };
    }

    void loadMembersOnce(requestKey, fableWorkspaceId)
      .then((roster: AccountWorkspaceMemberList | null) => {
        if (!active || requestRef.current !== request) return;
        setSnapshot({
          contextKey,
          state: roster === null ? "unavailable" : "ready",
          roster
        });
      })
      .catch(() => {
        if (!active || requestRef.current !== request) return;
        setSnapshot({ contextKey, state: "error", roster: null });
      });

    return () => {
      active = false;
    };
  }, [contextKey, fableWorkspaceId, reloadVersion]);

  const reload = useCallback(() => {
    setReloadVersion((current) => current + 1);
  }, []);

  const changeMember = useCallback(async (
    change: AccountWorkspaceMemberChangeRequest
  ): Promise<AccountWorkspaceMemberChangeOutcome | null> => {
    if (actionTokenRef.current) return null;
    const token = Symbol(change.memberActionRef);
    const startedContext = currentContextRef.current;
    actionTokenRef.current = token;
    setPendingAction({
      contextKey: startedContext,
      memberActionRef: change.memberActionRef,
      action: change.action
    });
    const isCurrent = () => mountedRef.current
      && actionTokenRef.current === token
      && currentContextRef.current === startedContext;

    try {
      const outcome = await changeRuntimeWorkspaceMember(change);
      if (!isCurrent()) return null;
      if (outcome === null) {
        setSnapshot({ contextKey: startedContext, state: "unavailable", roster: null });
        return null;
      }
      if (outcome.status === "accepted" || outcome.status === "conflict") {
        setReloadVersion((current) => current + 1);
      }
      return outcome;
    } finally {
      if (actionTokenRef.current === token) {
        actionTokenRef.current = null;
        if (mountedRef.current && currentContextRef.current === startedContext) {
          setPendingAction(null);
        }
      }
    }
  }, []);

  const createInvitation = useCallback(async (
    request: AccountWorkspaceInvitationCreateRequest
  ): Promise<AccountWorkspaceInvitationCreateOutcome | null> => {
    if (invitationTokenRef.current) return null;
    const token = Symbol(request.invitationActionRef);
    const startedContext = currentContextRef.current;
    invitationTokenRef.current = token;
    setInvitationPending(true);
    const isCurrent = () => mountedRef.current
      && invitationTokenRef.current === token
      && currentContextRef.current === startedContext;
    try {
      const outcome = await createRuntimeWorkspaceInvitation(request);
      if (!isCurrent()) return null;
      if (outcome === null) {
        setSnapshot({ contextKey: startedContext, state: "unavailable", roster: null });
        return null;
      }
      if (outcome.status === "accepted" || outcome.status === "conflict") {
        setReloadVersion((current) => current + 1);
      }
      return outcome;
    } finally {
      if (invitationTokenRef.current === token) {
        invitationTokenRef.current = null;
        if (mountedRef.current && currentContextRef.current === startedContext) {
          setInvitationPending(false);
        }
      }
    }
  }, []);

  // Effects run after render. Never expose the previous account or workspace
  // while React is switching to the new context.
  if (snapshot.contextKey !== contextKey) {
    return { state: "loading" as const, roster: null, reload, changeMember, createInvitation, pendingAction: null, invitationPending: false };
  }

  return {
    state: snapshot.state,
    roster: snapshot.roster,
    reload,
    changeMember,
    createInvitation,
    invitationPending,
    pendingAction: pendingAction?.contextKey === contextKey ? pendingAction : null
  };
}
