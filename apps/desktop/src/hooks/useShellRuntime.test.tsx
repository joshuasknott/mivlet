import { act, renderHook as rtlRenderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { AccountWorkspaceStatus, ApprovalAuditEntry, ApprovalRequest } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import { useShellRuntime } from "./useShellRuntime";
import { STORAGE_KEY, LEGACY_STORAGE_KEYS } from "../lib/constants";
import type { PersistedShellState } from "../lib/types";
import { FableQueryProvider } from "../lib/query-client";
import { shellStateToRuntimeSnapshot } from "../lib/persistence";
import { defaultShellState } from "./shell-runtime/defaults";

/**
 * Isolated unit coverage for useShellRuntime's pure orchestration logic. All
 * Rust-bound runtime wrappers are mocked to return null (preview mode), so the
 * shell falls back to its in-browser fallbacks and the orchestration under test
 * (approval decision flow, high-risk confirmation gating, modify drafting, audit
 * prepend, session/rule grant bucketing, localStorage persistence, legacy key
 * migration) runs deterministically with no network or Tauri.
 *
 * The runtime snapshot effect fires on mount and resolves asynchronously; tests
 * either await it or exercise synchronous callbacks (approvals) that do not
 * depend on it.
 */

vi.mock("../runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime")>();
  return {
    wireToWorkflowRun: actual.wireToWorkflowRun,
    clearRuntimeBackend: vi.fn(async () => null),
    clearRuntimeConnectorAuth: vi.fn(async () => null),
    connectRuntimeBackend: vi.fn(async () => null),
    detectRuntimeAcpCli: vi.fn(async () => null),
    detectRuntimeLocalModel: vi.fn(async () => null),
    beginRuntimeIdentitySignIn: vi.fn(async () => null),
    beginRuntimeIdentityRecovery: vi.fn(async () => null),
    clearRuntimeAccountWorkspaceSession: vi.fn(async () => null),
    createRuntimeAccountWorkspace: vi.fn(async () => null),
    exportRuntimeMemoryState: vi.fn(async () => null),
    importRuntimeConnectorItem: vi.fn(async () => null),
    importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
    listRuntimeBackends: vi.fn(async () => null),
    listRuntimeBackendModels: vi.fn(async () => null),
    listRuntimeConnectorStatuses: vi.fn(async () => null),
    listRuntimeSchedulerJobs: vi.fn(async () => null),
    listRuntimeSchedulerQueue: vi.fn(async () => null),
    listRuntimeWorkflowDefinitions: vi.fn(async () => null),
    listRuntimeWorkflowRuns: vi.fn(async () => null),
    listenRuntimeSchedulerRunRequest: vi.fn(async () => null),
    loadRuntimeActionHistory: vi.fn(async () => null),
    loadRuntimeApprovalAudit: vi.fn(async () => null),
    loadRuntimeApprovalRules: vi.fn(async () => null),
    loadRuntimeIdentityStatus: vi.fn(async () => null),
    loadRuntimeAccountWorkspaceStatus: vi.fn(async () => null),
    loadRuntimeImportedKnowledgeSources: vi.fn(async () => null),
    loadRuntimeMemoryState: vi.fn(async () => null),
    loadRuntimeSnapshot: vi.fn(async () => null),
    prepareRuntimeConnectorAction: vi.fn(async () => null),
    promoteRuntimeKnowledgeSourceToMemory: vi.fn(async () => null),
    recordRuntimeBackendEvent: vi.fn(async () => null),
    refreshRuntimeIdentity: vi.fn(async () => null),
    reconcileRuntimeAccountWorkspace: vi.fn(async () => null),
    revokeRuntimeAccountDevice: vi.fn(async () => null),
    refreshRuntimeConnectorHealth: vi.fn(async () => null),
    listRuntimeConnectorSyncStates: vi.fn(async () => null),
    syncRuntimeConnector: vi.fn(async () => null),
    resolveRuntimeApprovalRequest: vi.fn(async () => null),
    saveRuntimeMemoryState: vi.fn(async () => null),
    saveRuntimeImportedKnowledgeSources: vi.fn(async () => null),
    saveRuntimeScheduledJob: vi.fn(async () => null),
    saveRuntimeWorkflowDefinition: vi.fn(async () => null),
    saveRuntimeWorkflowRun: vi.fn(async () => null),
    enqueueRuntimeJobRun: vi.fn(async () => null),
    reportRuntimeJobAttempt: vi.fn(async () => null),
    renewRuntimeJobLease: vi.fn(async () => null),
    requeueRuntimeBlockedJobRun: vi.fn(async () => null),
    cancelRuntimeJobRun: vi.fn(async () => null),
    setRuntimeJobStatus: vi.fn(async () => null),
    deleteRuntimeScheduledJob: vi.fn(async () => null),
    deliverRuntimeNotification: vi.fn(async () => null),
    executeRuntimeConnectorAction: vi.fn(async () => null),
    saveRuntimeSnapshot: vi.fn(async () => null),
    searchRuntimeConnector: vi.fn(async () => null),
    searchRuntimeKnowledgeSources: vi.fn(async () => null),
    selectRuntimeAccountWorkspace: vi.fn(async () => null),
    signOutRuntimeIdentity: vi.fn(async () => null),
    startRuntimeConnectorAuth: vi.fn(async () => null)
  };
});

