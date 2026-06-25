export type PermissionMode = "read-only" | "trusted-scope" | "full-access";

export type ApprovalDecision = "once" | "session" | "rule" | "modify" | "deny";

export interface ApprovalRequest {
  id: string;
  service: string;
  action: string;
  mode: PermissionMode;
  dataUsed: string[];
  consequence: string;
  requestedAt: string;
  decisions: ApprovalDecision[];
}

export type MemoryKind = "fact" | "inference" | "preference" | "imported";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  value: string;
  source: string;
  freshness: string;
  approved: boolean;
  pinned: boolean;
}

export interface MemoryControlState {
  disabled: boolean;
  records: MemoryRecord[];
}

export type ConnectorStatus = "connected" | "needs-auth" | "unavailable" | "fixture";

export interface ConnectorManifest {
  id: string;
  name: string;
  status: ConnectorStatus;
  permissions: string[];
  healthSummary: string;
  lastCheckedAt: string;
}

export interface WorkspaceDirective {
  id: string;
  label: string;
  source: string;
  prompt: string;
  connectorIds: string[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  kind: "chat" | "project";
  description: string;
  updatedAt: string;
  pinnedContextIds: string[];
}

export interface ProjectWorkspace {
  id: string;
  title: string;
  description: string;
  threads: ThreadSummary[];
}

export type KnowledgeSourceKind = "document" | "folder" | "web" | "memory";
export type KnowledgeTrust = "trusted" | "untrusted";

export interface KnowledgeSource {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  connectorId: string;
  provenance: string;
  freshness: string;
  pinned: boolean;
  trust?: KnowledgeTrust;
  contentPreview?: string;
  contentFingerprint?: string;
  sizeBytes?: number;
  importedAt?: string;
  origin?: "fixture" | "local-import";
}

export interface LocalFileImport extends KnowledgeSource {
  kind: "document";
  connectorId: "local-files";
  trust: "untrusted";
  contentPreview: string;
  contentFingerprint: string;
  sizeBytes: number;
  importedAt: string;
  origin: "local-import";
}

export interface KnowledgeCitation {
  sourceId: string;
  title: string;
  snippet: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  pinned: boolean;
  score: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  mode: "lexical-fallback" | "hybrid";
  citations: KnowledgeCitation[];
}

export type AutomationStatus = "draft" | "active" | "paused";

export interface AutomationRule {
  id: string;
  title: string;
  trigger: string;
  destination: string;
  status: AutomationStatus;
  requiresApproval: boolean;
}

export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  decision: ApprovalDecision;
  decidedAt: string;
  note: string;
}

export interface RuntimeSnapshot {
  activeWorkspaceId: string;
  composerDraft: string;
  selectedConnectorIds: string[];
  permissionMode: PermissionMode;
  pendingApprovals: ApprovalRequest[];
  approvalAudit: ApprovalAuditEntry[];
  memory: MemoryRecord[];
  knowledge: KnowledgeSource[];
  attachedSourceIds: string[];
  connectors: ConnectorManifest[];
  directives: WorkspaceDirective[];
}
