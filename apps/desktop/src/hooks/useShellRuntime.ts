import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  ConnectorManifest,
  KnowledgeCitation,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryRecord,
  RuntimeSnapshot,
  ThreadSummary,
  WorkspaceDirective
} from "@arden/protocol";
import {
  importLocalTextFile,
  searchKnowledgeSources,
  type LocalTextFileCandidate
} from "@arden/connectors";
import {
  automations,
  chatThreads,
  connectors,
  knowledgeSources,
  memoryRecords,
  pendingApprovals,
  projects,
  workspaceDirectives
} from "../data/workspace";
import {
  exportRuntimeMemoryState,
  importRuntimeLocalKnowledgeSource,
  loadRuntimeApprovalAudit,
  loadRuntimeApprovalRules,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  loadRuntimeSnapshot,
  promoteRuntimeKnowledgeSourceToMemory,
  resolveRuntimeApprovalRequest,
  saveRuntimeMemoryState,
  saveRuntimeSnapshot,
  searchRuntimeKnowledgeSources
} from "../runtime";
import {
  MAX_IMPORTED_KNOWLEDGE_SOURCES,
  utilityItems
} from "../lib/constants";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type ApprovalModificationDraft,
  type AutomationRuleView,
  type PendingApprovalConfirmation,
  type PersistedShellState
} from "../lib/types";
import {
  importedSourceDirective,
  mergeKnowledgeSources,
  prependAuditEntry,
  readFileAsText
} from "../lib/helpers";
import {
  encodeMemoryExportFallback,
  promoteKnowledgeSourceFallback,
  resolveApprovalFallback
} from "../lib/approval-fallbacks";
import {
  persistShellState,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot
} from "../lib/persistence";

/**
 * Owns all workspace shell state and the runtime-backed effects (snapshot
 * recovery, approval audit/rules, imported knowledge, memory). Returns the
 * state and callbacks the root component needs to render the shell, composer,
 * and context views.
 */

const defaultShellState: PersistedShellState = {
  activeItem: "arden-initial-build",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  automationStatuses: {},
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords
};

export interface ShellRuntime {
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;
  activeUtility: string | undefined;
  activePage: "Knowledge" | "Automations" | "Plugins" | null;
  isChatView: boolean;
  activeThread: ThreadSummary | undefined;
  allThreads: ThreadSummary[];
  // composer
  composerValue: string;
  setComposerValue: (value: string) => void;
  voiceEnabled: boolean;
  toggleVoice: () => void;
  setImportStatus: (status: string | null) => void;
  triggerAttach: () => void;
  toolPickerOpen: boolean;
  commandOpen: boolean;
  importStatus: string | null;
  knowledgeCitations: KnowledgeCitation[];
  knowledgeSearchMode: string;
  composerRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  submitComposer: (event: FormEvent) => void;
  handleLocalKnowledgeFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  focusComposer: (value: string) => void;
  useDirective: (directive: WorkspaceDirective) => void;
  useConnector: (connector: ConnectorManifest) => void;
  runCommand: (command: string) => void;
  // approvals
  openApprovals: ApprovalRequest[];
  approvalAudit: ApprovalAuditEntry[];
  sessionApprovalGrants: ApprovalGrant[];
  approvalRules: ApprovalGrant[];
  editingApprovalId: string | null;
  approvalModificationDraft: ApprovalModificationDraft;
  pendingApprovalConfirmation: PendingApprovalConfirmation | null;
  approvalConfirmationText: string;
  setApprovalModificationDraft: (draft: ApprovalModificationDraft) => void;
  setApprovalConfirmationText: (value: string) => void;
  requestApprovalDecision: (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification
  ) => void;
  startApprovalModify: (approval: ApprovalRequest) => void;
  saveApprovalModify: (approval: ApprovalRequest) => void;
  confirmApprovalDecision: () => void;
  clearApprovalInteraction: () => void;
  // knowledge + memory
  workspaceKnowledgeSources: KnowledgeSource[];
  contextualDirectives: WorkspaceDirective[];
  pinnedSourceIds: string[];
  managedMemoryRecords: MemoryRecord[];
  memoryDisabled: boolean;
  memoryState: MemoryControlState;
  editingMemoryId: string | null;
  editingMemoryDraft: Pick<MemoryRecord, "title" | "value">;
  memoryExportText: string;
  memoryStatus: string;
  setEditingMemoryDraft: (draft: Pick<MemoryRecord, "title" | "value">) => void;
  toggleSourcePin: (sourceId: string) => void;
  promoteSourceToMemory: (source: KnowledgeSource) => void;
  startMemoryEdit: (record: MemoryRecord) => void;
  saveMemoryEdit: (recordId: string) => void;
  toggleMemoryPin: (recordId: string) => void;
  forgetMemory: (recordId: string) => void;
  toggleMemoryDisabled: () => void;
  exportMemory: () => Promise<void>;
  cancelMemoryEdit: () => void;
  // automations
  automationRules: AutomationRuleView[];
  toggleAutomation: (rule: AutomationRuleView) => void;
  // shell-level status
  lastAction: string;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  startNewChat: () => void;
  openThread: (thread: ThreadSummary, label: string) => void;
  setLastAction: (action: string) => void;
}