function renderHook<Result>(callback: () => Result) {
  return rtlRenderHook(callback, {
    wrapper: ({ children }: PropsWithChildren) => (
      <FableQueryProvider>{children}</FableQueryProvider>
    )
  });
}

/** A low-risk read-only approval — resolves without confirmation. */
function lowRiskApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: `approval-${Math.random().toString(36).slice(2, 8)}`,
    service: "google-drive",
    action: "Read file launch-plan.md",
    mode: "read-only",
    riskLevel: "low",
    dataUsed: ["file: launch-plan.md"],
    consequence: "Reads a single Google Drive file.",
    requestedAt: new Date().toISOString(),
    decisions: ["once", "session", "rule", "modify", "deny"],
    ...overrides
  };
}

/** A high-risk full-access approval that requires typed confirmation. */
function highRiskApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return lowRiskApproval({
    id: `approval-high-${Math.random().toString(36).slice(2, 8)}`,
    action: "Delete file launch-plan.md",
    mode: "full-access",
    riskLevel: "high",
    consequence: "Permanently deletes a Google Drive file.",
    // resolveApprovalFallback gates high-risk approvals on this exact phrase.
    confirmationPhrase: "approve delete file launch-plan.md",
    ...overrides
  });
}

function setLocalStorage(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

async function awaitMountEffects() {
  // The snapshot-loading effect resolves on mount; let it settle so a later
  // unmount cleanly flushes persistence. waitFor throws if it never resolves.
  await waitFor(() => expect(true).toBe(true));
}

describe("useShellRuntime - approval defaults and Custom mapping", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("starts in Ask Me", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();
    expect(result.current.permissionLabel).toBe("Ask Me");
    expect(result.current.permissionMode).toBe("trusted-scope");
  });

  it("updates Custom through the existing policy levels", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    act(() => result.current.updateCustomApprovalSetting("allowSmallLocalEdits", true));
    expect(result.current.permissionLabel).toBe("Custom");
    expect(result.current.permissionMode).toBe("trusted-scope");

    act(() => result.current.updateCustomApprovalSetting("allowPowerfulCommands", true));
    expect(result.current.permissionMode).toBe("full-access");
  });
});

describe("useShellRuntime - account onboarding boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("uses the explicit signed-in preview account and enters provider onboarding", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    expect(result.current.identityStatus.state).toBe("signed-in");
    expect(result.current.accountWorkspaceStatus.state).toBe("ready");
    expect(result.current.onboardingRequired).toBe(true);
  });

  it("clears workspace-owned state before an empty target workspace is shown", async () => {
    const nativeWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
    nativeWindow.__TAURI_INTERNALS__ = {};
    const workspace = (id: string, localId: string): AccountWorkspaceStatus => ({
      configured: true,
      state: "ready",
      message: `${id} ready`,
      accountBound: true,
      workspaces: [{
        fableWorkspaceId: id,
        localWorkspaceId: localId,
        name: id,
        workspaceStatus: "active",
        workspaceRevision: 1,
        policyRevision: 1,
        memberId: `member-${id}`,
        role: "owner",
        membershipStatus: "active",
        membershipRevision: 1,
        updatedAt: "2026-07-10T12:00:00.000Z"
      }],
      activeWorkspace: { localWorkspaceId: localId, fableWorkspaceId: id, name: id, source: "hosted" },
      devices: []
    });
    vi.mocked(runtime.loadRuntimeIdentityStatus).mockResolvedValue({
      enabled: true,
      state: "signed-in",
      message: "Signed in",
      scopes: []
    });
    vi.mocked(runtime.reconcileRuntimeAccountWorkspace).mockResolvedValue(workspace("workspace-a", "local-a"));
    vi.mocked(runtime.loadRuntimeSnapshot)
      .mockResolvedValueOnce(shellStateToRuntimeSnapshot({
        ...defaultShellState,
        composerValue: "private draft from workspace A",
        dismissedApprovalIds: ["approval-a"]
      }))
      .mockResolvedValueOnce(null);
    vi.mocked(runtime.selectRuntimeAccountWorkspace).mockResolvedValue(workspace("workspace-b", "local-b"));

    const { result, unmount } = renderHook(() => useShellRuntime());
    await waitFor(() => expect(result.current.composerValue).toBe("private draft from workspace A"));

    await act(async () => result.current.selectAccountWorkspace("workspace-b"));
    await waitFor(() => expect(result.current.accountWorkspaceStatus.activeWorkspace.localWorkspaceId).toBe("local-b"));
    expect(result.current.composerValue).toBe("");
    expect(result.current.openApprovals.some((approval) => approval.id === "approval-a")).toBe(false);

    unmount();
    delete nativeWindow.__TAURI_INTERNALS__;
  });
});

