import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApprovalAuditEntry, ApprovalRequest } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import { useShellRuntime } from "./useShellRuntime";
import { STORAGE_KEY, LEGACY_STORAGE_KEYS } from "../lib/constants";

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

vi.mock("../runtime", () => ({
  clearRuntimeBackend: vi.fn(async () => null),
  clearRuntimeConnectorAuth: vi.fn(async () => null),
  connectRuntimeBackend: vi.fn(async () => null),
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
  loadRuntimeApprovalAudit: vi.fn(async () => null),
  loadRuntimeApprovalRules: vi.fn(async () => null),
  loadRuntimeImportedKnowledgeSources: vi.fn(async () => null),
  loadRuntimeMemoryState: vi.fn(async () => null),
  loadRuntimeSnapshot: vi.fn(async () => null),
  prepareRuntimeConnectorAction: vi.fn(async () => null),
  promoteRuntimeKnowledgeSourceToMemory: vi.fn(async () => null),
  recordRuntimeBackendEvent: vi.fn(async () => null),
  refreshRuntimeConnectorHealth: vi.fn(async () => null),
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
  saveRuntimeSnapshot: vi.fn(async () => null),
  searchRuntimeConnector: vi.fn(async () => null),
  searchRuntimeKnowledgeSources: vi.fn(async () => null),
  startRuntimeConnectorAuth: vi.fn(async () => null)
}));

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
    const approval = highRiskApproval();

    act(() => {
      result.current.requestApprovalDecision(approval, "once");
    });

    // The decision is held pending the typed confirmation phrase; nothing is
    // recorded yet.
    expect(result.current.pendingApprovalConfirmation).not.toBeNull();
    expect(result.current.pendingApprovalConfirmation?.decision).toBe("once");
    expect(result.current.approvalAudit.length).toBe(0);
    await awaitMountEffects();
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
    await awaitMountEffects();
  });

  it("rejects a save when allowed data or consequence is empty", async () => {
    const { result } = renderHook(() => useShellRuntime());
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
    await awaitMountEffects();
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

  it("replaces an existing audit entry for the same entry id (dedupe by id)", async () => {
    // prependAuditEntry dedupes by the audit ENTRY id, not the requestId. The
    // runtime-backed tool-call path (recordBackendToolCall) returns a fixed
    // entry from the Rust boundary, so replaying it keeps a stable id and the
    // shell must replace, not duplicate.
    const fixedEntry: ApprovalAuditEntry = {
      id: "tool-call-fixed-entry",
      requestId: "native-tool-1",
      decision: "once",
      decidedAt: "2026-06-27T00:00:00.000Z",
      note: "Recorded backend tool call"
    };
    vi.mocked(runtime.recordRuntimeBackendEvent).mockResolvedValue(fixedEntry);

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
    await waitFor(() => expect(result.current.approvalAudit.length).toBe(1));

    // A second identical tool call returns the SAME entry id: it must replace,
    // not append, keeping the audit at one entry.
    act(() => {
      result.current.recordBackendToolCall({
        callId: "call_2",
        tool: "read-file",
        arguments: "{}",
        approval
      });
    });
    // A second identical tool call returns the SAME entry id: it must replace,
    // not append, keeping exactly one matching entry.
    await waitFor(() => {
      expect(
        result.current.approvalAudit.filter((e) => e.id === "tool-call-fixed-entry").length
      ).toBe(1);
    });

    vi.mocked(runtime.recordRuntimeBackendEvent).mockResolvedValue(null);
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
    let decision: string | undefined;
    void gate.waitForDecision(approval).then((d) => (decision = d));

    await act(async () => {
      result.current.requestApprovalDecision(approval, "once");
    });
    await waitFor(() => expect(decision).toBe("granted"));

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
