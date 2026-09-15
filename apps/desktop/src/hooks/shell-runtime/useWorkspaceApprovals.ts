import type { ToolApprovalGate } from "@fable/connectors";
import type {
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  PermissionMode,
} from "@fable/protocol";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveApprovalFallback } from "../../lib/approval-fallbacks";
import { prependAuditEntry } from "../../lib/helpers";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type ApprovalModificationDraft,
  type PendingApprovalConfirmation,
  type PersistedShellState,
} from "../../lib/types";
import {
  loadRuntimeActionHistory,
  loadRuntimeApprovalAudit,
  loadRuntimeApprovalRules,
  resolveRuntimeApprovalRequest,
} from "../../runtime/domains/approvals";
import { runtimeOrPreview } from "./defaults";

/** Owns visible approvals and their native decision bridge; the execution service owns the gate. */
export function useWorkspaceApprovals(options: {
  initialState: PersistedShellState;
  workspaceIdentityRef: RefObject<string | null>;
  workspaceScopeGeneration: number;
  permissionMode: PermissionMode;
  approvalGate: ToolApprovalGate | null;
  setLastAction: (message: string) => void;
}) {
  const {
    initialState,
    workspaceIdentityRef,
    workspaceScopeGeneration,
    setLastAction,
  } = options;
  const approvalGateRef = useRef(options.approvalGate);
  approvalGateRef.current = options.approvalGate;
  const permissionModeRef = useRef(options.permissionMode);
  permissionModeRef.current = options.permissionMode;
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(
    initialState.approvalAudit,
  );
  const [approvalPreviews, setApprovalPreviews] = useState<
    Record<string, { summary: string; details: string }>
  >({});
  const [backendToolApprovals, setBackendToolApprovals] = useState<
    ApprovalRequest[]
  >([]);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEvent[]>([]);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(
    initialState.dismissedApprovalIds,
  );
  const [approvalRules, setApprovalRules] = useState<ApprovalGrant[]>(
    initialState.approvalRules,
  );
  const [sessionApprovalGrants, setSessionApprovalGrants] = useState<
    ApprovalGrant[]
  >([]);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(
    null,
  );
  const [approvalModificationDraft, setApprovalModificationDraft] =
    useState<ApprovalModificationDraft>(EMPTY_APPROVAL_MODIFICATION);
  const [pendingApprovalConfirmation, setPendingApprovalConfirmation] =
    useState<PendingApprovalConfirmation | null>(null);
  const [approvalConfirmationText, setApprovalConfirmationText] = useState("");
  const connectorApprovalRequests = useRef(new Map<string, ApprovalRequest>());
  const openApprovals = useMemo(
    () =>
      backendToolApprovals.filter(
        (approval) => !dismissedApprovalIds.includes(approval.id),
      ),
    [backendToolApprovals, dismissedApprovalIds],
  );
  useEffect(() => {
    let active = true;

    void loadRuntimeApprovalAudit().then((entries) => {
      if (!active || !entries || entries.length === 0) {
        return;
      }

      setApprovalAudit(entries.slice(0, 200));
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  const refreshActionHistory = useCallback(() => {
    const identity = workspaceIdentityRef.current;
    void loadRuntimeActionHistory().then((events) => {
      if (
        identity === workspaceIdentityRef.current &&
        events &&
        Array.isArray(events)
      ) {
        setActionHistory(events.slice(0, 200));
      }
    });
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    refreshActionHistory();
  }, [refreshActionHistory]);

  useEffect(() => {
    let active = true;

    void loadRuntimeApprovalRules().then((rules) => {
      if (!active || !rules || rules.length === 0) {
        return;
      }

      setApprovalRules(rules);
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  // Full access makes the decision automatically, through the same persisted
  // single-use authorization boundary. Other modes retain the interactive queue.
  const recordBackendToolCall = (event: {
    allowAutomatic?: boolean;
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => {
    if (event.tool === "connector-action" || event.tool === "connector-call") {
      connectorApprovalRequests.current.set(event.approval.id, event.approval);
    }
    if (
      permissionModeRef.current === "full-access" &&
      event.allowAutomatic !== false
    ) {
      void resolveApprovalDecision(
        event.approval,
        "once",
        undefined,
        event.approval.confirmationPhrase,
        true,
      );
      return;
    }
    if (event.tool === "connector-action") {
      try {
        const context = JSON.parse(event.arguments) as {
          preview?: string;
          payload?: Record<string, string>;
        };
        if (typeof context.preview === "string")
          setApprovalPreviews((current) => ({
            ...current,
            [event.approval.id]: {
              summary: context.preview as string,
              details: JSON.stringify(context.payload, null, 2),
            },
          }));
      } catch {
        /* Invalid previews never replace the exact native approval. */
      }
    }
    setBackendToolApprovals((current) => {
      const existingIndex = current.findIndex(
        (approval) => approval.id === event.approval.id,
      );
      if (existingIndex < 0) return [...current, event.approval];
      return current.map((approval, index) =>
        index === existingIndex ? event.approval : approval,
      );
    });
    setLastAction(`Tool call from ${event.approval.service}: ${event.tool}`);
  };

  const clearBackendToolApprovals = (ids?: readonly string[]) => {
    if (ids) {
      for (const id of ids) connectorApprovalRequests.current.delete(id);
      setBackendToolApprovals((current) =>
        current.filter((approval) => !ids.includes(approval.id)),
      );
      setApprovalPreviews((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
      );
      return;
    }
    connectorApprovalRequests.current.clear();
    setBackendToolApprovals([]);
    setApprovalPreviews({});
  };

  const approvalNeedsConfirmation = (
    approval: ApprovalRequest,
    modification?: ApprovalModification,
  ) => {
    const mode = modification?.mode ?? approval.mode;
    return (
      mode === "full-access" ||
      approval.riskLevel === "high" ||
      approval.riskLevel === "critical"
    );
  };

  const clearApprovalInteraction = () => {
    setEditingApprovalId(null);
    setApprovalModificationDraft(EMPTY_APPROVAL_MODIFICATION);
    setPendingApprovalConfirmation(null);
    setApprovalConfirmationText("");
  };

  const resolveApprovalDecision = async (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
    confirmationText?: string,
    automatic = false,
  ) => {
    const gate = approvalGateRef.current;
    const identity = workspaceIdentityRef.current;
    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
      confirmationText,
    };

    try {
      const response = runtimeOrPreview(
        await resolveRuntimeApprovalRequest(request),
        () => resolveApprovalFallback(request),
        "Approvals require the desktop runtime.",
      );

      // A permission change, cancellation, or workspace switch while native
      // persistence is pending must never release an obsolete tool call.
      if (
        identity !== workspaceIdentityRef.current ||
        gate !== approvalGateRef.current
      ) {
        gate?.resolveDeny(approval.id);
        return;
      }
      if (
        automatic &&
        (permissionModeRef.current !== "full-access" ||
          !gate?.hasPending(approval.id))
      ) {
        gate?.resolveDeny(approval.id);
        return;
      }

      setApprovalAudit((current) =>
        prependAuditEntry(current, response.auditEntry),
      );
      if (response.dismissed) {
        setDismissedApprovalIds((current) =>
          current.includes(approval.id) ? current : [...current, approval.id],
        );
      }
      if (response.grant?.scope === "session") {
        setSessionApprovalGrants((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id),
        ]);
      }
      if (response.grant?.scope === "rule") {
        setApprovalRules((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id),
        ]);
      }

      // Grant -> execute bridge: drive the matching pending tool call on the
      // shared approval gate so the agent-loop executor proceeds (grant) or
      // refuses (deny). Only approvals the shell registered as pending tool
      // calls are dispatched — a regular connector approval with no pending
      // entry is a no-op here. A deny never executes the tool.
      if (gate?.hasPending(approval.id)) {
        if (decision === "deny") {
          gate.resolveDeny(approval.id);
        } else if (
          decision === "once" ||
          decision === "session" ||
          decision === "rule" ||
          decision === "modify"
        ) {
          gate.resolveGrant(approval.id);
        }
      }

      setBackendToolApprovals((current) =>
        current.filter((candidate) => candidate.id !== approval.id),
      );
      connectorApprovalRequests.current.delete(approval.id);

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`,
      );
    } catch (error) {
      if (automatic) gate?.resolveDeny(approval.id);
      if (
        identity !== workspaceIdentityRef.current ||
        gate !== approvalGateRef.current
      )
        return;
      setLastAction(
        error instanceof Error
          ? error.message
          : "Mivlet could not resolve that approval.",
      );
    }
  };

  const requestApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
  ) => {
    // The visible Approve button confirms this exact queued connector operation.
    // Preserve the native single-use receipt without a second typing ceremony.
    const queued = connectorApprovalRequests.current.get(approval.id);
    if (
      decision === "once" &&
      !modification &&
      queued === approval &&
      approvalGateRef.current?.hasPending(approval.id)
    ) {
      void resolveApprovalDecision(
        approval,
        decision,
        undefined,
        approval.confirmationPhrase,
      );
      return;
    }
    if (
      decision !== "deny" &&
      approvalNeedsConfirmation(approval, modification)
    ) {
      setPendingApprovalConfirmation({
        request: approval,
        decision,
        modification,
      });
      setApprovalConfirmationText("");
      return;
    }

    void resolveApprovalDecision(approval, decision, modification);
  };

  const startApprovalModify = (approval: ApprovalRequest) => {
    setPendingApprovalConfirmation(null);
    setApprovalConfirmationText("");
    setEditingApprovalId(approval.id);
    setApprovalModificationDraft({
      mode: approval.mode,
      dataUsed: approval.dataUsed.join(", "),
      consequence: approval.consequence,
    });
  };

  const saveApprovalModify = (approval: ApprovalRequest) => {
    const dataUsed = approvalModificationDraft.dataUsed
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const consequence = approvalModificationDraft.consequence.trim();

    if (dataUsed.length === 0 || !consequence) {
      setLastAction("Modified approvals need allowed data and a consequence.");
      return;
    }

    requestApprovalDecision(approval, "modify", {
      mode: approvalModificationDraft.mode,
      dataUsed,
      consequence,
    });
  };

  const confirmApprovalDecision = () => {
    if (!pendingApprovalConfirmation) {
      return;
    }

    void resolveApprovalDecision(
      pendingApprovalConfirmation.request,
      pendingApprovalConfirmation.decision,
      pendingApprovalConfirmation.modification,
      approvalConfirmationText,
    );
  };

  const reset = () => {
    setApprovalAudit([]);
    setActionHistory([]);
    setApprovalRules([]);
    setDismissedApprovalIds([]);
    setSessionApprovalGrants([]);
    clearBackendToolApprovals();
    clearApprovalInteraction();
  };
  const hydrate = (recovered: PersistedShellState) => {
    setApprovalAudit(recovered.approvalAudit);
    setDismissedApprovalIds(recovered.dismissedApprovalIds);
    setApprovalRules(recovered.approvalRules);
  };
  return {
    runtime: {
      openApprovals,
      approvalAudit,
      actionHistory,
      refreshActionHistory,
      sessionApprovalGrants,
      approvalRules,
      editingApprovalId,
      approvalModificationDraft,
      pendingApprovalConfirmation,
      approvalConfirmationText,
      setApprovalModificationDraft,
      setApprovalConfirmationText,
      requestApprovalDecision,
      startApprovalModify,
      saveApprovalModify,
      confirmApprovalDecision,
      clearApprovalInteraction,
      recordBackendToolCall,
      approvalPreviews,
      clearBackendToolApprovals,
    },
    dismissedApprovalIds,
    reset,
    hydrate,
  };
}