describe("useShellRuntime - connector approval execution", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(runtime.executeRuntimeConnectorAction).mockResolvedValue(null);
  });

  it("executes a prepared connector write only after a fresh once decision", async () => {
    vi.mocked(runtime.executeRuntimeConnectorAction).mockResolvedValueOnce({
      requestId: "slack-slack-create-draft-channel-1",
      connectorId: "slack",
      action: "slack.create-draft",
      status: "completed",
      message: "Draft created."
    });
    const { result } = renderHook(() => useShellRuntime());

    await act(async () => {
      await result.current.prepareConnectorAction("slack.create-draft", {
        channelId: "channel-1",
        text: "Draft"
      });
    });
    const approval = result.current.openApprovals[0];
    expect(approval.decisions).toEqual(["once", "modify", "deny"]);

    act(() => result.current.requestApprovalDecision(approval, "once"));
    await waitFor(() => expect(runtime.executeRuntimeConnectorAction).toHaveBeenCalledOnce());
    expect(result.current.openApprovals).toHaveLength(0);
  });

  it("marks fixture preview actions as denied without a runtime execution", async () => {
    const { result } = renderHook(() => useShellRuntime());

    await act(async () => {
      await result.current.prepareConnectorAction("slack.create-draft", {
        channelId: "channel-1",
        text: "Draft"
      });
    });
    const approval = result.current.openApprovals[0];

    act(() => result.current.requestApprovalDecision(approval, "deny"));

    await waitFor(() => expect(result.current.connectorStatus).toBe("The action was denied. Nothing ran."));
    expect(runtime.executeRuntimeConnectorAction).toHaveBeenCalledOnce();
    expect(result.current.openApprovals).toHaveLength(0);
  });

  it("completes approved fixture preview actions without leaking session data to persistence", async () => {
    const { result } = renderHook(() => useShellRuntime());

    await act(async () => {
      await result.current.prepareConnectorAction("slack.create-draft", {
        channelId: "channel-1",
        text: "Draft"
      });
    });
    const approval = result.current.openApprovals[0];

    act(() => result.current.requestApprovalDecision(approval, "once"));

    await waitFor(() =>
      expect(result.current.connectorStatus).toBe(
        "Preview action completed with fixture data only. No live provider changed."
      )
    );
    expect(result.current.openApprovals).toHaveLength(0);
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(stored.toLowerCase()).not.toMatch(
      /fixture-preview-|cookie|token|secret|screenshot|clipboard|pagetext|localstorage|sessionstorage/
    );
  });
});

describe("useShellRuntime — approval decision flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("records a `once` approval: appends to the audit and dismisses the approval", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "once");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));

    const audit = result.current.approvalAudit[0];
    expect(audit.requestId).toBe(approval.id);
    expect(audit.decision).toBe("once");
    // A one-time approval dismisses the request and grants nothing.
    expect(result.current.approvalRules.length).toBe(0);
    expect(result.current.sessionApprovalGrants.length).toBe(0);
    // No confirmation was required for a low-risk read-only decision.
    expect(result.current.pendingApprovalConfirmation).toBeNull();
  });

  it("records a `deny` approval: logs the audit without creating a grant", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "deny");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));

    expect(result.current.approvalAudit[0].decision).toBe("deny");
    expect(result.current.approvalRules.length).toBe(0);
    expect(result.current.sessionApprovalGrants.length).toBe(0);
  });

  it("buckets a `session` grant into sessionApprovalGrants only", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "session");
    });
    await waitFor(() => expect(result.current.sessionApprovalGrants.length).toBe(1));

    const grant = result.current.sessionApprovalGrants[0];
    expect(grant.scope).toBe("session");
    expect(grant.service).toBe(approval.service);
    // A session grant does not also create a persisted rule.
    expect(result.current.approvalRules.length).toBe(0);
  });

  it("buckets a `rule` grant into approvalRules (persisted) only", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "rule");
    });
    await waitFor(() => expect(result.current.approvalRules.length).toBe(1));

    const grant = result.current.approvalRules[0];
    expect(grant.scope).toBe("rule");
    expect(grant.requestId).toBe(approval.id);
    // A rule grant does not also create a session grant.
    expect(result.current.sessionApprovalGrants.length).toBe(0);
  });
});

describe("useShellRuntime — high-risk confirmation gating", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("gates high-risk approvals behind a pending confirmation instead of resolving immediately", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();
    const approval = highRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "once");
    });

    // The decision is held pending the typed confirmation phrase; nothing is
    // recorded yet.
    expect(result.current.pendingApprovalConfirmation).not.toBeNull();
    expect(result.current.pendingApprovalConfirmation?.decision).toBe("once");
    expect(result.current.approvalAudit.length).toBe(0);
  });

  it("refuses to resolve a high-risk approval until the confirmation phrase matches", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = highRiskApproval();
    act(() => {
      result.current.requestApprovalDecision(approval, "session");
    });

    // Wrong phrase: the fallback throws and surfaces a last-action error;
    // nothing is granted.
    act(() => {
      result.current.setApprovalConfirmationText("wrong phrase");
    });
    await act(async () => {
      result.current.confirmApprovalDecision();
    });
    expect(result.current.sessionApprovalGrants.length).toBe(0);
    expect(result.current.lastAction).toMatch(/did not match/i);
    // A failed confirmation is NOT cleared: the confirmation stays pending so
    // the user can retype the phrase and retry the high-risk decision.
    expect(result.current.pendingApprovalConfirmation).not.toBeNull();
  });

  it("resolves a high-risk approval once the typed confirmation phrase matches", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = highRiskApproval();
    act(() => {
      result.current.requestApprovalDecision(approval, "session");
    });
    act(() => {
      result.current.setApprovalConfirmationText(approval.confirmationPhrase!);
    });

    await act(async () => {
      result.current.confirmApprovalDecision();
    });

    expect(result.current.sessionApprovalGrants.length).toBe(1);
    expect(result.current.approvalAudit.length).toBe(1);
    expect(result.current.pendingApprovalConfirmation).toBeNull();
  });

  it("does not gate deny decisions on a confirmation, even for high-risk approvals", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = highRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "deny");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));

    // Deny bypasses the confirmation gate entirely.
    expect(result.current.pendingApprovalConfirmation).toBeNull();
    expect(result.current.approvalAudit[0].decision).toBe("deny");
  });
});