export function useShellRuntime(): ShellRuntime {
  const initialState = useMemo(() => readPersistedShellState(defaultShellState), []);
  const [activeItem, setActiveItem] = useState(initialState.activeItem);
  const [composerValue, setComposerValue] = useState(initialState.composerValue);
  const [voiceEnabled, setVoiceEnabled] = useState(initialState.voiceEnabled);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [lastAction, setLastAction] = useState("Workspace ready");
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(initialState.approvalAudit);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(initialState.dismissedApprovalIds);
  const [approvalRules, setApprovalRules] = useState<ApprovalGrant[]>(initialState.approvalRules);
  const [sessionApprovalGrants, setSessionApprovalGrants] = useState<ApprovalGrant[]>([]);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [approvalModificationDraft, setApprovalModificationDraft] =
    useState<ApprovalModificationDraft>(EMPTY_APPROVAL_MODIFICATION);
  const [pendingApprovalConfirmation, setPendingApprovalConfirmation] =
    useState<PendingApprovalConfirmation | null>(null);
  const [approvalConfirmationText, setApprovalConfirmationText] = useState("");
  const [automationStatuses, setAutomationStatuses] = useState<Record<string, string>>(
    initialState.automationStatuses
  );
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(initialState.pinnedSourceIds);
  const [importedKnowledgeSources, setImportedKnowledgeSources] = useState<LocalFileImport[]>(
    initialState.importedKnowledgeSources
  );
  const [knowledgeCitations, setKnowledgeCitations] = useState<KnowledgeCitation[]>([]);
  const [knowledgeSearchMode, setKnowledgeSearchMode] = useState("lexical-fallback");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [managedMemoryRecords, setManagedMemoryRecords] = useState<MemoryRecord[]>(
    initialState.memoryRecords
  );
  const [memoryDisabled, setMemoryDisabled] = useState(initialState.memoryDisabled);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryDraft, setEditingMemoryDraft] = useState<Pick<MemoryRecord, "title" | "value">>({
    title: "",
    value: ""
  });
  const [memoryExportText, setMemoryExportText] = useState("");
  const [memoryStatus, setMemoryStatus] = useState("Memory ready");
  const [runtimeSnapshotReady, setRuntimeSnapshotReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allThreads = useMemo(
    () => [...chatThreads, ...projects.flatMap((project) => project.threads)],
    []
  );
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = utilityItems.find((item) => item.label === activeItem)?.label;
  // A page view is any of the three first-class utility pages. When a page is
  // active the composer is hidden and the dedicated page renders instead.
  const activePage: "Knowledge" | "Automations" | "Plugins" | null =
    activeUtility === "Knowledge" || activeUtility === "Automations" || activeUtility === "Plugins"
      ? (activeUtility as "Knowledge" | "Automations" | "Plugins")
      : null;
  // Chat views: the default home, a selected thread/project, or a new chat.
  const isChatView = activePage === null;
  const workspaceKnowledgeSources = useMemo(
    () => mergeKnowledgeSources(knowledgeSources, importedKnowledgeSources),
    [importedKnowledgeSources]
  );
  const contextualDirectives = useMemo(
    () => [
      ...importedKnowledgeSources.slice(0, 2).map(importedSourceDirective),
      ...workspaceDirectives
    ].slice(0, 4),
    [importedKnowledgeSources]
  );
  const openApprovals = pendingApprovals.filter((approval) => !dismissedApprovalIds.includes(approval.id));
  const automationRules: AutomationRuleView[] = automations.map((rule) => ({
    ...rule,
    status: (automationStatuses[rule.id] ?? rule.status) as AutomationRuleView["status"]
  }));
  const memoryState = useMemo<MemoryControlState>(
    () => ({
      disabled: memoryDisabled,
      records: managedMemoryRecords
    }),
    [managedMemoryRecords, memoryDisabled]
  );
  const shellState = useMemo<PersistedShellState>(
    () => ({
      activeItem,
      composerValue,
      voiceEnabled,
      approvalAudit,
      dismissedApprovalIds,
      approvalRules,
      automationStatuses: automationStatuses as PersistedShellState["automationStatuses"],
      pinnedSourceIds,
      importedKnowledgeSources,
      memoryDisabled,
      memoryRecords: managedMemoryRecords
    }),
    [
      activeItem,
      approvalAudit,
      approvalRules,
      automationStatuses,
      composerValue,
      dismissedApprovalIds,
      importedKnowledgeSources,
      managedMemoryRecords,
      memoryDisabled,
      pinnedSourceIds,
      voiceEnabled
    ]
  );

  useEffect(() => {
    persistShellState(shellState);
  }, [shellState]);

  useEffect(() => {
    if (!runtimeSnapshotReady) {
      return;
    }

    void saveRuntimeSnapshot(shellStateToRuntimeSnapshot(shellState)).catch((error) => {
      setLastAction(error instanceof Error ? error.message : "Arden could not save runtime snapshot.");
    });
  }, [runtimeSnapshotReady, shellState]);

  useEffect(() => {
    let active = true;

    void loadRuntimeSnapshot()
      .then((snapshot: RuntimeSnapshot | null) => {
        if (!active || !snapshot) {
          return;
        }

        const recovered = shellStateFromRuntimeSnapshot(snapshot, defaultShellState);
        setActiveItem(recovered.activeItem);
        setComposerValue(recovered.composerValue);
        setVoiceEnabled(recovered.voiceEnabled);
        setApprovalAudit(recovered.approvalAudit);
        setDismissedApprovalIds(recovered.dismissedApprovalIds);
        setApprovalRules(recovered.approvalRules);
        setAutomationStatuses(recovered.automationStatuses);
        setPinnedSourceIds(recovered.pinnedSourceIds);
        setImportedKnowledgeSources(recovered.importedKnowledgeSources);
        setMemoryDisabled(recovered.memoryDisabled);
        setManagedMemoryRecords(recovered.memoryRecords);
        setLastAction("Recovered workspace from local runtime");
      })
      .finally(() => {
        if (active) {
          setRuntimeSnapshotReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

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
  }, []);

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
  }, []);

  useEffect(() => {
    let active = true;

    void loadRuntimeImportedKnowledgeSources().then((sources) => {
      if (!active || !sources || sources.length === 0) {
        return;
      }

      setImportedKnowledgeSources(sources);
      setPinnedSourceIds((current) => Array.from(new Set([...current, ...sources.map((source) => source.id)])));
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    void loadRuntimeMemoryState().then((state) => {
      if (!active || !state || (!state.disabled && state.records.length === 0)) {
        return;
      }

      setMemoryDisabled(state.disabled);
      setManagedMemoryRecords(state.records);
    });

    return () => {
      active = false;
    };
  }, []);

  const focusComposer = (value: string) => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(value.length, value.length);
    });
  };

  const toggleVoice = () => {
    setVoiceEnabled((enabled) => {
      setLastAction(enabled ? "Voice paused" : "Voice ready");
      return !enabled;
    });
  };

  const triggerAttach = () => {
    setImportStatus("Choose a text, Markdown, JSON, CSV, or YAML file.");
    fileInputRef.current?.click();
  };

  const addImportedKnowledgeSource = (source: LocalFileImport) => {
    setImportedKnowledgeSources((current) =>
      [source, ...current.filter((existing) => existing.id !== source.id)].slice(
        0,
        MAX_IMPORTED_KNOWLEDGE_SOURCES
      )
    );
    setPinnedSourceIds((current) => (current.includes(source.id) ? current : [...current, source.id]));
  };

  const importLocalKnowledgeFile = async (file: File) => {
    setImportStatus(`Reading ${file.name}...`);

    try {
      const content = await readFileAsText(file);
      const candidate: LocalTextFileCandidate = {
        name: file.name,
        content,
        sizeBytes: file.size,
        importedAt: new Date().toISOString()
      };
      const imported =
        (await importRuntimeLocalKnowledgeSource(candidate)) ?? importLocalTextFile(candidate);

      addImportedKnowledgeSource(imported);
      setImportStatus(`Imported ${imported.title}. It is pinned as untrusted knowledge.`);
      setLastAction(`Imported source: ${imported.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Arden could not import that file.";
      setImportStatus(message);
      setLastAction(message);
    }
  };

  const handleLocalKnowledgeFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    void importLocalKnowledgeFile(file);
  };

  const runKnowledgeSearch = async (query: string) => {
    const runtimeResult = await searchRuntimeKnowledgeSources(query, workspaceKnowledgeSources, 3);
    const result = runtimeResult ?? searchKnowledgeSources(query, workspaceKnowledgeSources, 3);

    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    setLastAction(
      result.citations.length > 0
        ? `Found ${result.citations.length} cited workspace sources`
        : "No matching workspace sources found"
    );
  };

  const commitMemoryState = (state: MemoryControlState, status: string) => {
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus(status);

    void saveRuntimeMemoryState(state)
      .then((runtimeState) => {
        if (!runtimeState) {
          return;
        }

        setMemoryDisabled(runtimeState.disabled);
        setManagedMemoryRecords(runtimeState.records);
      })
      .catch((error) => {
        setMemoryStatus(error instanceof Error ? error.message : "Arden could not save memory state.");
      });
  };

  const startMemoryEdit = (record: MemoryRecord) => {
    setEditingMemoryId(record.id);
    setEditingMemoryDraft({
      title: record.title,
      value: record.value
    });
    setMemoryStatus(`Editing memory: ${record.title}`);
  };

  const saveMemoryEdit = (recordId: string) => {
    const title = editingMemoryDraft.title.trim();
    const value = editingMemoryDraft.value.trim();

    if (!title || !value) {
      setMemoryStatus("Memory title and value are required.");
      return;
    }

    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId
        ? {
            ...record,
            title,
            value,
            freshness: "Updated now",
            source: "Edited by Josh"
          }
        : record
    );

    setEditingMemoryId(null);
    setEditingMemoryDraft({ title: "", value: "" });
    commitMemoryState({ disabled: memoryDisabled, records: nextRecords }, "Memory updated.");
  };

  const cancelMemoryEdit = () => {
    setEditingMemoryId(null);
    setEditingMemoryDraft({ title: "", value: "" });
    setMemoryStatus("Memory edit cancelled.");
  };

  const forgetMemory = (recordId: string) => {
    const nextRecords = managedMemoryRecords.filter((record) => record.id !== recordId);
    const removed = managedMemoryRecords.find((record) => record.id === recordId);
    setEditingMemoryId((current) => (current === recordId ? null : current));
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      removed ? `Forgot memory: ${removed.title}` : "Memory forgotten."
    );
  };

  const toggleMemoryPin = (recordId: string) => {
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId ? { ...record, pinned: !record.pinned } : record
    );
    const changed = nextRecords.find((record) => record.id === recordId);
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      changed?.pinned ? "Memory pinned." : "Memory unpinned."
    );
  };

  const toggleMemoryDisabled = () => {
    commitMemoryState(
      { disabled: !memoryDisabled, records: managedMemoryRecords },
      memoryDisabled ? "Memory enabled." : "Memory disabled."
    );
  };

  const exportMemory = async () => {
    try {
      const exported = (await exportRuntimeMemoryState(memoryState)) ?? encodeMemoryExportFallback(memoryState);
      setMemoryExportText(exported);
      setMemoryStatus("Memory export ready.");
    } catch (error) {
      setMemoryStatus(error instanceof Error ? error.message : "Arden could not export memory.");
    }
  };

  const promoteSourceToMemory = async (source: KnowledgeSource) => {
    const request: MemoryPromotionRequest = {
      source,
      decision: "once",
      decidedAt: new Date().toISOString(),
      state: memoryState
    };

    try {
      const response =
        (await promoteRuntimeKnowledgeSourceToMemory(request)) ?? promoteKnowledgeSourceFallback(request);
      setApprovalAudit((current) => prependAuditEntry(current, response.auditEntry));
      commitMemoryState(response.state, `Approved memory: ${response.record.title}`);
      setPinnedSourceIds((current) => (current.includes(source.id) ? current : [...current, source.id]));
      setLastAction(`Approved ${source.title} into memory`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Arden could not approve that source into memory.";
      setMemoryStatus(message);
      setLastAction(message);
    }
  };

  const useDirective = (directive: WorkspaceDirective) => {
    setComposerValue(directive.prompt);
    setLastAction(`Loaded directive: ${directive.label}`);
    focusComposer(directive.prompt);
  };

  const openThread = (thread: ThreadSummary, label: string) => {
    setActiveItem(thread.id);
    setMobileNavOpen(false);
    setLastAction(`Opened ${label}: ${thread.title}`);
  };

  const startNewChat = () => {
    setActiveItem("new-chat");
    setComposerValue("");
    setMobileNavOpen(false);
    setLastAction("New chat ready");
    focusComposer("");
  };

  const submitComposer = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = composerValue.trim();
    if (!trimmed) {
      setKnowledgeCitations([]);
      setLastAction("Choose a directive or write a prompt.");
      return;
    }

    void runKnowledgeSearch(trimmed);
  };

  const useConnector = (connector: ConnectorManifest) => {
    const prompt = `Use @${connector.id} with the current workspace context.`;
    setComposerValue(prompt);
    setLastAction(`${connector.name} is ready in the composer`);
    focusComposer(prompt);
  };

  const runCommand = (command: string) => {
    const prompt = `${command} `;
    setComposerValue(prompt);
    setCommandOpen(false);
    setLastAction(`${command} command ready`);
    focusComposer(prompt);
  };

  const approvalNeedsConfirmation = (
    approval: ApprovalRequest,
    modification?: ApprovalModification
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
    confirmationText?: string
  ) => {
    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
      confirmationText
    };

    try {
      const response =
        (await resolveRuntimeApprovalRequest(request)) ?? resolveApprovalFallback(request);

      setApprovalAudit((current) => prependAuditEntry(current, response.auditEntry));
      if (response.dismissed) {
        setDismissedApprovalIds((current) =>
          current.includes(approval.id) ? current : [...current, approval.id]
        );
      }
      if (response.grant?.scope === "session") {
        setSessionApprovalGrants((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id)
        ]);
      }
      if (response.grant?.scope === "rule") {
        setApprovalRules((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id)
        ]);
      }

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`
      );
    } catch (error) {
      setLastAction(
        error instanceof Error ? error.message : "Arden could not resolve that approval."
      );
    }
  };

  const requestApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification
  ) => {
    if (decision !== "deny" && approvalNeedsConfirmation(approval, modification)) {
      setPendingApprovalConfirmation({ request: approval, decision, modification });
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
      consequence: approval.consequence
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
      consequence
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
      approvalConfirmationText
    );
  };

  const toggleSourcePin = (sourceId: string) => {
    setPinnedSourceIds((current) => {
      if (current.includes(sourceId)) {
        setLastAction("Source removed from pinned context");
        return current.filter((id) => id !== sourceId);
      }
      setLastAction("Source pinned to workspace context");
      return [...current, sourceId];
    });
  };

  const toggleAutomation = (rule: AutomationRuleView) => {
    if (rule.requiresApproval && rule.status === "draft") {
      const prompt = `/schedule ${rule.title} with pinned memory, connector health, and active projects.`;
      setComposerValue(prompt);
      setActiveItem("arden-memory");
      setLastAction("Automation needs approval before it can run");
      focusComposer(prompt);
      return;
    }

    setAutomationStatuses((current) => ({
      ...current,
      [rule.id]: (current[rule.id] ?? rule.status) === "active" ? "paused" : "active"
    }));
    setLastAction(`${rule.title} updated`);
  };

  return {
    activeItem,
    setActiveItem,
    activeUtility,
    activePage,
    isChatView,
    activeThread,
    allThreads,
    composerValue,
    setComposerValue,
    voiceEnabled,
    toggleVoice,
    setImportStatus,
    triggerAttach,
    toolPickerOpen,
    commandOpen,
    importStatus,
    knowledgeCitations,
    knowledgeSearchMode,
    composerRef,
    fileInputRef,
    submitComposer,
    handleLocalKnowledgeFileChange,
    focusComposer,
    useDirective,
    useConnector,
    runCommand,
    openApprovals,
    approvalAudit,
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
    workspaceKnowledgeSources,
    contextualDirectives,
    pinnedSourceIds,
    managedMemoryRecords,
    memoryDisabled,
    memoryState,
    editingMemoryId,
    editingMemoryDraft,
    memoryExportText,
    memoryStatus,
    setEditingMemoryDraft,
    toggleSourcePin,
    promoteSourceToMemory,
    startMemoryEdit,
    saveMemoryEdit,
    toggleMemoryPin,
    forgetMemory,
    toggleMemoryDisabled,
    exportMemory,
    cancelMemoryEdit,
    automationRules,
    toggleAutomation,
    lastAction,
    mobileNavOpen,
    setMobileNavOpen,
    startNewChat,
    openThread,
    setLastAction
  };
}
