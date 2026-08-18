export * as Spine from "./spine/index.js";
export * from "./domains/approvals.js";
export * from "./domains/account-cloud.js";
export * from "./domains/agent-runtime.js";
export * from "./domains/connectors.js";
export * from "./domains/scheduling-workflows.js";
export * from "./domains/remote-control.js";

import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalPresetLabel,
  ApprovalRequest,
  ApprovalResolutionRequest,
  ApprovalRiskLevel,
  CustomApprovalSettings,
  PermissionMode,
  PermissionProfileId
} from "./domains/approvals.js";
import type { BackendProvider, ContextRecordAuthorityScope } from "./domains/agent-runtime.js";
import type { ConnectorId, FirstWaveConnectorId } from "./domains/connectors.js";
import type { AutomationStatus, ScheduleEntry } from "./domains/scheduling-workflows.js";

export type MemoryKind = "fact" | "inference" | "preference" | "imported";

/**
 * Approval lifecycle for a memory. Suggested memories are surfaced for the
 * user to accept but never enter a run until promoted to `approved`. Only the
 * user creates durable memory; the system suggests but does not write silently.
 */
export type MemoryApprovalState = "approved" | "suggested" | "rejected";

/**
 * Origin provenance for a memory — where it came from and what produced it.
 * Carried on every promoted memory so the Knowledge page can show provenance
 * and so the context assembler can record why each memory entered a run.
 */
export interface MemoryProvenance {
  origin: "chat" | "source" | "artifact" | "run" | "manual";
  sourceId?: string;
  /** Exact Fable Connection inherited from a connector-backed source. */
  connectionId?: string;
  runId?: string;
  artifactId?: string;
  note: string;
}

export interface MemoryRecord {
  /** Explicit durable owner; legacy snapshots are assigned during migration. */
  workspaceId?: WorkspaceId;
  /** Native-canonical access facts; absent legacy records are never shared. */
  authorityScope?: ContextRecordAuthorityScope;
  id: string;
  kind: MemoryKind;
  title: string;
  value: string;
  source: string;
  freshness: string;
  approved: boolean;
  pinned: boolean;
  /**
   * Scope the memory belongs to. Defaults to global when absent. The context
   * assembler only applies memory whose scope is satisfied by the run.
   */
  scope?: KnowledgeScope;
  /** 0..1 confidence. 1 = user-confirmed; lower for inferred suggestions. */
  confidence?: number;
  /** Origin provenance. */
  provenance?: MemoryProvenance;
  /** Approval lifecycle. `approved` mirrors the boolean for back-compat. */
  approvalState?: MemoryApprovalState;
  /** Originating agent run, when promoted from a completed run. */
  runId?: string;
  /** ISO timestamp of creation. */
  createdAt?: string;
  /** ISO timestamp of last edit. */
  updatedAt?: string;
  /**
   * Forget tombstone. Present => the memory is excluded from every read path
   * (retrieval, context assembler, Knowledge page). Preferred over hard delete
   * so exclusion survives store round-trips and stays auditable.
   */
  forgottenAt?: string;
  /** Soft-disable, mirrors the disabled-source mechanism. */
  disabled?: boolean;
}

export interface MemoryControlState {
  disabled: boolean;
  records: MemoryRecord[];
}

// ---------------------------------------------------------------------------
// Fable-owned slash commands.
//
// The composer recognizes a small set of Fable-owned commands (/goal, /plan,
// /mission, /remember, /schedule). These are provider-neutral product features, not
// composer-text inserts: they create structured Fable state and submit model
// work through the resolved agent backend when required. Provider-specific
// slash commands never replace these; unknown slashes fall through to ordinary
// prompt submission unless a backend explicitly opts into passthrough.
//
// These types are wire only. Parsing, validation, redaction, and dispatch live
// in @fable/connectors; persistence + the shell live in the desktop boundary.
// ---------------------------------------------------------------------------

/** The Fable-owned commands. Provider-specific slashes never appear here. */
export type FableCommandName = "goal" | "plan" | "mission" | "remember" | "schedule" | "stop";

/** The canonical, slash-prefixed command tokens Fable owns. */
export const FABLE_COMMAND_TOKENS: readonly string[] = ["/goal", "/plan", "/mission", "/remember", "/schedule", "/stop"];

/** A parsed, validated command ready for execution. */
export interface FableCommandRequest {
  /** The canonical name without the leading slash, e.g. "remember". */
  name: FableCommandName;
  /** The raw argument text after the command token, trimmed. */
  args: string;
}

