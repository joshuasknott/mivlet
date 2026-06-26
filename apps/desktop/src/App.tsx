import {
  At,
  Bell,
  CaretDown,
  CaretRight,
  ChatCircle,
  Check,
  Clock,
  Database,
  DownloadSimple,
  FileText,
  FolderOpen,
  Lightning,
  MagnifyingGlass,
  Paperclip,
  PencilSimple,
  Plus,
  Power,
  PuzzlePiece,
  ShieldCheck,
  SidebarSimple,
  Sparkle,
  Stack,
  Trash,
  UploadSimple,
  Waveform,
  X
} from "@phosphor-icons/react";
import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalRequest,
  AutomationRule,
  AutomationStatus,
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
} from "@praxis/protocol";
import {
  importLocalTextFile,
  searchKnowledgeSources,
  SUPPORTED_LOCAL_FILE_EXTENSIONS,
  type LocalTextFileCandidate
} from "@praxis/connectors";
import {
  automations,
  chatThreads,
  connectors,
  knowledgeSources,
  memoryRecords,
  pendingApprovals,
  projects,
  workspaceDirectives
} from "./data/workspace";
import { PraxisLogo } from "./components/PraxisLogo";
import {
  importRuntimeLocalKnowledgeSource,
  exportRuntimeMemoryState,
  loadRuntimeApprovalAudit,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  loadRuntimeSnapshot,
  promoteRuntimeKnowledgeSourceToMemory,
  recordRuntimeApprovalDecision,
  saveRuntimeMemoryState,
  saveRuntimeSnapshot,
  searchRuntimeKnowledgeSources
} from "./runtime";