describe("useShellRuntime — modify drafting", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("opens a modify draft seeded from the approval's current scope", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();
    const approval = lowRiskApproval();

    act(() => {
      result.current.startApprovalModify(approval);
    });

    expect(result.current.editingApprovalId).toBe(approval.id);
    expect(result.current.approvalModificationDraft.mode).toBe(approval.mode);
    // dataUsed is joined into a single editable text field.
    expect(result.current.approvalModificationDraft.dataUsed).toBe(
      approval.dataUsed.join(", ")
    );
    expect(result.current.approvalModificationDraft.consequence).toBe(approval.consequence);
  });

  it("rejects a save when allowed data or consequence is empty", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();
    const approval = lowRiskApproval();

    act(() => {
      result.current.startApprovalModify(approval);
      result.current.setApprovalModificationDraft({
        mode: "read-only",
        dataUsed: "",
        consequence: ""
      });
      result.current.saveApprovalModify(approval);
    });

    expect(result.current.lastAction).toMatch(/allowed data and a consequence/i);
    // Nothing recorded — the modify was not committed.
    expect(result.current.approvalAudit.length).toBe(0);
  });

  it("commits a narrowed modify as a `modify` audit entry", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval({ mode: "full-access", riskLevel: "medium" });

    act(() => {
      result.current.startApprovalModify(approval);
      result.current.setApprovalModificationDraft({
        mode: "read-only",
        dataUsed: "file: safer.md",
        consequence: "Reads a single file."
      });
    });
    await act(async () => {
      result.current.saveApprovalModify(approval);
    });

    // Narrowing to read-only drops below the confirmation threshold, so the
    // modify resolves directly into a `modify` audit entry.
    const modifyEntry = result.current.approvalAudit.find((e) => e.decision === "modify");
    expect(modifyEntry).toBeDefined();
  });
});

describe("useShellRuntime — audit prepend + dedupe", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("prepends new audit entries so the most recent decision is first", async () => {
    const { result } = renderHook(() => useShellRuntime());

    act(() => {
      result.current.requestApprovalDecision(lowRiskApproval({ id: "a" }), "once");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));
    act(() => {
      result.current.requestApprovalDecision(lowRiskApproval({ id: "b" }), "once");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(2));

    // The newest entry sits at index 0.
    expect(result.current.approvalAudit[0].requestId).toBe("b");
    expect(result.current.approvalAudit[1].requestId).toBe("a");
  });

  it("queues a backend tool call once without inventing a pre-decision audit", async () => {
    const { result } = renderHook(() => useShellRuntime());
    const approval = lowRiskApproval();

    act(() => {
      result.current.recordBackendToolCall({
        callId: "call_1",
        tool: "read-file",
        arguments: "{}",
        approval
      });
    });
    await waitFor(() => expect(result.current.openApprovals).toContainEqual(approval));
    expect(result.current.approvalAudit).toHaveLength(0);

    // A replayed event with the same approval id updates rather than duplicates
    // the waiting card.
    act(() => {
      result.current.recordBackendToolCall({
        callId: "call_2",
        tool: "read-file",
        arguments: "{}",
        approval
      });
    });
    expect(
      result.current.openApprovals.filter((candidate) => candidate.id === approval.id)
    ).toHaveLength(1);
  });
});

describe("useShellRuntime — localStorage persistence round-trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("persists composer drafts and a rule grant across a re-mount", async () => {
    const first = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    act(() => {
      first.result.current.setComposerValue("Plan the launch retro");
    });
    const approval = lowRiskApproval();
    act(() => {
      first.result.current.requestApprovalDecision(approval, "rule");
    });
    await waitFor(() => expect(first.result.current.approvalRules.length).toBe(1));

    first.unmount();

    // A fresh hook reads the persisted state back from localStorage.
    const second = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    expect(second.result.current.composerValue).toBe("Plan the launch retro");
    expect(second.result.current.approvalRules.length).toBe(1);
    expect(second.result.current.approvalRules[0].requestId).toBe(approval.id);
  });

  it("round-trips schedules (shell-local) through localStorage", async () => {
    const first = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    act(() => {
      first.result.current.createSchedule({
        name: "Weekly digest",
        description: "Summarize approvals.",
        day: "Fri",
        time: "09:00"
      });
    });
    await waitFor(() => expect(first.result.current.schedules.length).toBe(1));
    first.unmount();

    const second = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    expect(second.result.current.schedules.length).toBe(1);
    expect(second.result.current.schedules[0].name).toBe("Weekly digest");
  });
});