/** Outcome of parsing raw composer text into a command or a prompt. */
export type ParseCommandOutcome =
  | { status: "command"; request: FableCommandRequest }
  /** Ordinary prompt text — not a command. Submit unchanged. */
  | { status: "prompt"; text: string }
  /** A `/foo` token Fable does not own. Reserved as a seam for backend
   *  passthrough; treated as ordinary prompt text by default. */
  | { status: "unknown-command"; token: string; text: string };

/** The lifecycle status of a command execution result. */
export type FableCommandStatus = "ok" | "validation" | "rejected";

/**
 * The structured result of executing a Fable command. Carries NO secret — the
 * message is safe to surface to the UI and persist in logs/state.
 */
export interface FableCommandResult {
  name: FableCommandName;
  status: FableCommandStatus;
  /** Human-readable confirmation or error, surfaced through the shell. */
  message: string;
  /** Id of the created artifact (memory, schedule, goal, plan), when any. */
  artifactId?: string;
  /**
   * When status is "ok", an optional prompt to additionally submit to the
   * model through the resolved agent backend. Empty for pure-persistence
   * commands (e.g. /remember). Fable submits it only when a streaming backend
   * is connected.
   */
  followUpPrompt?: string;
}

/** A structured workspace goal created by /goal. Non-secret by construction. */
export interface WorkspaceGoal {
  id: string;
  title: string;
  /** The user's verbatim goal statement. */
  statement: string;
  status: "active" | "achieved" | "archived";
  createdAt: string;
  updatedAt: string;
}

/** A single step in a structured plan. */
export interface PlanStep {
  id: string;
  /** 1-based ordering. */
  order: number;
  description: string;
  done: boolean;
}

