import type { ToolApprovalGate } from "@mivlet/connectors";
import { redactSecretsFromObject } from "@mivlet/connectors/agent-runtime";
import type {
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  ApprovalResolutionRequest,
  PermissionMode,
} from "@mivlet/protocol";
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
  const approvalResolutions = useRef(new Map<string, Promise<void>>());
  const cancelledApprovalIds = useRef(new Set<string>());
  const [pendingNativeApprovalIds, setPendingNativeApprovalIds] = useState<
    string[]
  >([]);
  const mcpAppResolvers = useRef(new Map<string, (resolution: ApprovalResolutionRequest | null) => void>());
  const mcpAppTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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

  // Full Access still records the same exact one-time permit. High-risk minting
  // requires a native OS confirm; WebView never copies confirmationPhrase.
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
      for (const id of ids) {
        if (approvalResolutions.current.has(id))
          cancelledApprovalIds.current.add(id);
        // Stop and scope teardown must release the executor immediately. The
        // native promise may still settle later, but its result is fenced by
        // cancelledApprovalIds and can never grant this tool call.
        if (approvalGateRef.current?.hasPending(id))
          approvalGateRef.current.resolveDeny(id);
        connectorApprovalRequests.current.delete(id);
        const timer = mcpAppTimers.current.get(id);
        if (timer) clearTimeout(timer);
        mcpAppTimers.current.delete(id);
        mcpAppResolvers.current.get(id)?.(null);
        mcpAppResolvers.current.delete(id);
      }
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
    for (const id of approvalResolutions.current.keys()) {
      cancelledApprovalIds.current.add(id);
      if (approvalGateRef.current?.hasPending(id))
        approvalGateRef.current.resolveDeny(id);
    }
    for (const resolve of mcpAppResolvers.current.values()) resolve(null);
    for (const timer of mcpAppTimers.current.values()) clearTimeout(timer);
    mcpAppResolvers.current.clear();
    mcpAppTimers.current.clear();
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

  const resolveApprovalDecisionInternal = async (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
    automatic = false,
  ) => {
    const gate = approvalGateRef.current;
    const identity = workspaceIdentityRef.current;
    // Never copy confirmationPhrase into confirmationText. Native minting
    // treats that equality as WebView echo and refuses to persist a permit.
    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
    };

    try {
      const response = runtimeOrPreview(
        await resolveRuntimeApprovalRequest(request),
        () => resolveApprovalFallback(request),
        "Approvals require the desktop runtime.",
      );

      if (cancelledApprovalIds.current.has(approval.id)) {
        if (gate?.hasPending(approval.id)) gate.resolveDeny(approval.id);
        return;
      }

      // A permission change, cancellation, or workspace switch while native
      // persistence is pending must never release an obsolete tool call.
      if (
        identity !== workspaceIdentityRef.current ||
        gate !== approvalGateRef.current
      ) {
        if (gate?.hasPending(approval.id)) gate.resolveDeny(approval.id);
        return;
      }
      if (
        automatic &&
        (permissionModeRef.current !== "full-access" ||
          !gate?.hasPending(approval.id))
      ) {
        if (gate?.hasPending(approval.id)) gate.resolveDeny(approval.id);
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

      const mcpResolver = mcpAppResolvers.current.get(approval.id);
      if (mcpResolver) {
        mcpAppResolvers.current.delete(approval.id);
        const timer = mcpAppTimers.current.get(approval.id);
        if (timer) clearTimeout(timer);
        mcpAppTimers.current.delete(approval.id);
        mcpResolver(decision === "deny" ? null : request);
      }

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`,
      );
    } catch (error) {
      if (cancelledApprovalIds.current.has(approval.id)) {
        if (gate?.hasPending(approval.id)) gate.resolveDeny(approval.id);
        return;
      }
      const mcpResolver = mcpAppResolvers.current.get(approval.id);
      if (mcpResolver) {
        mcpAppResolvers.current.delete(approval.id);
        const timer = mcpAppTimers.current.get(approval.id);
        if (timer) clearTimeout(timer);
        mcpAppTimers.current.delete(approval.id);
        mcpResolver(null);
      }
      if (automatic && gate?.hasPending(approval.id))
        gate.resolveDeny(approval.id);
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

  const resolveApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
    automatic = false,
  ): Promise<void> => {
    const existing = approvalResolutions.current.get(approval.id);
    if (existing) {
      if (decision === "deny") {
        cancelledApprovalIds.current.add(approval.id);
        if (approvalGateRef.current?.hasPending(approval.id))
          approvalGateRef.current.resolveDeny(approval.id);
        clearBackendToolApprovals([approval.id]);
        clearApprovalInteraction();
        setLastAction("Denied while native confirmation was pending.");
      } else {
        setLastAction("Waiting for native confirmation…");
      }
      return existing;
    }

    const resolution = (async () => {
      setPendingNativeApprovalIds((current) =>
        current.includes(approval.id) ? current : [...current, approval.id],
      );
      try {
        await resolveApprovalDecisionInternal(
          approval,
          decision,
          modification,
          automatic,
        );
      } finally {
        approvalResolutions.current.delete(approval.id);
        cancelledApprovalIds.current.delete(approval.id);
        setPendingNativeApprovalIds((current) =>
          current.filter((id) => id !== approval.id),
        );
      }
    })();
    approvalResolutions.current.set(approval.id, resolution);
    return resolution;
  };

  const requestApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
  ) => {
    // The visible Approve button confirms this exact queued connector operation
    // in the panel. Native minting still requires the OS dialog; WebView must
    // not copy the confirmation phrase into confirmationText.
    const queued = connectorApprovalRequests.current.get(approval.id);
    if (
      decision === "once" &&
      !modification &&
      queued === approval &&
      approvalGateRef.current?.hasPending(approval.id)
    ) {
      void resolveApprovalDecision(approval, decision);
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

  const requestMcpAppApproval = (preview: {
    request: ApprovalRequest;
    toolName: string;
    arguments: Record<string, unknown>;
    owner: { workspaceId: string; conversationId: string; resultId: string; generation: number };
  }) => {
    // The pane fence is intentionally repeated here at the shared approval
    // boundary. The account hook stores workspace, account owner and member in
    // this identity; checking the workspace component prevents a stale guest
    // from enqueueing a request during a scope switch/unmount race.
    const identity = workspaceIdentityRef.current;
    let activeWorkspaceId: string | undefined;
    if (identity) {
      try {
        const decoded: unknown = JSON.parse(identity);
        if (Array.isArray(decoded) && typeof decoded[0] === "string")
          activeWorkspaceId = decoded[0];
      } catch {
        activeWorkspaceId = undefined;
      }
    }
    // The browser preview has no account identity ref during its initial
    // seeded render; the conversation hook still enforces its exact
    // workspace:conversation:generation fence there. Once native account
    // scope is established, require the shared boundary to agree too.
    if (identity && (!activeWorkspaceId || activeWorkspaceId !== preview.owner.workspaceId))
      return Promise.resolve(null);
    return new Promise<ApprovalResolutionRequest | null>((resolve) => {
    // MCP permits bind the exact native proposal. Changing its display copy is
    // not a new proposal; the app must request a fresh action to change inputs.
    const approval = { ...preview.request, decisions: preview.request.decisions.filter((decision) => decision !== "modify") };
    mcpAppResolvers.current.set(approval.id, resolve);
    mcpAppTimers.current.set(approval.id, setTimeout(() => {
      if (mcpAppResolvers.current.get(approval.id) !== resolve) return;
      mcpAppResolvers.current.delete(approval.id);
      mcpAppTimers.current.delete(approval.id);
      connectorApprovalRequests.current.delete(approval.id);
      setBackendToolApprovals((current) => current.filter((candidate) => candidate.id !== approval.id));
      resolve(null);
    }, 120_000));
    connectorApprovalRequests.current.set(approval.id, approval);
    setApprovalPreviews((current) => ({
      ...current,
      [approval.id]: {
        summary: `Interactive MCP App request: ${preview.toolName}\nTo change parameters, deny this request and submit a new action from the app.`,
        details: JSON.stringify({ owner: preview.owner, arguments: redactSecretsFromObject(preview.arguments) }, null, 2).slice(0, 12_000),
      },
    }));
    setBackendToolApprovals((current) => current.some((candidate) => candidate.id === approval.id) ? current : [...current, approval]);
    setLastAction(`MCP App requests approval for ${preview.toolName}`);
    });
  };

  const startApprovalModify = (approval: ApprovalRequest) => {
    if (mcpAppResolvers.current.has(approval.id)) {
      setLastAction("Deny this request and submit a new action from the app to change its parameters.");
      return;
    }
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
      pendingNativeApprovalIds: new Set(pendingNativeApprovalIds),
      setApprovalModificationDraft,
      setApprovalConfirmationText,
      requestApprovalDecision,
      requestMcpAppApproval,
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
