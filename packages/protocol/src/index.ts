export type PermissionMode = "read-only" | "trusted-scope" | "full-access";

export type ApprovalDecision = "once" | "session" | "rule" | "modify" | "deny";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalGrantScope = "session" | "rule";

export interface ApprovalRequest {
  id: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  requestedAt: string;
  decisions: ApprovalDecision[];
  confirmationPhrase?: string;
}

export interface ApprovalModification {
  mode: PermissionMode;
  dataUsed: string[];
  consequence: string;
}

export interface ApprovalGrant {
  id: string;
  requestId: string;
  scope: ApprovalGrantScope;
  service: string;
  action: string;
  mode: PermissionMode;
  dataUsed: string[];
  createdAt: string;
}

export interface ApprovalResolutionRequest {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: string;
  confirmationText?: string;
  modification?: ApprovalModification;
}

export interface ApprovalResolutionResponse {
  persisted: boolean;
  auditEntry: ApprovalAuditEntry;
  effectiveRequest: ApprovalRequest;
  dismissed: boolean;
  grant?: ApprovalGrant;
}

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
  runId?: string;
  artifactId?: string;
  note: string;
}

export interface MemoryRecord {
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

export type FirstWaveConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar"
  | "linear";

export type ConnectorId = "local-files" | FirstWaveConnectorId | (string & {});

export type ConnectorStatus =
  | "fixture"
  | "needs-auth"
  | "configured"
  | "connected"
  | "expired"
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

export interface ConnectorAccountSummary {
  id: string;
  displayName: string;
  handle?: string;
  email?: string;
  workspace?: string;
  avatarUrl?: string;
}

export interface ConnectorAccountOption {
  account: ConnectorAccountSummary;
  active: boolean;
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
  approval: ApprovalRequest;
}

export type ConnectorActionResultStatus =
  | "awaiting-approval"
  | "executed"
  | "denied"
  | "configuration-required";

export interface ConnectorActionResult {
  requestId: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  status: ConnectorActionResultStatus;
  message: string;
  providerResourceId?: string;
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
  /** Optional incremental subset of the connector's declared OAuth scopes. */
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
  result: "pending" | "approved" | "denied" | "executed" | "failed";
  requestId: string;
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  actor: "user" | "system";
  runId?: string;
  errorCode?: ConnectorErrorCode;
  actionFingerprint?: string;
}

export type AgentRunStatus =
  | "queued"
  | "streaming"
  | "awaiting-approval"
  | "retrying"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface PersistedAgentExchange {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  ok?: boolean;
}

export interface PersistedAgentRun {
  id: string;
  providerId: string;
  model: string;
  status: AgentRunStatus;
  transcript: string;
  /** Active chat thread this exchange belongs to. */
  threadId?: string;
  /** Durable completed/checkpointed user, assistant, and tool exchanges. */
  exchanges?: PersistedAgentExchange[];
  /** Prior interrupted/failed run when this run is an explicit retry. */
  parentRunId?: string;
  turn: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; costEstimated?: boolean };
  pendingApprovalIds: string[];
  recoverable: boolean;
  retryCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The transport a backend speaks. Codex reaches its app-server, Cursor and
 * Grok share a generic ACP (stdio/JSON-RPC) adapter, Copilot uses its SDK, and
 * the native-API providers (OpenAI, Anthropic, Gemini, xAI, OpenRouter) speak
 * their HTTP/SSE APIs directly — with Fable owning the entire agent loop.
 */
export type BackendType = "codex-app-server" | "acp" | "copilot-sdk" | "native-api";

/**
 * Resolved auth state for a backend instance. `install-required` and
 * `entitlement-pending` are fail-closed states: the adapter declares no
 * capabilities it cannot honor.
 */
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "install-required"
  | "entitlement-pending"
  | "unavailable";

/**
 * The closed capability set an adapter may declare dynamically. The UI may
 * only render a control for a capability the adapter actually reported.
 */
export type BackendCapability =
  | "authentication"
  | "threads"
  | "streaming"
  | "tool-requests"
  | "approvals"
  | "file-changes"
  | "usage-cost"
  | "model-availability"
  | "cancellation";

/**
 * The closed set of per-model capabilities Fable represents. Each field is a
 * truthful ceiling: it is only present when the adapter (or curated catalogue)
 * actually knows the model can honor it. An adapter must never populate a field
 * it cannot back — unknown capabilities stay `undefined` on the model, never
 * fabricated.
 */
export interface ModelCapabilities {
  /** Total input + output token ceiling for the model's context window. */
  contextWindow: number;
  /** Provider-imposed output cap for a single completion (max_tokens ceiling). */
  maxOutputTokens: number;
  /** Model supports streamed (SSE) completions. */
  streaming: boolean;
  /** Model supports tool / function calling. */
  tools: boolean;
  /** Model accepts image / vision inputs. */
  vision: boolean;
  /** Model exposes an internal reasoning / thinking mode. */
  reasoning: boolean;
  /** Model supports structured / JSON-schema-constrained output. */
  structuredOutput: boolean;
}

/** A selectable model exposed by a backend. */
export interface BackendModel {
  id: string;
  label: string;
  available: boolean;
  /**
   * Per-model capabilities. Optional: present only when the adapter or curated
   * catalogue knows them. Callers must treat `undefined` as "capabilities
   * unknown" (fail conservatively), never as "all capabilities present".
   */
  capabilities?: ModelCapabilities;
}

/**
 * Describes a connected (or connectable) agent-runtime backend. Capabilities
 * and entitlements are resolved dynamically from the current auth state —
 * adapters must never fake a capability they lack.
 */
export interface BackendProvider {
  id: string;
  backendType: BackendType;
  label: string;
  description: string;
  authState: BackendAuthState;
  capabilities: BackendCapability[];
  models: BackendModel[];
  /** Shown when `authState === "install-required"` (e.g. a missing CLI). */
  installHint?: string;
  /**
   * Entitlements detected post-login only. Grok Build is never promised for any
   * tier in fixture/preview data — it only appears here after a real check.
   */
  entitlements?: string[];
}

/**
 * Request to store a backend credential. The secret is handed to the Rust
 * credential boundary and never read back into JavaScript.
 */
export interface BackendCredentialRequest {
  providerId: string;
  secret: string;
}

/**
 * A consequential action a backend wants to perform (tool call, file write,
 * shell command). Fable routes these into its existing ApprovalRequest system
 * rather than letting the backend execute them directly.
 */
export interface BackendConsequentialEvent {
  providerId: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  /** When the backend already approved this internally, record it as audit. */
  backendPreapproved?: boolean;
}

/** An audit entry recording a backend-originated action. */
export interface BackendEventAudit {
  providerId: string;
  auditEntry: ApprovalAuditEntry;
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
   * Scope the source belongs to. Defaults to global when absent (the
   * pre-scope behavior). Drives retrieval + pinned-context bounding.
   */
  scope?: KnowledgeScope;
  /** Connector account provenance, when the source came from a connected account. */
  account?: string;
  /** True once chunks have been produced (and, when configured, embedded). */
  embeddingReady?: boolean;
  /** 0..1 connector/local trust weight used in retrieval ranking. */
  authority?: number;
  /** Soft-disable / exclusion flag. Disabled sources never enter a run. */
  disabled?: boolean;
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
  /** The basis for the citation's score — never hidden from the user. */
  ranking?: CitationRanking;
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
  | "too-many-files";

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
  providerMetadata?: Record<string, string>;
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

export type AutomationStatus = "draft" | "active" | "paused";

export interface AutomationRule {
  id: string;
  title: string;
  trigger: string;
  destination: string;
  status: AutomationStatus;
  requiresApproval: boolean;
}

/**
 * A weekday a user-created schedule may fire on. Kept in the shared protocol so
 * the shell, the runtime snapshot contract, and the Rust normalization layer
 * all reference one closed vocabulary.
 */
export type ScheduleWeekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

/**
 * A user-created schedule carried in the runtime snapshot. Non-secret: only the
 * task name/description, when it fires, and bookkeeping. Execution is still
 * linked up at runtime so a connected model can pick it up; nothing auto-runs.
 */
export interface ScheduleEntry {
  id: string;
  name: string;
  description: string;
  day: ScheduleWeekday;
  /** "HH:MM", 24-hour. */
  time: string;
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  decision: ApprovalDecision;
  decidedAt: string;
  note: string;
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
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Native-API agent loop: events + request shaping.
//
// The TypeScript layer owns request/response shaping + the agent loop as pure,
// fixture-testable logic; the Rust boundary owns the API key + HTTP/SSE egress.
// The API key NEVER appears in any of these types — it is added as an
// Authorization/x-api-key/x-goog-api-key header inside Rust only.
// ---------------------------------------------------------------------------

/** A message role in the normalized conversation. */
export type NativeMessageRole = "system" | "user" | "assistant" | "tool";

/** A single conversation message. `toolCallId` pairs a tool result to its call. */
export interface NativeMessage {
  role: NativeMessageRole;
  content: string;
  /** Assistant tool calls, when role === "assistant" and the model requested tools. */
  toolCalls?: NativeToolCall[];
  /** Tool-result call id, when role === "tool". */
  toolCallId?: string;
  /** Tool name for providers (for example Gemini) that require it on results. */
  toolName?: string;
}

/** A tool call the model emitted. The arguments are the raw model JSON string. */
export interface NativeToolCall {
  callId: string;
  tool: string;
  arguments: string;
}

/** A tool the loop advertises to the model (Fable-owned, from the registry). */
export interface NativeToolSpec {
  name: string;
  description: string;
  /** JSON-schema parameter shape, serialized as a string for transport. */
  parameters: string;
}

/** An Fable-owned tool the native loop may dispatch after approval. */
export interface BackendTool {
  name: string;
  description: string;
  defaultMode: PermissionMode;
  defaultRisk: ApprovalRiskLevel;
  parameters: string;
}

/** Normalized completion request the loop shapes per provider. No key, no URL. */
export interface NativeCompletionRequest {
  providerId: string;
  model: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; provider shapers clamp to the provider's limit. */
  maxTokens: number;
}

/**
 * A normalized agent-loop event streamed back to the shell — the shared event
 * surface for the native-API loop. Model tool calls arrive as `tool-call`
 * carrying a pre-shaped ApprovalRequest so they route through Fable's existing
 * approval queue before the tool is executed.
 */
export type BackendAgentEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call";
      callId: string;
      tool: string;
      arguments: string;
      approval: ApprovalRequest;
    }
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number; costEstimated?: boolean }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };
