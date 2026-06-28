import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  BackendConsequentialEvent,
  BackendProvider,
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorAccountOption,
  ConnectorManifest,
  ConnectorSearchItem,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  FirstWaveConnectorId,
  KnowledgeCitation,
  KnowledgeScope,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryRecord,
  PermissionMode,
  RuntimeSnapshot,
  ThreadSummary,
  WorkspaceDirective
} from "@fable/protocol";
import { assembleContext, chunkSourceText, retrieve } from "@fable/knowledge";
import {
  FIRST_WAVE_CONNECTOR_IDS,
  importFixtureConnectorItem,
  importLocalTextFile,
  listBackendProviders,
  prepareFixtureConnectorAction,
  searchFixtureConnector,
  type ToolApprovalGate,
  type LocalTextFileCandidate
} from "@fable/connectors";
import {
  DEFAULT_PERMISSION_LABEL,
  permissionLabelFor,
  permissionModeFor,
  resolveSelectedModel
} from "../lib/agent-run";
import {
  chatThreads,
  connectors,
  knowledgeSources,
  memoryRecords,
  pendingApprovals,
  projects,
  workspaceDirectives
} from "../data/workspace";
import {
  beginRuntimeConnectorOAuth,
  clearRuntimeConnectorAuth,
  clearRuntimeBackend,
  connectRuntimeBackend,
  exportRuntimeMemoryState,
  importRuntimeConnectorItem,
  importRuntimeLocalKnowledgeSource,
  listRuntimeConnectorStatuses,
  listRuntimeConnectorAccounts,
  listRuntimeBackends,
  loadRuntimeApprovalAudit,
  loadRuntimeApprovalRules,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  loadRuntimeSnapshot,
  prepareRuntimeConnectorAction,
  promoteRuntimeKnowledgeSourceToMemory,
  recordRuntimeBackendEvent,
  refreshRuntimeConnectorHealth,
  resolveRuntimeApprovalRequest,
  saveRuntimeMemoryState,
  saveRuntimeImportedKnowledgeSources,
  saveRuntimeSnapshot,
  searchRuntimeConnector,
  searchRuntimeKnowledgeSources,
  switchRuntimeConnectorAccount
} from "../runtime";
import {
  MAX_IMPORTED_KNOWLEDGE_SOURCES,
  utilityItems
} from "../lib/constants";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type WorkspacePage,
  type ApprovalModificationDraft,
  type PendingApprovalConfirmation,
  type PersistedShellState,
  type Schedule,
  type Weekday
} from "../lib/types";
import {
  importedSourceDirective,
  mergeKnowledgeSources,
  prependAuditEntry,
  readFileAsText,
  toSlug
} from "../lib/helpers";
import {
  encodeMemoryExportFallback,
  promoteKnowledgeSourceFallback,
  resolveApprovalFallback
} from "../lib/approval-fallbacks";
import {
  hasTauriRuntime,
  importLegacyShellStateOnce,
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
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  schedules: [],
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords,
  connectedBackendIds: [],
  // "" lets Fable pick the first available model; full-access mirrors the
  // composer's pre-existing default so behavior is unchanged until selected.
  selectedModelId: "",
  permissionMode: "full-access"
};

function isFirstWaveConnectorId(value: string): value is FirstWaveConnectorId {
  return (FIRST_WAVE_CONNECTOR_IDS as readonly string[]).includes(value);
}

export interface ShellRuntime {
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;
  activeUtility: string | undefined;
  activePage: WorkspacePage | null;
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
  folderInputRef: React.MutableRefObject<HTMLInputElement | null>;
  submitComposer: (event: FormEvent) => void;
  handleLocalKnowledgeFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleLocalKnowledgeFolderChange: (event: ChangeEvent<HTMLInputElement>) => void;
  triggerFolderImport: () => void;
  focusComposer: (value: string) => void;
  useDirective: (directive: WorkspaceDirective) => void;
  useConnector: (connector: ConnectorManifest) => void;
  runCommand: (command: string) => void;
  // first-wave connectors
  connectorManifests: ConnectorManifest[];
  connectorAccounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  connectorSearchResult: ConnectorSearchResult | null;
  connectorImportedSources: KnowledgeSource[];
  connectConnector: (connector: ConnectorManifest) => Promise<void>;
  disconnectConnector: (connectorId: string) => Promise<void>;
  refreshConnector: (connectorId: string) => Promise<void>;
  loadConnectorAccounts: (connectorId: string) => Promise<void>;
  switchConnectorAccount: (connectorId: string, accountId: string) => Promise<void>;
  searchConnector: (request: ConnectorSearchRequest) => Promise<void>;
  importConnectorItem: (item: ConnectorSearchItem) => Promise<void>;
  prepareConnectorAction: (
    action: ConnectorActionKind,
    payload: Record<string, string>
  ) => Promise<void>;
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
  searchKnowledge: (query: string) => Promise<void>;
  refreshKnowledgeSource: (sourceId: string) => Promise<void>;
  toggleKnowledgeSourceDisabled: (sourceId: string) => void;
  deleteKnowledgeSource: (sourceId: string) => void;
  assembleKnowledgeContext: (query: string) => Promise<string>;
  // schedules
  schedules: Schedule[];
  createSchedule: (input: { name: string; description: string; day: Weekday; time: string }) => void;
  toggleSchedule: (schedule: Schedule) => void;
  deleteSchedule: (schedule: Schedule) => void;
  // agent-runtime backends
  backendProviders: BackendProvider[];
  connectedBackendIds: string[];
  backendStatus: string | null;
  onboardingRequired: boolean;
  connectBackend: (providerId: string, secret?: string) => Promise<void>;
  disconnectBackend: (providerId: string) => Promise<void>;
  /**
   * The connected native-API backend that owns the agent loop, if any. Drives
   * the composer's model picker and the native run path. Null when no native
   * backend is connected (the composer falls back to knowledge search).
   */
  connectedNativeBackend: BackendProvider | undefined;
  /** Models the composer's model picker may offer (from the connected backend). */
  selectableModels: BackendProvider["models"];
  /** The model id that should drive the next agent run (re-validated). */
  resolvedSelectedModelId: string;
  /** Persisted model selection (raw; prefer resolvedSelectedModelId at run time). */
  selectedModelId: string;
  selectModel: (modelId: string) => void;
  /** The current permission-level label shown in the composer. */
  permissionLabel: string;
  selectPermissionLabel: (label: string) => void;
  /**
   * Record a native-API model tool call as an approval audit entry. Model tool
   * calls never auto-execute — they surface here so the existing approval UI
   * handles the grant/rule/deny decision before Fable dispatches the tool.
   */
  recordBackendToolCall: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  dismissOnboarding: () => void;
  // shell-level status
  lastAction: string;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  startNewChat: () => void;
  openThread: (thread: ThreadSummary, label: string) => void;
  setLastAction: (action: string) => void;
}

export interface UseShellRuntimeOptions {
  /**
   * The shared approval gate the agent-loop executor awaits. When provided,
   * granting/denying a tool-call approval drives the matching pending tool call
   * on the gate so the executor proceeds or refuses — the grant -> execute
   * bridge. Omit for the pre-tool-execution behavior (no dispatch).
   */
  approvalGate?: ToolApprovalGate;
}