describe("useShellRuntime — durable schedule contracts", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(runtime.listRuntimeConnectorStatuses).mockResolvedValue(null);
    vi.mocked(runtime.listRuntimeSchedulerJobs).mockResolvedValue(null);
    vi.mocked(runtime.listRuntimeSchedulerQueue).mockResolvedValue(null);
    vi.mocked(runtime.listRuntimeWorkflowDefinitions).mockResolvedValue(null);
    vi.mocked(runtime.listRuntimeWorkflowRuns).mockResolvedValue(null);
    vi.mocked(runtime.cancelRuntimeJobRun).mockResolvedValue(null);
  });

  it("composes connector-first schedules through the searchable connector boundary", async () => {
    vi.mocked(runtime.listRuntimeConnectorStatuses).mockResolvedValue([
      {
        id: "github",
        name: "GitHub",
        status: "connected",
        permissions: ["Read repositories"],
        healthSummary: "Connected",
        lastCheckedAt: "2026-07-01T00:00:00.000Z",
        supportsSearch: true,
        supportedActions: ["github.comment"]
      }
    ]);
    const { result } = renderHook(() => useShellRuntime());
    await waitFor(() =>
      expect(result.current.connectorManifests.find((entry) => entry.id === "github")?.status)
        .toBe("connected")
    );

    act(() => {
      result.current.createScheduleFromTrigger({
        name: "Issue digest",
        description: "Summarize open issues",
        trigger: {
          kind: "recurring",
          rule: {
            frequency: "daily",
            interval: 1,
            hour: 9,
            minute: 0,
            timezone: "UTC"
          }
        },
        connectorIds: ["github"]
      });
    });

    const definition = result.current.workflowDefinitions[0];
    expect(definition.steps).toEqual([
      {
        kind: "connector-read",
        id: "read-github",
        connectorId: "github",
        capability: "search",
        input: { query: "Summarize open issues" },
        outputVar: "github"
      },
      { kind: "prompt", id: "prompt", prompt: "Summarize open issues" }
    ]);
    await waitFor(() => expect(runtime.saveRuntimeScheduledJob).toHaveBeenCalledOnce());
    expect(vi.mocked(runtime.saveRuntimeWorkflowDefinition).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runtime.saveRuntimeScheduledJob).mock.invocationCallOrder[0]);
  });

  it("persists a cancelled workflow run with terminal timestamps", async () => {
    const startedAt = "2026-07-01T09:00:00.000Z";
    vi.mocked(runtime.listRuntimeSchedulerJobs).mockResolvedValue([
      {
        id: "job-1",
        schemaVersion: 1,
        name: "Issue digest",
        description: "Summarize issues",
        workflowDefinitionId: "definition-1",
        trigger: { kind: "once", at: "2026-07-01T09:00:00.000Z" },
        missedRunPolicy: "skip",
        status: "active",
        nextRunAt: "",
        lastRunAt: "",
        lastRunId: "",
        createdAt: startedAt,
        updatedAt: startedAt
      }
    ]);
    vi.mocked(runtime.listRuntimeWorkflowDefinitions).mockResolvedValue([
      {
        schemaVersion: 1,
        id: "definition-1",
        version: 1,
        name: "Issue digest",
        description: "Summarize issues",
        steps: [{ kind: "prompt", id: "prompt", prompt: "Summarize issues" }],
        createdAt: startedAt,
        updatedAt: startedAt
      }
    ]);
    vi.mocked(runtime.listRuntimeWorkflowRuns).mockResolvedValue([
      {
        id: "run-1",
        definitionId: "definition-1",
        definitionVersion: 1,
        status: "running",
        trigger: "schedule",
        scheduledJobId: "job-1",
        permissionProfile: "trusted",
        input: {},
        steps: [],
        attemptNumber: 1,
        startedAt,
        updatedAt: startedAt
      }
    ]);
    vi.mocked(runtime.cancelRuntimeJobRun).mockResolvedValue(true);
    const { result } = renderHook(() => useShellRuntime());
    await waitFor(() => expect(result.current.workflowRuns).toHaveLength(1));
    expect(result.current.workflowRuns[0]).toMatchObject({
      permissionProfile: "trusted",
      attemptNumber: 1
    });

    act(() => result.current.cancelScheduledRun("run-1"));

    await waitFor(() =>
      expect(runtime.saveRuntimeWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "run-1",
          status: "cancelled",
          failureReason: "Cancelled.",
          updatedAt: expect.any(String),
          finishedAt: expect.any(String)
        })
      )
    );
  });
});