/** A structured plan created by /plan. Non-secret by construction. */
export interface WorkspacePlan {
  id: string;
  /** Optional link to the goal this plan decomposes. */
  goalId?: string;
  title: string;
  steps: PlanStep[];
  status: "draft" | "in-progress" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPromotionRequest {
  source: KnowledgeSource;
  decision: ApprovalDecision;
  decidedAt: string;
  state: MemoryControlState;
}

export interface MemoryPromotionResponse {
  persisted: boolean;
  record: MemoryRecord;
  auditEntry: ApprovalAuditEntry;
  state: MemoryControlState;
}

export type ConnectorStatus =
  | "fixture"
  | "needs-auth"
  | "unconfigured"
  | "configured"
  | "connected"
  | "expired"
  | "revoked"
  | "provider-error"
  | "error"
  | "unavailable";

export type ConnectorAuthMode =
  | "none"
  | "fixture"
  | "oauth-pkce"
  | "oauth-broker"
  | "provider-installation";

export type ConnectorPermissionAccess = "read" | "write";

export interface ConnectorPermission {
  id: string;
  label: string;
  access: ConnectorPermissionAccess;
  required: boolean;
  granted: boolean;
}

export type ConnectorHealthState = "healthy" | "degraded" | "error" | "unknown";

export interface ConnectorHealth {
  state: ConnectorHealthState;
  summary: string;
  checkedAt: string;
  retryAfter?: string;
}

export type ConnectorSyncPhase =
  | "idle"
  | "syncing"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export type ConnectorSyncTrigger = "manual" | "background" | "retry";

export type ConnectorSyncFailureKind =
  | "auth-required"
  | "permission-denied"
  | "provider-unavailable"
  | "rate-limited"
  | "partial-sync"
  | "cancelled";

export interface ConnectorSyncFailure {
  kind: ConnectorSyncFailureKind;
  message: string;
  retryable: boolean;
  retryAfter?: string;
}

export interface ConnectorSyncState {
  connectorId: ConnectorId;
  workspaceId: string;
  phase: ConnectorSyncPhase;
  trigger?: ConnectorSyncTrigger;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  lastSuccessfulAt?: string;
  nextRetryAt?: string;
  cursor?: string;
  itemsProcessed: number;
  staleTokenRecovered: boolean;
  failure?: ConnectorSyncFailure;
}

export interface ConnectorSyncRequest {
  connectorId: FirstWaveConnectorId;
  workspaceId: string;
  trigger?: ConnectorSyncTrigger;
}

export interface ConnectorAccountSummary {
  /** Opaque Fable Connection reference; never a raw provider account id. */
  id: string;
  displayName: string;
  handle?: string;
  email?: string;
  workspace?: string;
  avatarUrl?: string;
}

export interface ConnectorAccountOption {
  /** Stable workspace-bound Fable Connection id; provider ids never authorize selection. */
  connectionId: string;
  account: ConnectorAccountSummary;
  active: boolean;
  lifecycle: import("./spine/connections.js").ConnectionLifecycleState;
  authorizationState: import("./spine/connections.js").ConnectionAuthorizationState;
  healthState: import("./spine/connections.js").ConnectionHealthState;
  credentialCustody: import("./spine/connections.js").CredentialCustodyKind;
  credentialState: import("./spine/connections.js").CredentialBindingState;
}

export interface ConnectorManifest {
  id: ConnectorId;
  name: string;
  status: ConnectorStatus;
  permissions: string[];
  healthSummary: string;
  lastCheckedAt: string;
  authMode?: ConnectorAuthMode;
  scopes?: ConnectorPermission[];
  health?: ConnectorHealth;
  sync?: ConnectorSyncState;
  account?: ConnectorAccountSummary;
  setupMessage?: string;
  supportsSearch?: boolean;
  supportsImport?: boolean;
  supportedActions?: ConnectorActionKind[];
  /**
   * Optional backend facet. When present, this connector entry surfaces an
   * agent-runtime AI backend (Codex, Cursor, Copilot, Grok) whose auth state
   * and capabilities are owned by the Rust credential boundary. The frontend
   * only ever sees `authState` and `capabilities` — never raw tokens.
   */
  backend?: BackendProvider;
}

export type ConnectorItemKind =
  | "repository"
  | "branch"
  | "issue"
  | "pull-request"
  | "file"
  | "project"
  | "deployment"
  | "page"
  | "database"
  | "message"
  | "conversation"
  | "calendar"
  | "event";

export interface ConnectorSearchRequest {
  connectorId: FirstWaveConnectorId;
  query: string;
  limit?: number;
  cursor?: string;
}

export interface ConnectorSearchItem {
  id: string;
  connectorId: FirstWaveConnectorId;
  /**
   * Exact Fable Connection that produced this result. Native search stamps this
   * value from authenticated selection evidence; imports reject a changed or
   * missing selection rather than guessing from the provider family.
   */
  connectionId?: string;
  title: string;
  kind: ConnectorItemKind;
  summary: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  url?: string;
  contentPreview?: string;
  providerMetadata: Record<string, string>;
}

export interface ConnectorSearchResult {
  connectorId: FirstWaveConnectorId;
  query: string;
  items: ConnectorSearchItem[];
  nextCursor?: string;
  source: "fixture" | "live";
  searchedAt: string;
}

export interface ConnectorImportRequest {
  connectorId: FirstWaveConnectorId;
  item: ConnectorSearchItem;
  importedAt: string;
}

export interface ConnectorImportResult {
  source: KnowledgeSource;
  imported: boolean;
}

export type ConnectorActionKind =
  | "github.draft-pull-request"
  | "github.comment"
  | "vercel.promote"
  | "vercel.rollback"
  | "github.create-issue"
  | "github.update-issue"
  | "github.create-review"
  | "github.update-file"
  | "github.create-branch"
  | "github.dispatch-workflow"
  | "vercel.create-deployment"
  | "vercel.cancel-deployment"
  | "vercel.update-project"
  | "vercel.create-domain"
  | "vercel.update-domain"
  | "vercel.delete-domain"
  | "linear.create-issue"
  | "linear.update-issue"
  | "linear.comment"
  | "google-drive.create-file"
  | "google-drive.update-file"
  | "google-drive.move-file"
  | "google-drive.rename-file"
  | "google-drive.share-file"
  | "google-drive.delete-file"
  | "gmail.create-draft"
  | "gmail.send"
  | "slack.create-draft"
  | "slack.post"
  | "slack.reply"
  | "slack.edit"
  | "slack.delete"
  | "slack.react-add"
  | "slack.react-remove"
  | "notion.create-page"
  | "notion.update-page"
  | "notion.append-blocks"
  | "notion.update-block"
  | "notion.delete-block"
  | "notion.create-comment"
  | "notion.create-entry"
  | "google-calendar.create-draft"
  | "google-calendar.update-draft"
  | "google-calendar.cancel-event"
  | "google-calendar.delete-event";

export interface ConnectorActionRequest {
  id: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  payload: Record<string, string>;
  permissionMode?: PermissionMode;
  permissionProfile?: PermissionProfileId;
  approval: ApprovalRequest;
}

export type ConnectorActionResultStatus =
  | "unavailable"
  | "denied"
  | "approved"
  | "failed"
  | "completed";

export interface ConnectorActionResult {
  requestId: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  status: ConnectorActionResultStatus;
  message: string;
  providerResourceId?: string;
}

export type BrowserSessionLifecycle =
  | "unavailable"
  | "starting"
  | "active"
  | "expired"
  | "closed"
  | "failed";

export type BrowserSessionSource = "live" | "fixture-preview";

/**
 * Browser/session metadata that is safe to keep in the shell process. It never
 * carries cookies, tokens, screenshots, DOM dumps, page text, clipboard data,
 * localStorage/sessionStorage, or any hidden browser state.
 */
export interface BrowserSessionState {
  id: string;
  source: BrowserSessionSource;
  lifecycle: BrowserSessionLifecycle;
  connectorIds: ConnectorId[];
  startedAt?: string;
  expiresAt?: string;
  closedAt?: string;
  failedAt?: string;
  reason: string;
  fixtureOnly: boolean;
}

export type ConnectorErrorCode =
  | "configuration-required"
  | "needs-auth"
  | "expired-auth"
  | "permission-denied"
  | "rate-limited"
  | "provider-unavailable"
  | "not-found"
  | "invalid-request"
  | "approval-required"
  | "unknown";

export interface ConnectorError {
  code: ConnectorErrorCode;
  connectorId: ConnectorId;
  message: string;
  retryable: boolean;
  retryAfter?: string;
}

export interface ConnectorAuthRequest {
  connectorId: FirstWaveConnectorId;
  redirectUri?: string;
  /** Authorization callback URL, or the provider-returned code when completing OAuth. */
  callbackUrl?: string;
  /** Optional declared scope set for an explicit reconnect; active grants come from the provider response. */
  requestedScopes?: string[];
}

export interface ConnectorAuthResult {
  connectorId: FirstWaveConnectorId;
  status: ConnectorStatus;
  authorizationUrl?: string;
  account?: ConnectorAccountSummary;
  message: string;
}

export interface ConnectorTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
  scopes: string[];
}