const STORAGE_KEY = "praxis.shell.v1";
const RUNTIME_SNAPSHOT_VERSION = 1 as const;
const MAX_APPROVAL_AUDIT_ENTRIES = 200;
const MAX_IMPORTED_KNOWLEDGE_SOURCES = 100;
const ACCEPTED_LOCAL_KNOWLEDGE_FILES = SUPPORTED_LOCAL_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`
).join(",");

type UtilityItem = "Knowledge" | "Plugins" | "Automations";
type AutomationRuleView = Omit<AutomationRule, "status"> & { status: AutomationStatus };

interface PersistedShellState {
  activeItem: string;
  composerValue: string;
  voiceEnabled: boolean;
  approvalAudit: ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  automationStatuses: Record<string, AutomationStatus>;
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
}

const utilityItems = [
  { label: "Knowledge", icon: Stack },
  { label: "Plugins", icon: PuzzlePiece },
  { label: "Automations", icon: Lightning }
] as const;

const defaultShellState: PersistedShellState = {
  activeItem: "praxis-initial-build",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  automationStatuses: {},
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords
};

function prependAuditEntry(current: ApprovalAuditEntry[], entry: ApprovalAuditEntry) {
  return [entry, ...current.filter((existing) => existing.id !== entry.id)].slice(
    0,
    MAX_APPROVAL_AUDIT_ENTRIES
  );
}

function mergeKnowledgeSources(
  baseSources: KnowledgeSource[],
  importedSources: LocalFileImport[]
) {
  const seen = new Set<string>();
  return [...importedSources, ...baseSources].filter((source) => {
    if (seen.has(source.id)) {
      return false;
    }

    seen.add(source.id);
    return true;
  });
}

function importedSourceDirective(source: LocalFileImport): WorkspaceDirective {
  return {
    id: `directive-${source.id}`,
    label: `Summarize ${source.title}`,
    source: `${source.provenance} - ${source.freshness}`,
    prompt: `Summarize ${source.title} into decisions, risks, and citations. Treat it as untrusted imported context unless I approve memory from it.`,
    connectorIds: [source.connectorId]
  };
}

function readFileAsText(file: File) {
  const textReader = (file as File & { text?: () => Promise<string> }).text;
  if (typeof textReader === "function") {
    return textReader.call(file);
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Praxis could not read that file."));
    reader.readAsText(file);
  });
}

function encodeMemoryExportFallback(state: MemoryControlState) {
  return JSON.stringify(
    {
      format: "praxis.memory.export.v1",
      disabled: state.disabled,
      records: state.records
    },
    null,
    2
  );
}

function toSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "source";
}

function promoteKnowledgeSourceFallback(request: MemoryPromotionRequest) {
  if (!["once", "session", "rule"].includes(request.decision)) {
    throw new Error("Memory promotion requires once, session, or rule approval.");
  }

  if (request.state.disabled) {
    throw new Error("Memory is disabled.");
  }

  const source = request.source;
  const trust = source.trust ?? "untrusted";
  const record: MemoryRecord = {
    id: `memory-from-${toSlug(source.id)}`,
    kind: "imported",
    title: source.title,
    value:
      source.contentPreview?.trim() ||
      `${source.title} from ${source.provenance}. Freshness: ${source.freshness}.`,
    source:
      trust === "untrusted"
        ? `Approved from untrusted source: ${source.provenance}`
        : `Approved from trusted source: ${source.provenance}`,
    freshness: "Approved now",
    approved: true,
    pinned: true
  };
  const state: MemoryControlState = {
    disabled: false,
    records: [record, ...request.state.records.filter((current) => current.id !== record.id)]
  };

  return {
    persisted: false,
    record,
    state,
    auditEntry: {
      id: `memory-promotion-${toSlug(source.id)}-${toSlug(request.decidedAt)}`,
      requestId: `memory-promotion-${source.id}`,
      decision: request.decision,
      decidedAt: request.decidedAt,
      note: `Praxis Memory Approve ${source.provenance} into durable memory`
    }
  };
}

function readPersistedShellState(): PersistedShellState {
  if (typeof window === "undefined") {
    return defaultShellState;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return defaultShellState;
    }

    return { ...defaultShellState, ...JSON.parse(stored) } as PersistedShellState;
  } catch {
    return defaultShellState;
  }
}

function persistShellState(state: PersistedShellState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local persistence is best-effort in preview and private browsing modes.
  }
}

function shellStateToRuntimeSnapshot(state: PersistedShellState): RuntimeSnapshot {
  return {
    version: RUNTIME_SNAPSHOT_VERSION,
    activeItem: state.activeItem,
    composerDraft: state.composerValue,
    voiceEnabled: state.voiceEnabled,
    approvalAudit: state.approvalAudit,
    dismissedApprovalIds: state.dismissedApprovalIds,
    automationStatuses: state.automationStatuses,
    pinnedSourceIds: state.pinnedSourceIds,
    importedKnowledgeSources: state.importedKnowledgeSources,
    memoryDisabled: state.memoryDisabled,
    memoryRecords: state.memoryRecords,
    savedAt: new Date().toISOString()
  };
}

function shellStateFromRuntimeSnapshot(snapshot: RuntimeSnapshot): PersistedShellState {
  return {
    ...defaultShellState,
    activeItem: snapshot.activeItem || defaultShellState.activeItem,
    composerValue: snapshot.composerDraft,
    voiceEnabled: snapshot.voiceEnabled,
    approvalAudit: snapshot.approvalAudit,
    dismissedApprovalIds: snapshot.dismissedApprovalIds,
    automationStatuses: snapshot.automationStatuses,
    pinnedSourceIds: snapshot.pinnedSourceIds,
    importedKnowledgeSources: snapshot.importedKnowledgeSources,
    memoryDisabled: snapshot.memoryDisabled,
    memoryRecords: snapshot.memoryRecords
  };
}

function ShellButton({
  children,
  pressed,
  onClick,
  label
}: {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      className="shell-button"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusDot({ tone }: { tone: "ready" | "needs-auth" | "draft" | "paused" }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}

function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function DirectiveCards({
  directives,
  onUseDirective
}: {
  directives: WorkspaceDirective[];
  onUseDirective: (directive: WorkspaceDirective) => void;
}) {
  return (
    <section className="directives" aria-label="Workspace directives">
      {directives.map((directive) => (
        <button
          className="directive-card"
          key={directive.id}
          type="button"
          onClick={() => onUseDirective(directive)}
        >
          <span className="directive-copy">
            <strong>{directive.label}</strong>
            <small>{directive.source}</small>
          </span>
        </button>
      ))}
    </section>
  );
}

function CitationResults({
  citations,
  mode
}: {
  citations: KnowledgeCitation[];
  mode: string;
}) {
  if (citations.length === 0) {
    return null;
  }

  return (
    <section className="citation-results" aria-label="Composer citations">
      <div className="citation-results__top">
        <strong>Sources used</strong>
        <span>{mode}</span>
      </div>
      <div className="citation-list">
        {citations.map((citation) => (
          <article className="citation-card" key={citation.sourceId}>
            <div>
              <strong>{citation.title}</strong>
              <small>
                {citation.provenance} - {citation.freshness} - {citation.trust}
              </small>
            </div>
            <p>{citation.snippet}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ThreadContext({ thread }: { thread?: ThreadSummary }) {
  if (!thread) {
    return null;
  }

  return (
    <section className="thread-context" aria-label="Selected thread context">
      <span>{thread.kind === "project" ? "Project thread" : "Chat"}</span>
      <strong>{thread.title}</strong>
      <p>{thread.description}</p>
      <small>{thread.updatedAt}</small>
    </section>
  );
}

function ApprovalPanel({
  approvals,
  audit,
  onDecision
}: {
  approvals: ApprovalRequest[];
  audit: ApprovalAuditEntry[];
  onDecision: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}) {
  return (
    <section className="context-panel" aria-label="Approvals and memory">
      <SectionHeading title="Approvals" meta={`${approvals.length} waiting`} />
      <div className="approval-list">
        {approvals.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={22} />
            <span>No approvals are waiting.</span>
          </div>
        ) : (
          approvals.map((approval) => (
            <article className="approval-card" key={approval.id}>
              <div>
                <span className="label-row">
                  <ShieldCheck size={18} />
                  {approval.mode}
                </span>
                <h3>{approval.action}</h3>
                <p>{approval.consequence}</p>
              </div>
              <dl className="approval-details">
                <div>
                  <dt>Service</dt>
                  <dd>{approval.service}</dd>
                </div>
                <div>
                  <dt>Data</dt>
                  <dd>{approval.dataUsed.join(", ")}</dd>
                </div>
              </dl>
              <div className="approval-actions">
                {approval.decisions.map((decision) => (
                  <button key={decision} type="button" onClick={() => onDecision(approval, decision)}>
                    {decision}
                  </button>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
      {audit.length > 0 ? (
        <div className="audit-strip" aria-label="Approval audit history">
          {audit.slice(0, 3).map((entry) => (
            <span key={entry.id}>
              {entry.decision}: {entry.note}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function KnowledgePanel({
  sources,
  memory,
  memoryDisabled,
  editingMemoryId,
  editingMemoryDraft,
  memoryExportText,
  memoryStatus,
  pinnedSourceIds,
  onTogglePin,
  onPromoteSource,
  onStartMemoryEdit,
  onUpdateMemoryDraft,
  onSaveMemoryEdit,
  onCancelMemoryEdit,
  onForgetMemory,
  onToggleMemoryPin,
  onToggleMemoryDisabled,
  onExportMemory
}: {
  sources: KnowledgeSource[];
  memory: MemoryRecord[];
  memoryDisabled: boolean;
  editingMemoryId: string | null;
  editingMemoryDraft: Pick<MemoryRecord, "title" | "value">;
  memoryExportText: string;
  memoryStatus: string;
  pinnedSourceIds: string[];
  onTogglePin: (sourceId: string) => void;
  onPromoteSource: (source: KnowledgeSource) => void;
  onStartMemoryEdit: (record: MemoryRecord) => void;
  onUpdateMemoryDraft: (draft: Pick<MemoryRecord, "title" | "value">) => void;
  onSaveMemoryEdit: (recordId: string) => void;
  onCancelMemoryEdit: () => void;
  onForgetMemory: (recordId: string) => void;
  onToggleMemoryPin: (recordId: string) => void;
  onToggleMemoryDisabled: () => void;
  onExportMemory: () => void;
}) {
  return (
    <section className="context-panel context-panel--split" aria-label="Knowledge">
      <div>
        <SectionHeading title="Sources" meta={`${sources.length} indexed`} />
        <div className="source-list">
          {sources.map((source) => {
            const pinned = pinnedSourceIds.includes(source.id);
            return (
              <article
                className={`source-row${pinned ? " source-row--pinned" : ""}`}
                key={source.id}
              >
                <FileText size={19} />
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.provenance} - {source.freshness}</small>
                </span>
                <div className="source-actions">
                  <button
                    type="button"
                    onClick={() => onTogglePin(source.id)}
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${source.title}`}
                  >
                    {pinned ? "Pinned" : "Pin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onPromoteSource(source)}
                    disabled={memoryDisabled}
                    aria-label={`Approve to memory ${source.title}`}
                  >
                    <ShieldCheck size={14} />
                    <span>Memory</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <div>
        <div className="memory-heading">
          <SectionHeading title="Memory" meta={memoryDisabled ? "disabled" : `${memory.length} saved`} />
          <div className="memory-toolbar">
            <button type="button" onClick={onExportMemory} aria-label="Export memory">
              <DownloadSimple size={15} />
              <span>Export</span>
            </button>
            <button
              type="button"
              onClick={onToggleMemoryDisabled}
              aria-label={memoryDisabled ? "Enable memory" : "Disable memory"}
            >
              <Power size={15} />
              <span>{memoryDisabled ? "Enable" : "Disable"}</span>
            </button>
          </div>
        </div>
        {memoryDisabled ? (
          <div className="memory-banner" role="status">
            Memory is disabled. Records stay local for inspection and export.
          </div>
        ) : null}
        <div className="memory-list">
          {memory.map((record) => (
            <article className="memory-row" key={record.id}>
              {editingMemoryId === record.id ? (
                <div className="memory-edit">
                  <label>
                    <span>Memory title</span>
                    <input
                      value={editingMemoryDraft.title}
                      onChange={(event) =>
                        onUpdateMemoryDraft({
                          ...editingMemoryDraft,
                          title: event.target.value
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Memory value</span>
                    <textarea
                      value={editingMemoryDraft.value}
                      onChange={(event) =>
                        onUpdateMemoryDraft({
                          ...editingMemoryDraft,
                          value: event.target.value
                        })
                      }
                    />
                  </label>
                  <div className="memory-actions">
                    <button
                      type="button"
                      onClick={() => onSaveMemoryEdit(record.id)}
                      aria-label={`Save ${record.title}`}
                    >
                      <Check size={15} />
                      <span>Save</span>
                    </button>
                    <button type="button" onClick={onCancelMemoryEdit} aria-label={`Cancel ${record.title}`}>
                      <X size={15} />
                      <span>Cancel</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="label-row">
                    <Database size={17} />
                    {record.kind}
                    {record.pinned ? " - pinned" : ""}
                  </span>
                  <strong>{record.title}</strong>
                  <p>{record.value}</p>
                  <small>{record.source} - {record.freshness}</small>
                  <div className="memory-actions">
                    <button
                      type="button"
                      onClick={() => onStartMemoryEdit(record)}
                      aria-label={`Edit ${record.title}`}
                    >
                      <PencilSimple size={15} />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleMemoryPin(record.id)}
                      aria-label={`${record.pinned ? "Unpin" : "Pin"} ${record.title}`}
                    >
                      <Stack size={15} />
                      <span>{record.pinned ? "Unpin" : "Pin"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onForgetMemory(record.id)}
                      aria-label={`Forget ${record.title}`}
                    >
                      <Trash size={15} />
                      <span>Forget</span>
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
        <p className="memory-status" aria-live="polite">
          {memoryStatus}
        </p>
        {memoryExportText ? (
          <textarea className="memory-export" aria-label="Memory export" readOnly value={memoryExportText} />
        ) : null}
      </div>
    </section>
  );
}

function PluginPanel({
  manifests,
  onUseConnector
}: {
  manifests: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
}) {
  return (
    <section className="context-panel" aria-label="Plugins">
      <SectionHeading title="Plugins" meta="bridges and permissions" />
      <div className="connector-grid">
        {manifests.map((connector) => {
          const ready = connector.status === "connected" || connector.status === "fixture";
          return (
            <article className="connector-card" key={connector.id}>
              <div className="connector-card__top">
                <span>
                  <strong>{connector.name}</strong>
                  <small>{connector.healthSummary}</small>
                </span>
                <StatusDot tone={ready ? "ready" : "needs-auth"} />
              </div>
              <div className="permission-list">
                {connector.permissions.map((permission) => (
                  <span key={permission}>{permission}</span>
                ))}
              </div>
              <button type="button" onClick={() => onUseConnector(connector)}>
                {ready ? "Use in composer" : "Prepare auth"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AutomationPanel({
  rules,
  onToggle
}: {
  rules: AutomationRuleView[];
  onToggle: (rule: AutomationRuleView) => void;
}) {
  return (
    <section className="context-panel" aria-label="Automations">
      <SectionHeading title="Automations" meta="quiet by default" />
      <div className="automation-list">
        {rules.map((rule) => (
          <article className="automation-row" key={rule.id}>
            <Clock size={19} />
            <span>
              <strong>{rule.title}</strong>
              <small>{rule.trigger} - {rule.destination}</small>
            </span>
            <span className="automation-status">
              <StatusDot tone={rule.status === "active" ? "ready" : rule.status === "paused" ? "paused" : "draft"} />
              {rule.status}
            </span>
            <button type="button" onClick={() => onToggle(rule)}>
              {rule.status === "active" ? "Pause" : "Enable"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const initialState = useMemo(readPersistedShellState, []);
  const [activeItem, setActiveItem] = useState(initialState.activeItem);
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    praxis: true,
    site: false
  });
  const [composerValue, setComposerValue] = useState(initialState.composerValue);
  const [voiceEnabled, setVoiceEnabled] = useState(initialState.voiceEnabled);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [lastAction, setLastAction] = useState("Workspace ready");
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(initialState.approvalAudit);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(initialState.dismissedApprovalIds);
  const [automationStatuses, setAutomationStatuses] = useState<Record<string, AutomationStatus>>(
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allThreads = useMemo(
    () => [...chatThreads, ...projects.flatMap((project) => project.threads)],
    []
  );
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = utilityItems.find((item) => item.label === activeItem)?.label;
  const connectorManifests: ConnectorManifest[] = connectors;
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
  const connectedCount = useMemo(
    () => connectorManifests.filter((connector) => connector.status === "fixture" || connector.status === "connected").length,
    []
  );
  const openApprovals = pendingApprovals.filter((approval) => !dismissedApprovalIds.includes(approval.id));
  const automationRules: AutomationRuleView[] = automations.map((rule) => ({
    ...rule,
    status: automationStatuses[rule.id] ?? rule.status
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
      automationStatuses,
      pinnedSourceIds,
      importedKnowledgeSources,
      memoryDisabled,
      memoryRecords: managedMemoryRecords
    }),
    [
      activeItem,
      approvalAudit,
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
      setLastAction(error instanceof Error ? error.message : "Praxis could not save runtime snapshot.");
    });
  }, [runtimeSnapshotReady, shellState]);

  useEffect(() => {
    let active = true;

    void loadRuntimeSnapshot()
      .then((snapshot) => {
        if (!active || !snapshot) {
          return;
        }

        const recovered = shellStateFromRuntimeSnapshot(snapshot);
        setActiveItem(recovered.activeItem);
        setComposerValue(recovered.composerValue);
        setVoiceEnabled(recovered.voiceEnabled);
        setApprovalAudit(recovered.approvalAudit);
        setDismissedApprovalIds(recovered.dismissedApprovalIds);
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

      setApprovalAudit(entries.slice(0, MAX_APPROVAL_AUDIT_ENTRIES));
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
      const message = error instanceof Error ? error.message : "Praxis could not import that file.";
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
        setMemoryStatus(error instanceof Error ? error.message : "Praxis could not save memory state.");
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
      setMemoryStatus(error instanceof Error ? error.message : "Praxis could not export memory.");
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
      const message = error instanceof Error ? error.message : "Praxis could not approve that source into memory.";
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

  const decideApproval = (approval: ApprovalRequest, decision: ApprovalDecision) => {
    const entry: ApprovalAuditEntry = {
      id: `${approval.id}-${decision}-${Date.now()}`,
      requestId: approval.id,
      decision,
      decidedAt: new Date().toISOString(),
      note: `${approval.service} ${approval.action}`
    };
    setApprovalAudit((current) => prependAuditEntry(current, entry));
    setDismissedApprovalIds((current) => (current.includes(approval.id) ? current : [...current, approval.id]));
    setLastAction(`${decision} recorded for ${approval.service}`);

    void recordRuntimeApprovalDecision(entry).then((runtimeEntry) => {
      if (!runtimeEntry) {
        return;
      }

      setApprovalAudit((current) => prependAuditEntry(current, runtimeEntry));
    });
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
      setActiveItem("praxis-memory");
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

  const renderWorkspaceContext = () => {
    if (activeUtility === "Knowledge") {
      return (
        <KnowledgePanel
          sources={workspaceKnowledgeSources}
          memory={managedMemoryRecords}
          memoryDisabled={memoryDisabled}
          editingMemoryId={editingMemoryId}
          editingMemoryDraft={editingMemoryDraft}
          memoryExportText={memoryExportText}
          memoryStatus={memoryStatus}
          pinnedSourceIds={pinnedSourceIds}
          onTogglePin={toggleSourcePin}
          onPromoteSource={promoteSourceToMemory}
          onStartMemoryEdit={startMemoryEdit}
          onUpdateMemoryDraft={setEditingMemoryDraft}
          onSaveMemoryEdit={saveMemoryEdit}
          onCancelMemoryEdit={() => {
            setEditingMemoryId(null);
            setEditingMemoryDraft({ title: "", value: "" });
            setMemoryStatus("Memory edit cancelled.");
          }}
          onForgetMemory={forgetMemory}
          onToggleMemoryPin={toggleMemoryPin}
          onToggleMemoryDisabled={toggleMemoryDisabled}
          onExportMemory={exportMemory}
        />
      );
    }

    if (activeUtility === "Plugins") {
      return <PluginPanel manifests={connectorManifests} onUseConnector={useConnector} />;
    }

    if (activeUtility === "Automations") {
      return <AutomationPanel rules={automationRules} onToggle={toggleAutomation} />;
    }

    if (activeItem === "praxis-memory") {
      return <ApprovalPanel approvals={openApprovals} audit={approvalAudit} onDecision={decideApproval} />;
    }

    return (
      <>
        <CitationResults citations={knowledgeCitations} mode={knowledgeSearchMode} />
        <DirectiveCards directives={contextualDirectives} onUseDirective={useDirective} />
        <ThreadContext thread={activeThread} />
      </>
    );
  };

  return (
    <main className="desktop-frame">
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic traffic--red" />
          <span className="traffic traffic--yellow" />
          <span className="traffic traffic--green" />
        </div>

        <PraxisLogo />

        <button className="mobile-nav-toggle" type="button" aria-label="Open navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}>
          <SidebarSimple size={20} />
        </button>

        <button className="new-chat-button" type="button" onClick={startNewChat}>
          <ChatCircle size={16} />
          <span>New chat</span>
          <Plus size={14} />
        </button>

        <div className="sidebar-body">
          <section className="nav-group" aria-labelledby="projects-heading">
            <button
              type="button"
              className="nav-group-heading"
              id="projects-heading"
              aria-expanded={expandedCollections.projects}
              onClick={() => setExpandedCollections((current) => ({ ...current, projects: !current.projects }))}
            >
              <span className="nav-group-title">
                <FolderOpen size={15} />
                <span>Projects</span>
              </span>
              <CaretRight className="collection-caret" size={13} weight="bold" />
            </button>
            {expandedCollections.projects ? (
              <div className="project-list">
                {projects.map((project) => {
                  const expanded = expandedProjects[project.id];
                  return (
                    <div className="project-block" key={project.id}>
                      <button
                        type="button"
                        className="project-row"
                        aria-expanded={expanded}
                        onClick={() => {
                          setExpandedProjects((current) => ({ ...current, [project.id]: !expanded }));
                          setLastAction(`${expanded ? "Collapsed" : "Expanded"} project: ${project.title}`);
                        }}
                      >
                        <CaretRight className="project-caret" size={12} weight="bold" />
                        <FolderOpen size={15} />
                        <span>{project.title}</span>
                      </button>
                      {expanded ? (
                        <div className="nested-thread-list">
                          {project.threads.map((thread) => (
                            <button
                              key={thread.id}
                              type="button"
                              className={`thread-row thread-row--nested${
                                activeItem === thread.id ? " thread-row--active" : ""
                              }`}
                              onClick={() => openThread(thread, project.title)}
                            >
                              {thread.title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="nav-group" aria-labelledby="chats-heading">
            <button
              type="button"
              className="nav-group-heading"
              id="chats-heading"
              aria-expanded={expandedCollections.chats}
              onClick={() => setExpandedCollections((current) => ({ ...current, chats: !current.chats }))}
            >
              <span className="nav-group-title">
                <ChatCircle size={15} />
                <span>Chats</span>
              </span>
              <CaretRight className="collection-caret" size={13} weight="bold" />
            </button>
            {expandedCollections.chats ? (
              <div className="thread-list">
                {chatThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                    onClick={() => openThread(thread, "chat")}
                  >
                    {thread.title}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <nav className="utility-nav" aria-label="Workspace tools">
            {utilityItems.map((item) => {
              const Icon = item.icon;
              const active = activeItem === item.label;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={`utility-row${active ? " utility-row--active" : ""}`}
                  onClick={() => {
                    setActiveItem(item.label);
                    setLastAction(`${item.label} selected`);
                  }}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className={`account-row${accountOpen ? " account-row--open" : ""}`}
            onClick={() => {
              setAccountOpen((open) => !open);
              setLastAction("Profile and settings opened");
            }}
          >
            <span className="avatar">J</span>
            <strong>Josh</strong>
            <CaretDown size={16} weight="bold" />
          </button>
          {accountOpen ? (
            <div className="account-popover" role="status">
              <span>Read-only by default</span>
              <span>{connectedCount} bridges ready</span>
              <span>{pinnedSourceIds.length} pinned sources</span>
            </div>
          ) : null}
        </div>

        {mobileNavOpen ? (
          <div className="mobile-drawer" aria-label="Mobile navigation">
            <button className="mobile-new-chat" type="button" onClick={startNewChat}>
              <ChatCircle size={16} />
              <span>New chat</span>
              <Plus size={14} />
            </button>

            <section className="mobile-drawer-section" aria-label="Projects">
              <strong>Projects</strong>
              {projects.map((project) => (
                <div className="mobile-project" key={project.id}>
                  <span>
                    <FolderOpen size={14} />
                    {project.title}
                  </span>
                  {project.threads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={`thread-row thread-row--nested${
                        activeItem === thread.id ? " thread-row--active" : ""
                      }`}
                      onClick={() => openThread(thread, project.title)}
                    >
                      {thread.title}
                    </button>
                  ))}
                </div>
              ))}
            </section>

            <section className="mobile-drawer-section" aria-label="Chats">
              <strong>Chats</strong>
              {chatThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`thread-row${activeItem === thread.id ? " thread-row--active" : ""}`}
                  onClick={() => openThread(thread, "chat")}
                >
                  {thread.title}
                </button>
              ))}
            </section>

            <nav className="mobile-utilities" aria-label="Mobile workspace tools">
              {utilityItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setActiveItem(item.label);
                      setMobileNavOpen(false);
                      setLastAction(`${item.label} selected`);
                    }}
                  >
                    <Icon size={15} />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>
        ) : null}
      </aside>

      <section className="workspace" aria-label="Praxis workspace">
        <header className="topbar">
          <button className="search-control" type="button">
            <MagnifyingGlass size={18} />
            <span>Search</span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
          <button className="notification-button" type="button" aria-label="Notifications">
            <Bell size={23} />
            <span />
          </button>
          <button className="mini-avatar" type="button" aria-label="Josh profile">
            J
          </button>
        </header>

        <div className="workspace-center">
          <section className="hero" aria-labelledby="hero-title">
            <div className="greeting">
              <Sparkle size={25} weight="regular" />
              <span>Good evening, Josh</span>
            </div>
            <h1 id="hero-title">Bring the work into one place</h1>
            <p>Ask Praxis to work with your tools, memory, and files</p>
          </section>

          <form className="composer" onSubmit={submitComposer}>
            <textarea
              ref={composerRef}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              placeholder="Ask anything, speak, attach, or run a command..."
              aria-label="Universal composer"
            />
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES}
              aria-label="Import local knowledge file"
              onChange={handleLocalKnowledgeFileChange}
            />
            <div className="composer-actions">
              <div className="composer-left-actions">
                <button
                  type="button"
                  className={`voice-chip${voiceEnabled ? " voice-chip--active" : ""}`}
                  onClick={() => {
                    setVoiceEnabled((enabled) => !enabled);
                    setLastAction(voiceEnabled ? "Voice paused" : "Voice ready");
                  }}
                >
                  <Waveform size={19} weight="bold" />
                  <span>Voice</span>
                  <CaretDown size={14} weight="bold" />
                </button>
                <ShellButton
                  label="Attach context"
                  onClick={() => {
                    setImportStatus("Choose a text, Markdown, JSON, CSV, or YAML file.");
                    fileInputRef.current?.click();
                  }}
                >
                  <Paperclip size={21} />
                  <span>Attach</span>
                </ShellButton>
                <ShellButton
                  label="Open tools"
                  pressed={toolPickerOpen}
                  onClick={() => {
                    setToolPickerOpen((open) => !open);
                    setCommandOpen(false);
                    setLastAction("Tool picker toggled");
                  }}
                >
                  <At size={21} />
                  <span>tools</span>
                </ShellButton>
                <ShellButton
                  label="Open slash commands"
                  pressed={commandOpen}
                  onClick={() => {
                    setCommandOpen((open) => !open);
                    setToolPickerOpen(false);
                    setLastAction("Command palette toggled");
                  }}
                >
                  <span className="slash">/</span>
                  <span>commands</span>
                </ShellButton>
              </div>
              <button className="send-button" type="submit" aria-label="Send prompt">
                <UploadSimple size={25} weight="bold" />
              </button>
            </div>
            {voiceEnabled ? (
              <div className="voice-state" role="status">
                Push-to-talk ready. Transcript stays local until you send it.
              </div>
            ) : null}
            {importStatus ? (
              <div className="composer-status" role="status">
                {importStatus}
              </div>
            ) : null}
            {toolPickerOpen ? (
              <div className="inline-menu" role="status">
                {connectors.slice(0, 4).map((connector) => (
                  <button key={connector.id} type="button" onClick={() => useConnector(connector)}>
                    {connector.name}
                  </button>
                ))}
              </div>
            ) : null}
            {commandOpen ? (
              <div className="inline-menu inline-menu--commands" role="status">
                {["/plan", "/goal", "/remember", "/schedule"].map((command) => (
                  <button key={command} type="button" onClick={() => runCommand(command)}>
                    {command}
                  </button>
                ))}
              </div>
            ) : null}
          </form>

          {renderWorkspaceContext()}
          <p className="sr-only" aria-live="polite">
            {lastAction}. {managedMemoryRecords.length} memory items. {workspaceKnowledgeSources.length} sources. {openApprovals.length} approvals pending.
          </p>
        </div>
      </section>
    </main>
  );
}