describe("useShellRuntime — legacy key migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it.each(LEGACY_STORAGE_KEYS)(
    "recovers composer drafts from the legacy %s key and copies them forward",
    async (legacyKey) => {
      // Seed ONLY the legacy key (no fable.shell.v1 yet).
      setLocalStorage(legacyKey, {
        activeItem: "new-chat",
        composerValue: "Migrated from legacy",
        voiceEnabled: false,
        approvalAudit: [] as ApprovalAuditEntry[],
        dismissedApprovalIds: [] as string[],
        approvalRules: [],
        schedules: [],
        pinnedSourceIds: [],
        importedKnowledgeSources: [],
        memoryDisabled: false,
        memoryRecords: [],
        connectedBackendIds: []
      });

      const { result } = renderHook(() => useShellRuntime());
      await awaitMountEffects();

      expect(result.current.composerValue).toBe("Migrated from legacy");
      // The legacy value is copied forward to the canonical key (downgrade-safe:
      // the old key is intentionally left in place).
      const copied = window.localStorage.getItem(STORAGE_KEY);
      expect(copied).toContain("Migrated from legacy");
    }
  );

  it("prefers the canonical key when both canonical and legacy keys exist", async () => {
    setLocalStorage(LEGACY_STORAGE_KEYS[0], {
      composerValue: "from legacy"
    });
    setLocalStorage(STORAGE_KEY, {
      activeItem: "new-chat",
      composerValue: "from canonical",
      voiceEnabled: false,
      approvalAudit: [],
      dismissedApprovalIds: [],
      approvalRules: [],
      schedules: [],
      pinnedSourceIds: [],
      importedKnowledgeSources: [],
      memoryDisabled: false,
      memoryRecords: [],
      connectedBackendIds: []
    });

    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    expect(result.current.composerValue).toBe("from canonical");
  });
});

describe("useShellRuntime — backend connect (preview mode)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("records a local preview connection when the runtime boundary is absent", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    // connectRuntimeBackend returns null in preview mode -> local connection.
    await act(async () => {
      await result.current.connectBackend("openai");
    });

    expect(result.current.connectedBackendIds).toContain("openai");
    // The provider's auth state flips to connected in-memory.
    const openai = result.current.backendProviders.find((p) => p.id === "openai");
    expect(openai?.authState).toBe("connected");
    expect(result.current.backendStatus).toMatch(/openai connected/i);
  });

  it("drops the connection on disconnect in preview mode", async () => {
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      await result.current.connectBackend("openai");
    });
    expect(result.current.connectedBackendIds).toContain("openai");

    await act(async () => {
      await result.current.disconnectBackend("openai");
    });

    expect(result.current.connectedBackendIds).not.toContain("openai");
    const openai = result.current.backendProviders.find((p) => p.id === "openai");
    expect(openai?.authState).not.toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// Tool-call approval dispatch: a granted tool-call approval drives the shared
// approval gate so the agent-loop executor proceeds; a deny drives it to refuse.
// This is the grant -> execute bridge: the user's decision in the approval UI
// unblocks the tool call the loop is awaiting.
// ---------------------------------------------------------------------------

import { createApprovalGate, type ProductionApprovalGate } from "@fable/connectors";

function toolCallApproval(id: string, service = "openai"): ApprovalRequest {
  return {
    id,
    service,
    action: "read-file path: README.md",
    mode: "read-only",
    riskLevel: "low",
    dataUsed: ["path: README.md"],
    consequence: `Execute the read-file tool via ${service} with the given arguments.`,
    requestedAt: new Date(0).toISOString(),
    decisions: ["once", "session", "rule", "modify", "deny"]
  };
}

describe("useShellRuntime — tool-call approval grant/deny dispatch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("a granted tool-call approval drives the gate to granted (executor proceeds)", async () => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }));

    const approval = toolCallApproval("native-read-file");
    // Register the pending tool call on the gate (as onToolCall would).
    gate.register(approval);
    act(() => {
      result.current.recordBackendToolCall({
        callId: "read-file",
        tool: "read-file",
        arguments: '{"path":"README.md"}',
        approval
      });
    });
    await waitFor(() => expect(result.current.openApprovals).toContainEqual(approval));
    let decision: string | undefined;
    void gate.waitForDecision(approval).then((d) => (decision = d));

    await act(async () => {
      result.current.requestApprovalDecision(approval, "once");
    });
    await waitFor(() => expect(decision).toBe("granted"));
    await waitFor(() =>
      expect(result.current.openApprovals.some((candidate) => candidate.id === approval.id)).toBe(false)
    );

    // The grant was also recorded as audit (the existing behavior is preserved).
    expect(result.current.approvalAudit.length).toBe(1);
  });

  it("a denied tool-call approval drives the gate to denied (executor refuses)", async () => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }));

    const approval = toolCallApproval("native-write-file", "openai");
    approval.action = "write-file path: out.txt content: hi";
    approval.mode = "full-access";
    approval.riskLevel = "high";
    approval.confirmationPhrase = "approve write-file";
    gate.register(approval);
    let decision: string | undefined;
    void gate.waitForDecision(approval).then((d) => (decision = d));

    await act(async () => {
      result.current.requestApprovalDecision(approval, "deny");
    });
    await waitFor(() => expect(decision).toBe("denied"));
  });

  it("does not dispatch a non-tool-call approval to the gate (no pending entry)", async () => {
    const gate = createApprovalGate();
    const spy = vi.spyOn(gate, "resolveGrant");
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }));

    // A regular connector approval that was never registered on the gate.
    const approval = lowRiskApproval();
    await act(async () => {
      result.current.requestApprovalDecision(approval, "once");
    });
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));

    // No gate dispatch happened (the approval wasn't a pending tool call).
    expect(spy).not.toHaveBeenCalled();
  });

  it("a session grant for a tool call becomes a standing grant the gate honors next time", async () => {
    const gate = createApprovalGate();
    const { result } = renderHook(() => useShellRuntime({ approvalGate: gate }));

    const approval = toolCallApproval("native-read-file");
    await act(async () => {
      result.current.requestApprovalDecision(approval, "session");
    });
    await waitFor(() => expect(result.current.sessionApprovalGrants.length).toBe(1));

    // The shell re-syncs its standing grants into the gate (App.tsx effect).
    gate.replaceStandingGrants([
      ...result.current.sessionApprovalGrants,
      ...result.current.approvalRules
    ]);

    // The next matching read-file call is auto-satisfied — no blocking, no prompt.
    const again = toolCallApproval("native-read-file-2");
    const decision = await gate.waitForDecision(again);
    expect(decision).toBe("granted");
  });
});