export type ConnectorCapabilityKind = "read" | "write";

export interface ConnectorCapability {
  id: string;
  kind: ConnectorCapabilityKind;
  consequential: boolean;
  description: string;
}

export interface ConnectorPage<T> {
  items: T[];
  nextCursor?: string;
  rateLimit?: {
    remaining?: number;
    resetAt?: string;
    retryAfterMs?: number;
  };
}

export interface ConnectorApprovalRecord {
  id: string;
  connectorId: ConnectorId;
  accountId: string;
  proposedAction: string;
  target: string;
  preview: string;
  riskLevel: ApprovalRiskLevel;
  result: "pending" | "approved" | "denied" | "completed" | "failed";
  requestId: string;
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  actor: "user" | "system";
  runId?: string;
  errorCode?: ConnectorErrorCode;
  actionFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Connector cache.
//
// A searchable, workspace-isolated, secret-free local cache for synced
// connector data. Cached rows are normalized provider items scoped to a
// workspace so workspaces never cross-pollinate. Provider secrets/tokens never
// reach the cache: the Rust write path redacts token-shaped values and fails
// closed when a secret marker survives. These are wire-only types; persistence
// and lifecycle live in the Rust runtime boundary.
// ---------------------------------------------------------------------------

/** The trust vocabulary mirrored from knowledge sources for cached items. */
export type ConnectorCacheTrust = "trusted" | "untrusted" | "verified";

/** Compatibility workspace id; command callers must still pass it explicitly. */
export const CONNECTOR_CACHE_DEFAULT_WORKSPACE_ID = "default";

/**
 * A single cached connector item. Carries no secret material: titles,
 * provenance, previews, and metadata are redacted before they are sealed.
 */
export interface CachedConnectorItem {
  id: string;
  workspaceId: string;
  connectorId: ConnectorId;
  providerItemId: string;
  kind: string;
  trust: ConnectorCacheTrust;
  pinned: boolean;
  disabled: boolean;
  contentFingerprint: string;
  cachedAt: string;
  origin: string;
  title: string;
  provenance: string;
  freshness: string;
  contentPreview: string;
  account: string;
  providerMetadata: Record<string, unknown>;
}

/** Scope of a cache-settings row: a workspace-wide default or a per-connector override. */
export type ConnectorCacheSettingsScope = "workspace" | "connector";

/**
 * Effective cache settings for a `(workspaceId, connectorId)` pair. A connector
 * override wins over the workspace default, which wins over the built-in
 * default (`enabled = true`, `autoSync = false`).
 */
export interface ConnectorCacheSettings {
  workspaceId: string;
  connectorId: string;
  scope: ConnectorCacheSettingsScope;
  /** When false, the cache neither writes nor reads for this scope. */
  enabled: boolean;
  /** When true, a background resync may run for this scope. */
  autoSync: boolean;
  updatedAt: string;
  note: string;
}

/** Input for writing/refreshing a single cached connector item. */
export interface CacheConnectorItemRequest {
  workspaceId: string;
  /** A provider-shaped item (search result / import) to cache. */
  item: Record<string, unknown>;
}

/** Input for toggling a cached item's disabled flag. */
export interface SetConnectorCacheItemDisabledRequest {
  workspaceId: string;
  id: string;
  disabled: boolean;
}

/** Input for clearing a workspace's cache (optionally one connector). */
export interface ClearConnectorCacheRequest {
  workspaceId: string;
  /** When set, only this connector's cached rows are cleared. */
  connectorId?: ConnectorId;
  /** When true, also drop the per-workspace/per-connector settings rows. */
  includeSettings?: boolean;
}

/** Input for marking a workspace/connector's cache freshly resynced. */
export interface ResyncConnectorCacheRequest {
  workspaceId: string;
  connectorId?: ConnectorId;
}

/** Input for reading effective cache settings. */
export interface GetConnectorCacheSettingsRequest {
  workspaceId: string;
  connectorId: ConnectorId;
}

/** Input for upserting cache settings. Empty `connectorId` sets the workspace default. */
export interface SetConnectorCacheSettingsRequest {
  workspaceId: string;
  connectorId: ConnectorId;
  enabled: boolean;
  autoSync?: boolean;
  note?: string;
}

/** Input for deleting a cache settings row (restores the lower-precedence default). */
export interface DeleteConnectorCacheSettingsRequest {
  workspaceId: string;
  connectorId: ConnectorId;
}

/** Credential-free export of a workspace's cached connector data. */
export interface ConnectorCacheExport {
  workspaceId: string;
  connectorId?: ConnectorId;
  credentialsIncluded: false;
  disabledItemsIncluded: true;
  items: CachedConnectorItem[];
  settings: ConnectorCacheSettings[];
}

export interface WorkspaceDirective {
  id: string;
  label: string;
  source: string;
  prompt: string;
  connectorIds: string[];
}

/** Stable local ownership identifiers. They are opaque and never recycled. */
export type WorkspaceId = string;
export type ProjectId = string;

/** Explicit persistence scope. A missing project means workspace-owned data. */
export interface DataScope {
  workspaceId: WorkspaceId;
  projectId?: ProjectId;
}

export interface WorkspaceRecord {
  id: WorkspaceId;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: ProjectId;
  workspaceId: WorkspaceId;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * Scope bounds for sources, memory, and pinned context. Retrieval and the
 * context assembler never leak material from a tighter scope into a looser one
 * (a thread-scoped memory is not applied to a global run). `global` is the
 * backward-compatible default for everything that predates scoped knowledge.
 */
export type KnowledgeScopeLevel = "global" | "project" | "thread";

export interface KnowledgeScope {
  level: KnowledgeScopeLevel;
  projectId?: string;
  threadId?: string;
}

export const GLOBAL_SCOPE: KnowledgeScope = { level: "global" };

/**
 * Lifecycle/health of an indexed source. Used by the ingestion pipeline and
 * the Knowledge page to surface indexing / failed / stale states without a
 * separate metrics dashboard. All additive — sources created before this field
 * default to "ok".
 */
export type SourceStatus = "ok" | "indexing" | "stale" | "error";

export interface KnowledgeSource {
  /** Explicit durable owner; legacy snapshots are assigned during migration. */
  workspaceId?: WorkspaceId;
  /** Native-canonical access facts; absent legacy records are never shared. */
  authorityScope?: ContextRecordAuthorityScope;
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
  origin?: "fixture" | "local-import" | "connector-import";
  providerMetadata?: Record<string, string>;
  /**
   * Original filesystem path (sanitized, boundary-relative) the source was
   * imported from. Preserved across reindex so renames/moves are detectable
   * without relying solely on content hashing. Optional — legacy/fixture
   * sources omit it.
   */
  sourcePath?: string;
  /** Resolved media/MIME type of the imported content (e.g. text/markdown). */
  mediaType?: string;
  /** Last-modified timestamp of the originating file/content (ISO). */
  modifiedAt?: string;
  /**
   * Scope the source belongs to. Defaults to global when absent (the
   * pre-scope behavior). Drives retrieval + pinned-context bounding.
   */
  scope?: KnowledgeScope;
  /** Connector account provenance, when the source came from a connected account. */
  account?: string;
  /** Exact Fable Connection that authorized this source, when applicable. */
  connectionId?: string;
  /** True once chunks have been produced (and, when configured, embedded). */
  embeddingReady?: boolean;
  /** 0..1 connector/local trust weight used in retrieval ranking. */
  authority?: number;
  /** Soft-disable / exclusion flag. Disabled sources never enter a run. */
  disabled?: boolean;
  /** Minimal deletion tombstone retained to prevent routine resurrection. */
  deletedAt?: string;
  /** Lifecycle/health state surfaced in the Knowledge page. */
  status?: SourceStatus;
  /** Optional message describing a failed/stale state for the UI. */
  statusMessage?: string;
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

export interface RefreshLocalKnowledgeSourceRequest {
  sourceId: string;
  expectedContentFingerprint: string;
  file: {
    name: string;
    content: string;
    sizeBytes: number;
    selectedAt: string;
    modifiedAt?: string;
  };
}

export interface LocalKnowledgeRefreshResponse {
  outcome: "updated" | "unchanged";
  source: LocalFileImport;
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
  /**
   * Stable id of the cited chunk, when the citation came from chunked
   * retrieval. Lets the UI/inspector resolve an excerpt to an exact location.
   */
  chunkId?: string;
  /** Connector account the source came from, when applicable. */
  account?: string;
  /** Exact Fable Connection that authorized the cited source. */
  connectionId?: string;
  /** The basis for the citation's score — never hidden from the user. */
  ranking?: CitationRanking;
  /** Original path of the cited source, when known (provenance metadata). */
  sourcePath?: string;
  /** Media type of the cited source, when known (provenance metadata). */
  mediaType?: string;
  /** Effective scope of the cited source at retrieval time. */
  scope?: KnowledgeScope;
}

/**
 * The score components behind a citation, surfaced so the user can see *why*
 * something entered context without exposing internal chain-of-thought.
 */
export interface CitationRanking {
  relevance: number;
  recency: number;
  authority: number;
  pin: number;
  feedback: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  mode: "lexical-fallback" | "hybrid";
  citations: KnowledgeCitation[];
}

// ---------------------------------------------------------------------------
// Knowledge & memory domain (additive).
//
// The chunk/ingestion/memory/context/artifact records below extend the existing
// source/memory types so the local-first foundations keep working unchanged.
// Every new field on an existing interface is optional, so a v1 runtime
// snapshot still loads. See docs/superpowers/specs/2026-06-28-knowledge-memory-design.md.
// ---------------------------------------------------------------------------

/**
 * A structure-aware slice of a source. Chunk ids are stable
 * (`${sourceId}#${ordinal}`) so citations resolve to a durable location, and
 * each chunk carries its own content hash for dedup across reindex.
 */
export interface SourceChunk {
  workspaceId?: WorkspaceId;
  id: string;
  sourceId: string;
  ordinal: number;
  text: string;
  contentHash: string;
  /** Nearest heading, when the source was chunked by structure (e.g. Markdown). */
  heading?: string;
  charStart: number;
  charEnd: number;
  /** Present when an embedding provider ran on this chunk. */
  embedding?: number[];
  embeddingModel?: string;
}

export interface SourceRecord {
  source: KnowledgeSource;
  chunks: SourceChunk[];
}

/**
 * Bounded outcome of ingesting one candidate. The pipeline never throws for
 * ordinary problems — unsupported, malformed, binary, oversized, or
 * inaccessible inputs surface as a `skipped` outcome the caller can show.
 */
export type IngestionOutcome =
  | { kind: "created"; source: KnowledgeSource; chunks: SourceChunk[] }
  | {
      kind: "updated";
      source: KnowledgeSource;
      chunks: SourceChunk[];
      previousFingerprint: string;
    }
  | { kind: "unchanged"; source: KnowledgeSource }
  | { kind: "skipped"; reason: SkipReason; detail: string };

export type SkipReason =
  | "unsupported-type"
  | "oversized"
  | "empty"
  | "malformed"
  | "binary"
  | "inaccessible"
  | "too-many-files"
  | "path-escape";

/**
 * A memory the system thinks is worth keeping, surfaced for explicit approval.
 * Suggestions NEVER write durable memory on their own — only `approve` does.
 * Duplicate-of / contradiction-with point at existing memory ids so the UI can
 * show the relationship without nested dashboards.
 */
export interface MemorySuggestion {
  id: string;
  title: string;
  value: string;
  kind: MemoryKind;
  provenance: MemoryProvenance;
  confidence: number;
  duplicateOfId?: string;
  contradictsId?: string;
}

export interface MemoryRetentionResult {
  prunedIds: string[];
  reasons: Record<string, "stale" | "superseded" | "low-confidence">;
}

/**
 * A user-selected source or memory kept always-available within a scope.
 * Pinned context is resolved by the context assembler before retrieval, so a
 * pinned item enters a run deterministically even when it would not rank.
 */
export interface PinnedContextEntry {
  workspaceId?: WorkspaceId;
  id: string;
  scope: KnowledgeScope;
  sourceId?: string;
  memoryId?: string;
  pinnedAt: string;
}

/**
 * Temporary context associated with a thread, project, or run. Captured during
 * assembly so the same run can be inspected/cited; it is not durable memory.
 */
export interface WorkingContext {
  runId: string;
  scope: KnowledgeScope;
  messageIds: string[];
  retrievedCitationIds: string[];
  memoryIds: string[];
  toolResultIds: string[];
  createdAt: string;
}

/**
 * Useful output produced by completed work, saved with provenance and a link
 * back to the originating run. Artifacts are first-class knowledge citizens
 * that can be promoted into memory.
 */
export interface Artifact {
  workspaceId?: WorkspaceId;
  id: string;
  title: string;
  kind: "document" | "code" | "summary" | "other";
  content: string;
  provenance: { runId: string; createdAt: string; sourceIds: string[] };
  scope?: KnowledgeScope;
  pinned?: boolean;
}

// ---------------------------------------------------------------------------
// Connector-source contract.
//
// A provider-agnostic ingestion contract: any connector branch (local-files or
// a future first-wave connector) implements this interface so the knowledge
// pipeline can ingest its content uniformly. The knowledge package depends on
// this interface only — never on a connector implementation.
// ---------------------------------------------------------------------------

/**
 * A connector-supplied candidate for ingestion. `externalId` is stable within
 * the connector; `content` is already-extracted text (empty when extraction
 * failed or the file is binary, which the pipeline turns into a bounded skip).
 */
export interface ConnectorSourceCandidate {
  externalId: string;
  title: string;
  mimeType: string;
  content: string;
  sizeBytes: number;
  fetchedAt: string;
  account?: string;
  /** Exact Fable Connection that authorized the candidate. */
  connectionId?: string;
  providerMetadata?: Record<string, string>;
  /**
   * Boundary-relative path within the connector/import root. Local-files sets
   * this to the sanitized relative path so renames/moves are tracked. Optional.
   */
  sourcePath?: string;
  /** Last-modified timestamp of the originating content (ISO), when known. */
  modifiedAt?: string;
  /** Scope the candidate should be ingested into. Defaults to global. */
  scope?: KnowledgeScope;
}

/**
 * Implemented by a connector (local-files or any first-wave connector branch).
 * The knowledge ingestion pipeline iterates `listSources()` and turns each
 * candidate into a `SourceRecord` via the shared ingestion path.
 */
export interface ConnectorSourceProvider {
  readonly connectorId: ConnectorId;
  listSources():
    | AsyncIterable<ConnectorSourceCandidate>
    | ConnectorSourceCandidate[];
}

// ---------------------------------------------------------------------------
// Browser automation foundation.
//
// Browser actions are proposals bound to an agent run and a browser session.
// These types carry only non-secret action metadata. Page contents, cookies,
// tokens, DOM dumps, screenshots, clipboard contents, and hidden browser state
// must not be represented here or persisted in audit detail.
// ---------------------------------------------------------------------------

export type BrowserAutomationActionKind =
  | "browser.read-url"
  | "browser.read-title"
  | "browser.navigate"
  | "browser.click"
  | "browser.type"
  | "browser.select"
  | "browser.submit"
  | "browser.download"
  | "browser.upload"
  | "browser.screenshot"
  | "browser.clipboard-read"
  | "browser.clipboard-write";

export type BrowserAutomationActionStatus =
  | "unavailable"
  | "safe/read-only"
  | "approval-required"
  | "denied"
  | "approved"
  | "failed"
  | "completed";

export type BrowserAutomationFailureCode =
  | "transport-unavailable"
  | "unsupported-action"
  | "stale-action"
  | "replayed-action"
  | "cross-session"
  | "cross-run"
  | "permission-denied"
  | "approval-required"
  | "approval-denied"
  | "approval-missing"
  | "execution-failed";

export interface BrowserAutomationSession {
  id: string;
  runId: string;
  state: "active" | "expired" | "closed";
  createdAt: string;
  expiresAt: string;
  permissionMode: PermissionMode;
  permissionProfile?: PermissionProfileId;
}

export interface BrowserAutomationActionRequest {
  id: string;
  runId: string;
  sessionId: string;
  action: BrowserAutomationActionKind | (string & {});
  requestedAt: string;
  targetLabel?: string;
  pageOrigin?: string;
  arguments?: Record<string, unknown>;
}

export interface BrowserAutomationActionDecision {
  requestId: string;
  runId: string;
  sessionId: string;
  action: string;
  status: BrowserAutomationActionStatus;
  riskLevel: ApprovalRiskLevel;
  mode: PermissionMode;
  permissionProfile?: PermissionProfileId;
  approval?: ApprovalRequest;
  failureCode?: BrowserAutomationFailureCode;
  message: string;
}

export interface RuntimeSnapshot {
  version: 1;
  activeItem: string;
  composerDraft: string;
  voiceEnabled: boolean;
  approvalAudit: ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: ApprovalGrant[];
  automationStatuses: Record<string, AutomationStatus>;
  /**
   * User-created schedules. Non-secret state persisted through the snapshot so
   * it survives a desktop restart (the snapshot is the source of truth for
   * non-secret state in Tauri). LocalStorage carries them in preview only.
   */
  schedules: ScheduleEntry[];
  /**
   * Structured workspace goals created by /goal. Non-secret state persisted
   * through the snapshot so it survives a desktop restart.
   */
  goals: WorkspaceGoal[];
  /**
   * Structured workspace plans created by /plan. Non-secret state persisted
   * through the snapshot so it survives a desktop restart.
   */
  plans: WorkspacePlan[];
  /** User-defined agent identities and their non-secret execution preferences. */
  agents?: FableAgentProfile[];
  /** The agent currently owning the conversation surface. */
  activeAgentId?: string;
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
  /**
   * Provider ids of connected agent-runtime backends. Credentials themselves
   * never live here — this only records *which* backends were connected so the
   * Rust boundary can re-resolve their auth state on recovery.
   */
  connectedBackendIds: string[];
  /**
   * The model id last chosen in the composer's model picker, so the same model
   * drives the next agent run. Re-validated against the connected backend's
   * available models before use (empty string = let Fable pick).
   */
  selectedModelId: string;
  /**
   * The composer's permission level, driving how the agent loop gates tool
   * approvals (read-only suppresses write/shell tool calls, etc.).
   */
  permissionMode: PermissionMode;
  permissionProfile?: PermissionProfileId;
  /**
   * Selected approval preset label. Optional so older snapshots round-trip;
   * tracked separately so Custom can stay visible even when it resolves to the
   * same internal mode as another preset.
   */
  permissionLabel?: ApprovalPresetLabel;
  /**
   * Plain-language custom approval preferences. These carry only user
   * preferences and resolve to an existing PermissionMode before execution.
   */
  customApprovalSettings?: CustomApprovalSettings;
  savedAt: string;
}

export type FableAgentIcon = "agent";

/**
 * A user-owned agent. Instructions and selections are non-secret; provider
 * credentials remain in the native credential boundary.
 */
export interface FableAgentProfile {
  id: string;
  name: string;
  instructions: string;
  modelId: string;
  icon: FableAgentIcon;
  /** Hex colour used by the shared agent mark when no custom image is set. */
  iconColor: string;
  /** Locally uploaded, normalized image. Remote URLs are deliberately unsupported. */
  iconImageDataUrl?: string;
  connectorIds: string[];
  knowledgeSourceIds: string[];
  permissionLabel: ApprovalPresetLabel;
  threadId?: string;
}