export function useShellRuntime(options: UseShellRuntimeOptions = {}): ShellRuntime {
  const approvalGateRef = useRef<ToolApprovalGate | null>(options.approvalGate ?? null);
  approvalGateRef.current = options.approvalGate ?? null;
  const initialState = useMemo(
    () =>
      // Desktop: the runtime snapshot is the source of truth; localStorage is
      // read once for a legacy import then never again. Preview: localStorage
      // remains the sole store.
      hasTauriRuntime()
        ? importLegacyShellStateOnce(defaultShellState)
        : readPersistedShellState(defaultShellState),
    []
  );
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
  const [schedules, setSchedules] = useState<Schedule[]>(initialState.schedules);
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(initialState.pinnedSourceIds);
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    initialState.connectedBackendIds
  );
  const [importedKnowledgeSources, setImportedKnowledgeSources] = useState<LocalFileImport[]>(
    initialState.importedKnowledgeSources
  );
  const [knowledgeCitations, setKnowledgeCitations] = useState<KnowledgeCitation[]>([]);
  const [knowledgeSearchMode, setKnowledgeSearchMode] = useState("lexical-fallback");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [connectorManifests, setConnectorManifests] =
    useState<ConnectorManifest[]>(connectors);
  const [connectorAccounts, setConnectorAccounts] = useState<Record<string, ConnectorAccountOption[]>>({});
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const [connectorSearchResult, setConnectorSearchResult] =
    useState<ConnectorSearchResult | null>(null);
  const [connectorImportedSources, setConnectorImportedSources] = useState<KnowledgeSource[]>([]);
  const [preparedConnectorActions, setPreparedConnectorActions] =
    useState<ConnectorActionRequest[]>([]);
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
  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the onboarding
  // shell stays testable. `onboardingDismissed` lets users reach the preview
  // workspace without a connected backend.
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>(() =>
    listBackendProviders()
  );
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  // Composer model + permission picker selections, persisted so the next run
  // uses them. The model is re-validated against the connected backend's
  // available models before each run (see resolveSelectedModel).
  const [selectedModelId, setSelectedModelId] = useState(initialState.selectedModelId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialState.permissionMode);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const allThreads = useMemo(
    () => [...chatThreads, ...projects.flatMap((project) => project.threads)],
    []
  );
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = utilityItems.find((item) => item.label === activeItem)?.label;
  // A page view is any first-class utility page or account page. When a page
  // is active the composer is hidden and the dedicated page renders instead.
  const activePage: WorkspacePage | null =
    activeUtility === "Knowledge" ||
    activeUtility === "Schedules" ||
    activeUtility === "Connectors"
      ? (activeUtility as WorkspacePage)
      : activeItem === "Profile" || activeItem === "Settings"
        ? activeItem
      : null;
  // Chat views: the default home, a selected thread/project, or a new chat.
  const isChatView = activePage === null;
  const workspaceKnowledgeSources = useMemo(
    () =>
      mergeKnowledgeSources(hasTauriRuntime() ? [] : knowledgeSources, [
        ...connectorImportedSources,
        ...importedKnowledgeSources
      ]),
    [connectorImportedSources, importedKnowledgeSources]
  );
  // The native-API backend that owns the agent loop when one is connected. The
  // composer's model picker lists this backend's models; selecting one drives
  // request.model on the next agent run.
  const connectedNativeBackend = useMemo(
    () =>
      backendProviders.find(
        (provider) =>
          provider.backendType === "native-api" &&
          provider.authState === "connected" &&
          provider.capabilities.includes("streaming")
      ),
    [backendProviders]
  );
  const selectableModels = useMemo(
    () => connectedNativeBackend?.models ?? [],
    [connectedNativeBackend]
  );
  // The persisted selection is re-validated against the connected backend's
  // available models each render: keep it if still available, else fall back to
  // the first available model (or "" when none is available).
  const resolvedSelectedModelId = useMemo(
    () => resolveSelectedModel(selectableModels, selectedModelId),
    [selectableModels, selectedModelId]
  );
  const contextualDirectives = useMemo(
    () => [
      ...importedKnowledgeSources.slice(0, 2).map(importedSourceDirective),
      ...workspaceDirectives
    ].slice(0, 4),
    [importedKnowledgeSources]
  );
  const openApprovals = [...preparedConnectorActions.map((request) => request.approval), ...pendingApprovals]
    .filter((approval) => !dismissedApprovalIds.includes(approval.id));
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
      schedules,
      pinnedSourceIds,
      importedKnowledgeSources,
      memoryDisabled,
      memoryRecords: managedMemoryRecords,
      connectedBackendIds,
      selectedModelId,
      permissionMode
    }),
    [
      activeItem,
      approvalAudit,
      approvalRules,
      schedules,
      composerValue,
      connectedBackendIds,
      dismissedApprovalIds,
      importedKnowledgeSources,
      managedMemoryRecords,
      memoryDisabled,
      permissionMode,
      pinnedSourceIds,
      selectedModelId,
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
      setLastAction(error instanceof Error ? error.message : "Fable could not save runtime snapshot.");
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
        setSchedules(recovered.schedules);
        setPinnedSourceIds(recovered.pinnedSourceIds);
        setImportedKnowledgeSources(recovered.importedKnowledgeSources);
        setMemoryDisabled(recovered.memoryDisabled);
        setManagedMemoryRecords(recovered.memoryRecords);
        setConnectedBackendIds(recovered.connectedBackendIds);
        setSelectedModelId(recovered.selectedModelId);
        setPermissionMode(recovered.permissionMode);
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

  // Resolve agent-runtime backend auth state + capabilities from the Rust
  // credential boundary. Outside Tauri the preview registry is kept. Secrets
  // never reach this layer — only auth state and capabilities.
  useEffect(() => {
    let active = true;

    void listRuntimeConnectorStatuses().then((manifests) => {
      if (!active || !manifests) {
        return;
      }
      const runtimeById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
      setConnectorManifests((current) =>
        current.map((manifest) => runtimeById.get(manifest.id) ?? manifest)
      );
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    void listRuntimeBackends().then((providers) => {
      if (!active || !providers) {
        return;
      }

      setBackendProviders(providers);
      const connectedIds = providers
        .filter((provider) => provider.authState === "connected")
        .map((provider) => provider.id);
      setConnectedBackendIds(connectedIds);
      if (connectedIds.length > 0) {
        setOnboardingDismissed(true);
      }
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

  const triggerFolderImport = () => {
    setImportStatus("Choose a folder containing supported knowledge files.");
    folderInputRef.current?.click();
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

  const importLocalKnowledgeFile = async (file: File, sourceName = file.name) => {
    setImportStatus(`Reading ${sourceName}...`);

    try {
      const content = await readFileAsText(file);
      const candidate: LocalTextFileCandidate = {
        name: sourceName,
        content,
        sizeBytes: file.size,
        importedAt: new Date().toISOString()
      };
      const imported =
        (await importRuntimeLocalKnowledgeSource(candidate)) ?? importLocalTextFile(candidate);

      addImportedKnowledgeSource(imported);
      setImportStatus(`Imported ${imported.title}. It is pinned as untrusted knowledge.`);
      setLastAction(`Imported source: ${imported.title}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not import that file.";
      setImportStatus(message);
      setLastAction(message);
      return false;
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

  const handleLocalKnowledgeFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []).slice(
      0,
      MAX_IMPORTED_KNOWLEDGE_SOURCES
    );
    event.currentTarget.value = "";

    if (files.length === 0) {
      return;
    }

    void (async () => {
      let importedCount = 0;
      for (const file of files) {
        if (await importLocalKnowledgeFile(file, file.webkitRelativePath || file.name)) {
          importedCount += 1;
        }
      }
      setImportStatus(
        importedCount === files.length
          ? `Imported ${importedCount} files from the selected folder.`
          : `Imported ${importedCount} of ${files.length} files. Unsupported or invalid files were skipped.`
      );
    })();
  };

  const runKnowledgeSearch = async (query: string) => {
    const result = await retrieve(knowledgeRetrievalSources(), {
      query,
      scope: currentKnowledgeScope(),
      limit: 8,
      budgetChars: 6_000
    });

    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    setLastAction(
      result.citations.length > 0
        ? `Found ${result.citations.length} cited workspace sources`
        : "No matching workspace sources found"
    );
  };

  const currentKnowledgeScope = (): KnowledgeScope => {
    if (!activeThread) return { level: "global" };
    const project = projects.find((candidate) =>
      candidate.threads.some((thread) => thread.id === activeThread.id)
    );
    return {
      level: "thread",
      threadId: activeThread.id,
      projectId: project?.id ?? "workspace"
    };
  };

  const sourceIsAuthorized = (source: KnowledgeSource) =>
    source.connectorId === "local-files" ||
    connectorManifests.some(
      (connector) => connector.id === source.connectorId && connector.status === "connected"
    );

  const knowledgeRetrievalSources = () =>
    workspaceKnowledgeSources
      .filter(sourceIsAuthorized)
      .map((source) => ({
        source,
        chunks: chunkSourceText(source.contentPreview ?? "", {
          sourceId: source.id,
          mimeType: source.providerMetadata?.mimeType
        })
      }))
      .filter((record) => record.chunks.length > 0);

  const assembleKnowledgeContext = async (query: string) => {
    const result = await retrieve(knowledgeRetrievalSources(), {
      query,
      scope: currentKnowledgeScope(),
      limit: 8,
      budgetChars: 6_000
    });
    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    return assembleContext({
      runId: `run-${Date.now()}`,
      scope: currentKnowledgeScope(),
      memory: memoryDisabled ? [] : managedMemoryRecords,
      citations: result.citations,
      authorization: {
        isSourceAuthorized: (connectorId) =>
          connectorId === "local-files" ||
          connectorManifests.some(
            (connector) => connector.id === connectorId && connector.status === "connected"
          )
      }
    }).systemPrefix;
  };

  const persistLocalKnowledgeSources = (sources: LocalFileImport[]) => {
    setImportedKnowledgeSources(sources);
    void saveRuntimeImportedKnowledgeSources(sources).catch((error) => {
      setImportStatus(
        error instanceof Error ? error.message : "Fable could not save source changes."
      );
    });
  };

  const refreshKnowledgeSource = async (sourceId: string) => {
    const refreshedAt = new Date().toISOString();
    const refresh = <T extends KnowledgeSource>(sources: T[]) =>
      sources.map((source) =>
        source.id === sourceId
          ? {
              ...source,
              status: "ok" as const,
              statusMessage: undefined,
              freshness: "Reindexed just now",
              importedAt: refreshedAt
            }
          : source
      );
    const local = refresh(importedKnowledgeSources);
    persistLocalKnowledgeSources(local);
    setConnectorImportedSources((current) => refresh(current));
    setLastAction("Knowledge source reindexed");
  };

  const toggleKnowledgeSourceDisabled = (sourceId: string) => {
    const toggle = <T extends KnowledgeSource>(sources: T[]) =>
      sources.map((source) =>
        source.id === sourceId ? { ...source, disabled: !source.disabled } : source
      );
    persistLocalKnowledgeSources(toggle(importedKnowledgeSources));
    setConnectorImportedSources((current) => toggle(current));
    setPinnedSourceIds((current) => current.filter((id) => id !== sourceId));
    setLastAction("Knowledge source visibility updated");
  };

  const deleteKnowledgeSource = (sourceId: string) => {
    persistLocalKnowledgeSources(
      importedKnowledgeSources.filter((source) => source.id !== sourceId)
    );
    setConnectorImportedSources((current) =>
      current.filter((source) => source.id !== sourceId)
    );
    setPinnedSourceIds((current) => current.filter((id) => id !== sourceId));
    setLastAction("Knowledge source deleted");
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
        setMemoryStatus(error instanceof Error ? error.message : "Fable could not save memory state.");
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
      setMemoryStatus(error instanceof Error ? error.message : "Fable could not export memory.");
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
      const message = error instanceof Error ? error.message : "Fable could not approve that source into memory.";
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

  const replaceConnectorManifest = (manifest: ConnectorManifest) => {
    setConnectorManifests((current) =>
      current.map((connector) => (connector.id === manifest.id ? manifest : connector))
    );
  };

  const connectConnector = async (connector: ConnectorManifest) => {
    if (!isFirstWaveConnectorId(connector.id)) {
      setConnectorStatus(
        connector.id === "local-files"
          ? "Local Files is already available."
          : connector.setupMessage ?? `${connector.name} is not in the first connector wave.`
      );
      return;
    }

    setConnectorStatus(`Preparing ${connector.name} authorization...`);
    try {
      // Every OAuth connector runs the full loopback flow end-to-end. Public
      // Google clients call Google directly; confidential connectors route
      // exchange through the configured broker and fail closed if it is absent.
      const result = await beginRuntimeConnectorOAuth({ connectorId: connector.id });
      if (!result) {
        // Preview mode (no Tauri runtime): no live OAuth is available. Surface
        // the configured-auth-required state honestly — never claim a fixture
        // connection as live.
        const message =
          connector.status === "fixture"
            ? `${connector.name} is using explicit preview data. ${connector.setupMessage ?? "Live provider setup is required."}`
            : connector.setupMessage ?? `${connector.name} provider setup is required.`;
        setConnectorStatus(message);
        setLastAction(message);
        return;
      }
      // On a real connection, re-read the boundary so the manifest reflects the
      // live account, granted scopes, and (after refresh) provider health.
      if (result.status === "connected") {
        const refreshed = await refreshRuntimeConnectorHealth(connector.id);
        if (refreshed) {
          replaceConnectorManifest(refreshed);
        }
        await loadConnectorAccounts(connector.id);
      }
      setConnectorStatus(result.message);
      setLastAction(result.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${connector.name} authorization is unavailable.`;
      setConnectorStatus(message);
      setLastAction(message);
    }
  };

  const disconnectConnector = async (connectorId: string) => {
    const connector = connectorManifests.find((manifest) => manifest.id === connectorId);
    if (!connector || !isFirstWaveConnectorId(connectorId)) {
      return;
    }

    try {
      const manifest = await clearRuntimeConnectorAuth(connectorId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} disconnected.`);
      } else {
        setConnectorStatus(`${connector.name} fixture has no live credentials to clear.`);
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : `${connector.name} could not be disconnected.`
      );
    }
  };

  const loadConnectorAccounts = async (connectorId: string) => {
    if (!isFirstWaveConnectorId(connectorId)) return;
    try {
      const accounts = await listRuntimeConnectorAccounts(connectorId);
      if (accounts) {
        setConnectorAccounts((current) => ({ ...current, [connectorId]: accounts }));
      }
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "Connected accounts are unavailable.");
    }
  };

  const switchConnectorAccount = async (connectorId: string, accountId: string) => {
    if (!isFirstWaveConnectorId(connectorId)) return;
    try {
      const manifest = await switchRuntimeConnectorAccount(connectorId, accountId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        await loadConnectorAccounts(connectorId);
        await loadConnectorAccounts(connectorId);
        setConnectorStatus(`Using ${manifest.account?.email ?? manifest.account?.displayName ?? "selected account"}.`);
      }
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "The account could not be selected.");
    }
  };

  const refreshConnector = async (connectorId: string) => {
    const connector = connectorManifests.find((manifest) => manifest.id === connectorId);
    if (!connector || !isFirstWaveConnectorId(connectorId)) {
      return;
    }

    try {
      const manifest = await refreshRuntimeConnectorHealth(connectorId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} health refreshed.`);
      } else {
        setConnectorStatus(`${connector.name} fixture health is static preview data.`);
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : `${connector.name} health is unavailable.`
      );
    }
  };

  const searchConnector = async (request: ConnectorSearchRequest) => {
    const connector = connectorManifests.find(
      (manifest) => manifest.id === request.connectorId
    );
    setConnectorStatus(`Searching ${connector?.name ?? request.connectorId}...`);
    try {
      const result =
        (await searchRuntimeConnector(request)) ?? searchFixtureConnector(request);
      setConnectorSearchResult(result);
      setConnectorStatus(
        result.items.length > 0
          ? `Found ${result.items.length} ${result.source} result${result.items.length === 1 ? "" : "s"}.`
          : `No ${result.source} results matched.`
      );
    } catch (error) {
      setConnectorSearchResult({
        connectorId: request.connectorId,
        query: request.query,
        items: [],
        source: "live",
        searchedAt: new Date().toISOString()
      });
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector search is unavailable."
      );
    }
  };

  const importConnectorItem = async (item: ConnectorSearchItem) => {
    const request = {
      connectorId: item.connectorId,
      item,
      importedAt: new Date().toISOString()
    };

    try {
      const imported =
        (await importRuntimeConnectorItem(request)) ?? importFixtureConnectorItem(request);
      setConnectorImportedSources((current) => [
        imported.source,
        ...current.filter((source) => source.id !== imported.source.id)
      ]);
      setConnectorStatus(
        `Imported ${imported.source.title} as untrusted connector knowledge.`
      );
      setLastAction(`Imported connector source: ${imported.source.title}`);
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector import is unavailable."
      );
    }
  };

  const prepareConnectorAction = async (
    action: ConnectorActionKind,
    payload: Record<string, string>
  ) => {
    try {
      const fixtureRequest = prepareFixtureConnectorAction(action, payload);
      const prepared =
        (await prepareRuntimeConnectorAction(fixtureRequest)) ?? fixtureRequest;
      setPreparedConnectorActions((current) => [
        prepared,
        ...current.filter((request) => request.id !== prepared.id)
      ]);
      setConnectorStatus(
        `${prepared.approval.service} action prepared. Review it in Memory and approvals.`
      );
      setLastAction(`${prepared.approval.service} action needs approval`);
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector action could not be prepared."
      );
    }
  };

  // Agent-runtime backend connect/disconnect. The secret is handed to the Rust
  // credential boundary; React only ever sees the resulting auth state. Outside
  // Tauri we record a local preview connection so the onboarding gate clears
  // and the UI stays testable.
  const connectBackend = async (providerId: string, secret = "preview-connection") => {
    setBackendStatus(`Connecting ${providerId}…`);
    try {
      const stored = await connectRuntimeBackend({ providerId, secret });
      if (stored === null) {
        // Preview mode (no Tauri runtime): record a local connection only.
        setConnectedBackendIds((current) =>
          current.includes(providerId) ? current : [...current, providerId]
        );
        setBackendProviders((current) =>
          current.map((provider) =>
            provider.id === providerId ? { ...provider, authState: "connected" } : provider
          )
        );
        setBackendStatus(`${providerId} connected (preview).`);
        setLastAction(`${providerId} connected (preview)`);
        return;
      }

      // Re-read the boundary so auth state + capabilities reflect the stored
      // credential (Rust resolves it; no secret crosses back).
      const refreshed = await listRuntimeBackends();
      if (refreshed) {
        setBackendProviders(refreshed);
        setConnectedBackendIds(
          refreshed
            .filter((provider) => provider.authState === "connected")
            .map((provider) => provider.id)
        );
      }
      setBackendStatus(`${providerId} connected.`);
      setLastAction(`${providerId} connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not connect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };

  const disconnectBackend = async (providerId: string) => {
    setBackendStatus(`Disconnecting ${providerId}…`);
    try {
      const cleared = await clearRuntimeBackend(providerId);
      if (cleared === null) {
        setConnectedBackendIds((current) => current.filter((id) => id !== providerId));
        setBackendProviders((current) =>
          current.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  authState:
                    provider.backendType === "acp" ? "install-required" : "needs-auth",
                  capabilities: []
                }
              : provider
          )
        );
        setBackendStatus(`${providerId} disconnected (preview).`);
        setLastAction(`${providerId} disconnected (preview)`);
        return;
      }

      const refreshed = await listRuntimeBackends();
      if (refreshed) {
        setBackendProviders(refreshed);
        setConnectedBackendIds(
          refreshed
            .filter((provider) => provider.authState === "connected")
            .map((provider) => provider.id)
        );
      }
      setBackendStatus(`${providerId} disconnected.`);
      setLastAction(`${providerId} disconnected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not disconnect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };

  const dismissOnboarding = () => {
    setOnboardingDismissed(true);
    setLastAction("Onboarding skipped (preview)");
  };

  // Record a native-API model tool call as a backend consequential event. The
  // model wanted to run a tool; Fable records it (never auto-executes) so the
  // approval audit trail captures the request. The pre-shaped ApprovalRequest
  // is available to route through the approval UI before any tool dispatch.
  const recordBackendToolCall = (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => {
    const consequential: BackendConsequentialEvent = {
      providerId: event.approval.service,
      service: event.approval.service,
      action: event.approval.action,
      mode: event.approval.mode,
      riskLevel: event.approval.riskLevel,
      dataUsed: event.approval.dataUsed,
      consequence: event.approval.consequence,
      backendPreapproved: false
    };
    void recordRuntimeBackendEvent(consequential, new Date().toISOString()).then((entry) => {
      if (entry) {
        setApprovalAudit((current) => prependAuditEntry(current, entry));
      }
    });
    setLastAction(`Tool call from ${event.approval.service}: ${event.tool}`);
  };

  // The onboarding gate: required unless explicitly dismissed or skipped.
  const onboardingRequired = !onboardingDismissed;

  const runCommand = (command: string) => {
    const prompt = `${command} `;
    setComposerValue(prompt);
    setCommandOpen(false);
    setLastAction(`${command} command ready`);
    focusComposer(prompt);
  };

  // Composer picker bindings: the model picker drives request.model on the next
  // agent run; the permission-level picker maps its label onto a PermissionMode
  // that gates tool execution in the agent loop.
  const selectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    const chosen = selectableModels.find((model) => model.id === modelId);
    setLastAction(chosen ? `${chosen.label} selected` : "Model cleared");
  };

  const selectPermissionLabel = (label: string) => {
    setPermissionMode(permissionModeFor(label));
    setLastAction(`Permission level set to ${label}`);
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

      // Grant -> execute bridge: drive the matching pending tool call on the
      // shared approval gate so the agent-loop executor proceeds (grant) or
      // refuses (deny). Only approvals the shell registered as pending tool
      // calls are dispatched — a regular connector approval with no pending
      // entry is a no-op here. A deny never executes the tool.
      const gate = approvalGateRef.current;
      if (gate?.hasPending(approval.id)) {
        if (decision === "deny") {
          gate.resolveDeny(approval.id);
        } else if (decision === "once" || decision === "session" || decision === "rule" || decision === "modify") {
          gate.resolveGrant(approval.id);
        }
      }

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`
      );
    } catch (error) {
      setLastAction(
        error instanceof Error ? error.message : "Fable could not resolve that approval."
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

  const createSchedule = ({
    name,
    description,
    day,
    time
  }: {
    name: string;
    description: string;
    day: Weekday;
    time: string;
  }) => {
    const schedule: Schedule = {
      id: `schedule-${toSlug(name)}-${toSlug(new Date().toISOString())}`,
      name,
      description,
      day,
      time,
      enabled: true,
      createdAt: new Date().toISOString()
    };
    setSchedules((current) => [schedule, ...current]);
    setLastAction(`Schedule created: ${name}`);
  };

  const toggleSchedule = (schedule: Schedule) => {
    setSchedules((current) =>
      current.map((entry) =>
        entry.id === schedule.id ? { ...entry, enabled: !entry.enabled } : entry
      )
    );
    setLastAction(`${schedule.name} ${schedule.enabled ? "paused" : "resumed"}`);
  };

  const deleteSchedule = (schedule: Schedule) => {
    setSchedules((current) => current.filter((entry) => entry.id !== schedule.id));
    setLastAction(`Schedule deleted: ${schedule.name}`);
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
    triggerFolderImport,
    toolPickerOpen,
    commandOpen,
    importStatus,
    knowledgeCitations,
    knowledgeSearchMode,
    composerRef,
    fileInputRef,
    folderInputRef,
    submitComposer,
    handleLocalKnowledgeFileChange,
    handleLocalKnowledgeFolderChange,
    focusComposer,
    useDirective,
    useConnector,
    runCommand,
    connectorManifests,
    connectorAccounts,
    connectorStatus,
    connectorSearchResult,
    connectorImportedSources,
    connectConnector,
    disconnectConnector,
    refreshConnector,
    loadConnectorAccounts,
    switchConnectorAccount,
    searchConnector,
    importConnectorItem,
    prepareConnectorAction,
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
    searchKnowledge: runKnowledgeSearch,
    refreshKnowledgeSource,
    toggleKnowledgeSourceDisabled,
    deleteKnowledgeSource,
    assembleKnowledgeContext,
    schedules,
    createSchedule,
    toggleSchedule,
    deleteSchedule,
    backendProviders,
    connectedBackendIds,
    backendStatus,
    onboardingRequired,
    connectBackend,
    disconnectBackend,
    connectedNativeBackend,
    selectableModels,
    resolvedSelectedModelId,
    selectedModelId,
    selectModel,
    permissionLabel: permissionLabelFor(permissionMode) || DEFAULT_PERMISSION_LABEL,
    selectPermissionLabel,
    recordBackendToolCall,
    dismissOnboarding,
    lastAction,
    mobileNavOpen,
    setMobileNavOpen,
    startNewChat,
    openThread,
    setLastAction
  };
}