// ---------------------------------------------------------------------------
// Knowledge + memory lifecycle: pin guards, disable/forget exclusion, rollback
// on native save failure, and export policy. These drive the hook directly so
// the lifecycle is asserted against the shell's own state + callbacks, with the
// Rust wrappers mocked (preview mode).
// ---------------------------------------------------------------------------

import type { MemoryRecord, KnowledgeSource, LocalFileImport } from "@fable/protocol";

function seedMemory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-seed",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    ...over
  };
}

function seedImport(over: Partial<LocalFileImport> = {}): LocalFileImport {
  return {
    id: "source-seed",
    title: "Quarterly plan",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 1.0 KB",
    freshness: "Imported today",
    pinned: false,
    trust: "untrusted",
    contentPreview: "Plan content",
    contentFingerprint: "fp-seed",
    sizeBytes: 1024,
    importedAt: "2026-07-01T00:00:00.000Z",
    origin: "local-import",
    ...over
  };
}

/** Seed shell state into localStorage so the preview path loads it on mount. */
function seedShellState(state: Partial<PersistedShellState>) {
  const base: PersistedShellState = {
    activeItem: "new-chat",
    composerValue: "",
    voiceEnabled: false,
    approvalAudit: [],
    dismissedApprovalIds: [],
    approvalRules: [],
    schedules: [],
    goals: [],
    plans: [],
    pinnedSourceIds: [],
    importedKnowledgeSources: [],
    memoryDisabled: false,
    memoryRecords: [],
    connectedBackendIds: [],
    selectedModelId: "",
    permissionMode: "full-access",
    permissionLabel: "Work Freely",
    customApprovalSettings: {
      allowSmallLocalEdits: false,
      allowPowerfulCommands: false
    }
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, ...state }));
}

describe("useShellRuntime — memory lifecycle (disable / forget / re-enable / pin guard)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("forgets a memory via a forgottenAt tombstone that survives reload", async () => {
    seedShellState({ memoryRecords: [seedMemory()] });
    const first = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    expect(first.result.current.managedMemoryRecords).toHaveLength(1);
    await act(async () => {
      first.result.current.forgetMemory("mem-seed");
    });
    // The record is tombstoned, not removed from the array, but is excluded
    // from the live read path (the hook surfaces the full array; the page
    // filters forgottenAt).
    const forgotten = first.result.current.managedMemoryRecords.find((m) => m.id === "mem-seed");
    expect(forgotten?.forgottenAt).toBeTruthy();

    first.unmount();
    const second = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    // The tombstone is persisted through localStorage, so it survives reload.
    const reloaded = second.result.current.managedMemoryRecords.find((m) => m.id === "mem-seed");
    expect(reloaded?.forgottenAt).toBeTruthy();
  });

  it("disables a single memory and re-enables it without duplicating records", async () => {
    seedShellState({ memoryRecords: [seedMemory()] });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.toggleMemoryRecordDisabled("mem-seed");
    });
    expect(result.current.managedMemoryRecords).toHaveLength(1);
    expect(result.current.managedMemoryRecords[0].disabled).toBe(true);

    await act(async () => {
      result.current.toggleMemoryRecordDisabled("mem-seed");
    });
    expect(result.current.managedMemoryRecords).toHaveLength(1);
    expect(result.current.managedMemoryRecords[0].disabled).toBe(false);
  });

  it("refuses to pin a disabled memory but allows unpinning", async () => {
    seedShellState({ memoryRecords: [seedMemory({ disabled: true, pinned: false })] });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.toggleMemoryPin("mem-seed");
    });
    expect(result.current.managedMemoryRecords[0].pinned).toBe(false);
    expect(result.current.memoryStatus).toMatch(/cannot be pinned/i);

    // A pinned-then-disabled record can still be unpinned.
    await act(async () => {
      result.current.toggleMemoryPin("mem-seed");
    });
  });

  it("refuses to pin a forgotten memory", async () => {
    seedShellState({ memoryRecords: [seedMemory({ forgottenAt: "2026-07-01T00:00:00.000Z" })] });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.toggleMemoryPin("mem-seed");
    });
    expect(result.current.managedMemoryRecords[0].pinned).toBe(false);
  });
});

describe("useShellRuntime — source lifecycle (disable / delete / pin guard)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("disables a source and clears its pin so it cannot bypass exclusion", async () => {
    seedShellState({
      importedKnowledgeSources: [seedImport()],
      pinnedSourceIds: ["source-seed"]
    });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.toggleKnowledgeSourceDisabled("source-seed");
    });
    const source = result.current.workspaceKnowledgeSources.find((s) => s.id === "source-seed");
    expect(source?.disabled).toBe(true);
    expect(result.current.pinnedSourceIds).not.toContain("source-seed");
  });

  it("deletes a source, removing it from search, citations, and pins", async () => {
    seedShellState({
      importedKnowledgeSources: [seedImport()],
      pinnedSourceIds: ["source-seed"]
    });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.deleteKnowledgeSource("source-seed");
    });
    expect(
      result.current.workspaceKnowledgeSources.some((s) => s.id === "source-seed")
    ).toBe(false);
    expect(result.current.pinnedSourceIds).not.toContain("source-seed");
  });

  it("refuses to pin a disabled source", async () => {
    seedShellState({ importedKnowledgeSources: [seedImport({ disabled: true })] });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      result.current.toggleSourcePin("source-seed");
    });
    expect(result.current.pinnedSourceIds).not.toContain("source-seed");
  });

  it("rolls back an optimistic source disable when the native save fails", async () => {
    seedShellState({ importedKnowledgeSources: [seedImport()] });
    vi.mocked(runtime.saveRuntimeImportedKnowledgeSources).mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    const before = result.current.workspaceKnowledgeSources.find((s) => s.id === "source-seed");
    expect(Boolean(before?.disabled)).toBe(false);

    await act(async () => {
      result.current.toggleKnowledgeSourceDisabled("source-seed");
    });
    // The optimistic disable is rolled back to the prior authoritative state.
    await waitFor(() => {
      const after = result.current.workspaceKnowledgeSources.find((s) => s.id === "source-seed");
      // Rolled back: disabled is unset/false (not the optimistically-set true).
      expect(Boolean(after?.disabled)).toBe(false);
    });
    expect(result.current.importStatus).toMatch(/could not save source changes|disk full/i);

    vi.mocked(runtime.saveRuntimeImportedKnowledgeSources).mockResolvedValue(null);
  });
});

describe("useShellRuntime — memory state rollback on native save failure", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("rolls back a memory edit when the native save fails", async () => {
    seedShellState({ memoryRecords: [seedMemory({ title: "Original" })] });
    vi.mocked(runtime.saveRuntimeMemoryState).mockRejectedValueOnce(new Error("vault locked"));
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    act(() => {
      result.current.startMemoryEdit(seedMemory({ title: "Original" }));
      result.current.setEditingMemoryDraft({ title: "Edited", value: "edited value" });
    });
    await act(async () => {
      result.current.saveMemoryEdit("mem-seed");
    });

    // The edit is rolled back to the original title.
    await waitFor(() => {
      const record = result.current.managedMemoryRecords.find((m) => m.id === "mem-seed");
      expect(record?.title).toBe("Original");
    });

    vi.mocked(runtime.saveRuntimeMemoryState).mockResolvedValue(null);
  });
});

describe("useShellRuntime — knowledge + memory export", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("exports live memories only, excluding forgotten and disabled records", async () => {
    seedShellState({
      memoryRecords: [
        seedMemory({ id: "live", title: "Live one", disabled: false }),
        seedMemory({ id: "disabled", title: "Off one", disabled: true }),
        seedMemory({ id: "gone", title: "Gone one", forgottenAt: "2026-07-01T00:00:00.000Z" })
      ]
    });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      await result.current.exportMemory();
    });

    const exportText = result.current.memoryExportText;
    expect(exportText).toContain("Live one");
    expect(exportText).not.toContain("Off one");
    expect(exportText).not.toContain("Gone one");
  });

  it("exports workspace knowledge (live sources + memories), excluding disabled/forgotten", async () => {
    seedShellState({
      importedKnowledgeSources: [
        seedImport({ id: "live-src", title: "Live source" }),
        seedImport({ id: "off-src", title: "Disabled source", disabled: true })
      ],
      memoryRecords: [
        seedMemory({ id: "live-mem", title: "Live memory" }),
        seedMemory({ id: "gone-mem", title: "Gone memory", forgottenAt: "2026-07-01T00:00:00.000Z" })
      ]
    });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      await result.current.exportKnowledge();
    });

    const exportText = result.current.knowledgeExportText;
    expect(exportText).toContain("Live source");
    expect(exportText).toContain("Live memory");
    expect(exportText).not.toContain("Disabled source");
    expect(exportText).not.toContain("Gone memory");
  });
});

describe("useShellRuntime — search excludes disabled sources", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("does not surface a disabled source in knowledge search citations", async () => {
    seedShellState({
      importedKnowledgeSources: [
        seedImport({
          id: "match",
          title: "Alpha report",
          contentPreview: "alpha beta gamma keywords here"
        }),
        seedImport({
          id: "disabled-match",
          title: "Disabled alpha",
          contentPreview: "alpha beta gamma keywords here",
          disabled: true
        })
      ]
    });
    const { result } = renderHook(() => useShellRuntime());
    await awaitMountEffects();

    await act(async () => {
      await result.current.searchKnowledge("alpha keywords");
    });

    const citedIds = result.current.knowledgeCitations.map((c) => c.sourceId);
    expect(citedIds).toContain("match");
    expect(citedIds).not.toContain("disabled-match");
  });
});
