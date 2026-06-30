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

// ---------------------------------------------------------------------------
// Fable-owned slash commands.
//
// The composer recognizes a small set of Fable-owned commands (/goal, /plan,
// /remember, /schedule). These are provider-neutral product features, not
// composer-text inserts: they create structured Fable state and submit model
// work through the resolved agent backend when required. Provider-specific
// slash commands never replace these; unknown slashes fall through to ordinary
// prompt submission unless a backend explicitly opts into passthrough.
//
// These types are wire only. Parsing, validation, redaction, and dispatch live
// in @fable/connectors; persistence + the shell live in the desktop boundary.
// ---------------------------------------------------------------------------

/** The Fable-owned commands. Provider-specific slashes never appear here. */
export type FableCommandName = "goal" | "plan" | "remember" | "schedule";

/** The canonical, slash-prefixed command tokens Fable owns. */
export const FABLE_COMMAND_TOKENS: readonly string[] = ["/goal", "/plan", "/remember", "/schedule"];

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

/** The default workspace scope used when a caller omits `workspaceId`. */
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
  workspaceId?: string;
  /** A provider-shaped item (search result / import) to cache. */
  item: Record<string, unknown>;
}

/** Input for toggling a cached item's disabled flag. */
export interface SetConnectorCacheItemDisabledRequest {
  workspaceId?: string;
  id: string;
  disabled: boolean;
}

/** Input for clearing a workspace's cache (optionally one connector). */
export interface ClearConnectorCacheRequest {
  workspaceId?: string;
  /** When set, only this connector's cached rows are cleared. */
  connectorId?: ConnectorId;
  /** When true, also drop the per-workspace/per-connector settings rows. */
  includeSettings?: boolean;
}

/** Input for marking a workspace/connector's cache freshly resynced. */
export interface ResyncConnectorCacheRequest {
  workspaceId?: string;
  connectorId?: ConnectorId;
}

/** Input for reading effective cache settings. */
export interface GetConnectorCacheSettingsRequest {
  workspaceId?: string;
  connectorId: ConnectorId;
}

/** Input for upserting cache settings. Empty `connectorId` sets the workspace default. */
export interface SetConnectorCacheSettingsRequest {
  workspaceId?: string;
  connectorId: ConnectorId;
  enabled: boolean;
  autoSync?: boolean;
  note?: string;
}

/** Input for deleting a cache settings row (restores the lower-precedence default). */
export interface DeleteConnectorCacheSettingsRequest {
  workspaceId?: string;
  connectorId: ConnectorId;
}

/** Credential-free export of a workspace's cached connector data. */
export interface ConnectorCacheExport {
  workspaceId: string;
  connectorId?: ConnectorId;
  credentialsIncluded: false;
  items: CachedConnectorItem[];
  settings: ConnectorCacheSettings[];
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
 * Resolved auth state for a backend instance. Fail-closed states declare no
 * capabilities the adapter cannot honor.
 *
 *   - `connected` — credential/runtime present and last-known good.
 *   - `needs-auth` — an API-key provider awaiting a key.
 *   - `sign-in-required` — a provider-owned login (Codex CLI, ACP, Copilot)
 *     is installed but not signed in; Fable never shows a token field here.
 *   - `install-required` — the provider's real runtime (CLI/SDK) is missing.
 *   - `connecting` — a verification round-trip is in flight (UI-only; never
 *     persisted by the boundary).
 *   - `expired` — a credential/login was valid before but is no longer.
 *   - `unsupported` — the provider cannot be driven from this build (e.g. an
 *     adapter family with no runnable implementation here).
 *   - `failed` — the last verification round-trip failed (transient/offline);
 *     the credential may still be stored, so the user can retry.
 *   - `ready` — terminal success alias surfaced by onboarding before the
 *     boundary re-resolves to `connected`.
 *   - `entitlement-pending` — authenticated, awaiting an entitlement check
 *     (Grok). Declares only the `authentication` capability.
 *   - `unavailable` — unknown/initialization failure; fails closed.
 */
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "sign-in-required"
  | "install-required"
  | "connecting"
  | "expired"
  | "unsupported"
  | "failed"
  | "ready"
  | "entitlement-pending"
  | "unavailable";

/**
 * States where the backend cannot serve any request (declares no caps). Every
 * {@link BackendAuthState} except `connected` is fail-closed. The union of this
 * list and `"connected"` must equal the full `BackendAuthState` vocabulary —
 * this parity is asserted by `BACKEND_AUTH_STATE_PARITY` below so a duplicate or
 * stray state is caught here rather than drifting into the Rust boundary.
 */
export const BACKEND_AUTH_FAIL_CLOSED_STATES = [
  "needs-auth",
  "sign-in-required",
  "install-required",
  "connecting",
  "expired",
  "unsupported",
  "failed",
  "ready",
  "entitlement-pending",
  "unavailable",
] as const;

/**
 * Compile-time + runtime closed-vocabulary parity for backend auth states.
 *
 * `BACKEND_AUTH_STATE_VALUES` is the exhaustive, duplicate-free list of every
 * `BackendAuthState`. `BACKEND_AUTH_STATE_PARITY` asserts the fail-closed set
 * plus `"connected"` exactly covers the vocabulary (no missing state, no stray
 * or duplicate value). A `const` assertion of an object whose keys span the
 * union makes a missing/duplicate state a *type* error; the runtime check makes
 * a parity drift between this list and `BACKEND_AUTH_FAIL_CLOSED_STATES` a load-
 * time failure instead of silent dedupe. Mirrors `BACKEND_AUTH_STATES` in the
 * Rust `models.rs` vocabulary (11 distinct values).
 */
export const BACKEND_AUTH_STATE_VALUES = [
  "connected",
  "needs-auth",
  "sign-in-required",
  "install-required",
  "connecting",
  "expired",
  "unsupported",
  "failed",
  "ready",
  "entitlement-pending",
  "unavailable",
] as const;

// Type-level exhaustiveness: every value must map to a BackendAuthState member.
const _BACKEND_AUTH_STATE_EXHAUSTIVE: Record<BackendAuthState, true> = {
  connected: true,
  "needs-auth": true,
  "sign-in-required": true,
  "install-required": true,
  connecting: true,
  expired: true,
  unsupported: true,
  failed: true,
  ready: true,
  "entitlement-pending": true,
  unavailable: true
};

// Runtime parity: fail-closed ∪ {connected} must equal the vocabulary exactly.
const _BACKEND_AUTH_STATE_PARITY_CHECK = (() => {
  const expected = new Set<string>(BACKEND_AUTH_STATE_VALUES);
  const actual = new Set<string>([...BACKEND_AUTH_FAIL_CLOSED_STATES, "connected"]);
  if (expected.size !== BACKEND_AUTH_STATE_VALUES.length) {
    throw new Error("BACKEND_AUTH_STATE_VALUES contains a duplicate auth state.");
  }
  if (expected.size !== actual.size) {
    throw new Error("Backend auth-state vocabulary has drifted from the fail-closed set.");
  }
  for (const state of actual) {
    if (!expected.has(state)) {
      throw new Error(`Backend auth-state "${state}" is not in the vocabulary.`);
    }
  }
  return true as const;
})();
export const BACKEND_AUTH_STATE_PARITY = _BACKEND_AUTH_STATE_PARITY_CHECK;
void _BACKEND_AUTH_STATE_EXHAUSTIVE;

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
 * Outcome of verifying a stored backend credential against the provider. Rust
 * hit-tests the stored key inside the credential boundary (no key crosses to
 * JS) and returns one of these outcomes. `auth-failed` clears the bad key;
 * the transient outcomes keep the stored key so the user can retry.
 */
export type BackendVerifyOutcome =
  | "ready"
  | "auth-failed"
  | "offline"
  | "unsupported"
  | "failed";

export interface BackendVerifyResult {
  providerId: string;
  outcome: BackendVerifyOutcome;
  /** Optional human-readable detail for surfacing useful errors. */
  message?: string;
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
// Scheduler, workflows, notifications, voice (local automation engine).
//
// These are wire types only. Pure logic lives in @fable/connectors; durable
// storage + OS integration lives in the Rust boundary; the shell wires them.
// ---------------------------------------------------------------------------

/** One-time or recurring trigger for a scheduled job. */
export type ScheduleTriggerKind = "once" | "recurring";

/** How to handle a run that was missed while the runtime was inactive. */
export type MissedRunPolicy =
  | "skip" // drop missed occurrences (default)
  | "run-once" // run the most recent missed occurrence once
  | "run-all"; // run every missed occurrence in order

/** Daily/weekly/monthly recurrence. Deliberately small (RRULE-lite). */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  /** 1 = every interval; 2 = every other, etc. */
  interval: number;
  /** Weekdays (Mon..Sun) for weekly frequency. Empty/omitted = every day. */
  byWeekday?: ScheduleWeekday[];
  /** Day-of-month (1..31) for monthly frequency. */
  byMonthDay?: number;
  /** 24-hour local hour 0..23. */
  hour: number;
  /** Minute 0..59. */
  minute: number;
  /** Inclusive ISO timestamp; no occurrence fires after this. */
  until?: string;
  /** IANA timezone id, e.g. "America/New_York". DST-aware. */
  timezone?: string;
}

export type ScheduleTrigger =
  | {
      kind: "once";
      /** ISO timestamp of the single occurrence. */
      at: string;
    }
  | {
      kind: "recurring";
      rule: RecurrenceRule;
    };

/** Status of a durable scheduled job (definition + lifecycle). */
export type ScheduledJobStatus = "active" | "paused" | "deleted";

/**
 * The frozen, non-secret execution route captured when a schedule is created.
 *
 * A schedule pins which backend/model/permission runs it so scheduled work
 * never silently switches provider, model, or permission mode. At create time,
 * if a backend is connected the route is `pinned` to the current backend/model;
 * otherwise it is `current-default` and resolved against whatever is connected
 * at execution time.
 *
 * SECRET INVARIANT: this carries only provider/model ids + permission mode —
 * never keys, tokens, or credentials.
 */
export interface ScheduledExecutionRoute {
  policy: "pinned" | "current-default";
  backendId: string;
  modelId: string;
  permissionMode: PermissionMode;
}

/**
 * A durable scheduled job. Supersedes the bare ScheduleEntry for execution.
 * ScheduleEntry remains for the legacy snapshot; this is the engine's record.
 */
export interface ScheduledJob {
  /** Stable id. */
  id: string;
  /** Schema version of this job record. */
  schemaVersion: number;
  name: string;
  description: string;
  /** The workflow definition id this job runs. */
  workflowDefinitionId: string;
  trigger: ScheduleTrigger;
  missedRunPolicy: MissedRunPolicy;
  status: ScheduledJobStatus;
  /** Frozen execution route (backend/model/permission). Resolved at run time. */
  execution?: ScheduledExecutionRoute;
  /** ISO timestamp of the next calculated occurrence (empty when paused/none). */
  nextRunAt: string;
  /** ISO timestamp of the last completed run (empty when never run). */
  lastRunAt: string;
  /** Id of the last workflow run, for "last result" display. */
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
}

/** Attempt outcome for a single job execution attempt. */
export type JobAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked-auth";

export interface JobAttempt {
  /** Id of the workflow run this attempt produced. */
  runId: string;
  status: JobAttemptStatus;
  attemptNumber: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Whether a failed attempt should be retried (transient) or not (permanent). */
  retryable?: boolean;
  /** Fencing token proving this attempt corresponds to the current lease. */
  leaseToken?: string;
}

/**
 * The full lifecycle vocabulary of a scheduler queue entry. The Rust store is
 * the authority; this mirrors its states so the shell can render them truthfully.
 */
export type SchedulerJobState =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "blocked-auth"
  | "cancelled"
  | "done"
  | "dead";

export type SchedulerJobStateLegacy = "queued" | "leased" | "done" | "dead";

/** A queued execution entry in the durable scheduler queue. */
export interface SchedulerQueueEntry {
  /** Job id this entry is for. */
  jobId: string;
  /** Workflow run id to create/use. */
  runId: string;
  /** Scheduled fire time (ISO). */
  scheduledAt: string;
  /** Current queue state. */
  state: SchedulerJobState;
  /** Opaque lease holder id (window/instance id). Empty when unleased. */
  leaseHolder: string;
  /** ISO timestamp the lease expires (empty when unleased). */
  leaseExpiresAt: string;
  /** Attempt history (newest last). */
  attempts: JobAttempt[];
  /** Idempotency key deduplicating this scheduled occurrence. */
  deduplicationKey: string;
  /** Fencing token proving a report/renew call corresponds to the current lease. */
  leaseToken?: string;
  /** Earliest retry time (ISO) after a transient failure; honored by the tick. */
  availableAt?: string;
  /** Last error message (truncated, no secrets) for failed/blocked entries. */
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Workflow definitions + runs.
// ---------------------------------------------------------------------------

export type WorkflowStepKind =
  | "prompt" // run an agent turn with a prompt
  | "connector-read" // read from a connector capability
  | "agent" // multi-turn agent step (tool calls gated)
  | "tool" // a single Fable-owned tool call
  | "approval"; // pause for fresh explicit approval

export interface WorkflowPromptStep {
  kind: "prompt";
  id: string;
  prompt: string;
  /** Connector ids this step depends on (for honest degradation). */
  requiresConnectors?: string[];
}

export interface WorkflowConnectorReadStep {
  kind: "connector-read";
  id: string;
  connectorId: string;
  capability: string;
  input: Record<string, unknown>;
  /** Output variable name to store the read result. */
  outputVar: string;
}

export interface WorkflowAgentStep {
  kind: "agent";
  id: string;
  prompt: string;
  /** Max agent turns for this step. */
  maxTurns?: number;
  requiresConnectors?: string[];
}

export interface WorkflowToolStep {
  kind: "tool";
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** True for consequential writes (forces approval pause). */
  consequential: boolean;
}

export interface WorkflowApprovalStep {
  kind: "approval";
  id: string;
  /** Human description of what is being approved. */
  description: string;
}

export type WorkflowStep =
  | WorkflowPromptStep
  | WorkflowConnectorReadStep
  | WorkflowAgentStep
  | WorkflowToolStep
  | WorkflowApprovalStep;

/**
 * A versioned, editable workflow definition. Editing creates a new version so
 * historical runs keep the definition they executed against.
 */
export interface WorkflowDefinition {
  /** Schema version of the definition shape. */
  schemaVersion: number;
  id: string;
  /** Monotonic version; edits bump this and keep history immutable. */
  version: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** Per-workflow notification preferences. */
  notificationPrefs?: NotificationPrefs;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Departments: narrow user-facing workflow lanes.
// ---------------------------------------------------------------------------

export type DepartmentId = "research" | "ship" | (string & {});
export type PipelineId = string & {};
export type ConnectorNeedAccess = "read" | "write";
export type ApprovalRequirementKind = "none" | "fresh-explicit" | "high-risk";

export interface ConnectorNeed {
  connectorId: ConnectorId;
  access: ConnectorNeedAccess;
  reason: string;
  optional?: boolean;
}

export interface ScheduleTriggerNeed {
  kind: "manual" | "scheduled";
  description: string;
}

export interface ApprovalRequirement {
  kind: ApprovalRequirementKind;
  reason: string;
}

export interface RuntimeRoute {
  kind: "agent-backend";
  policy: ScheduledExecutionRoute["policy"];
  permissionMode: PermissionMode;
}

export interface PipelineStep {
  id: string;
  title: string;
  description: string;
  workflowStepId: string;
}

export interface Pipeline {
  id: PipelineId;
  departmentId: DepartmentId;
  name: string;
  description: string;
  steps: PipelineStep[];
  connectorNeeds: ConnectorNeed[];
  scheduleTrigger: ScheduleTriggerNeed;
  approvalRequirement: ApprovalRequirement;
  runtimeRoute: RuntimeRoute;
  workflow: WorkflowDefinition;
}

export interface Department {
  id: DepartmentId;
  name: string;
  summary: string;
  pipelines: Pipeline[];
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "blocked-auth"
  | "cancelled";

export type WorkflowStepRecordStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkflowStepRecord {
  stepId: string;
  status: WorkflowStepRecordStatus;
  /** Stored inputs/outputs for transparency. */
  input?: unknown;
  output?: unknown;
  /** Tool calls made during this step (transparent history). */
  toolCalls?: { tool: string; arguments: string; ok: boolean; output: string }[];
  /** Approval state for approval/tool steps. */
  approval?: {
    decision: "pending" | "approved" | "denied" | "expired";
    decidedAt?: string;
    expiresAt?: string;
  };
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** What triggered a workflow run. */
export type WorkflowRunTrigger = "schedule" | "manual" | "voice";

export interface WorkflowRun {
  id: string;
  /** The definition this run executes. */
  definitionId: string;
  /** Snapshot version of the definition at run time (immutable history). */
  definitionVersion: number;
  status: WorkflowRunStatus;
  trigger: WorkflowRunTrigger;
  /** Job id when trigger === "schedule". */
  scheduledJobId?: string;
  /** Inputs supplied to the run. */
  input: Record<string, unknown>;
  /** Per-step records, in execution order. */
  steps: WorkflowStepRecord[];
  /** Failure reason when status === "failed". */
  failureReason?: string;
  /** Idempotency key for external mutations. */
  idempotencyKey?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Notifications.
// ---------------------------------------------------------------------------

export type NotificationKind = "run-completed" | "run-failed" | "approval-needed";

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  /** Workflow run id the notification refers to. */
  runId: string;
  /** Workflow definition id (for per-workflow prefs). */
  definitionId?: string;
  title: string;
  /** Public body (no private content). Always safe to show in OS UI. */
  body: string;
  /** Whether the OS notification was suppressed (per prefs / disabled). */
  suppressed: boolean;
  createdAt: string;
  /** Deep-link target (page + run id) for click navigation. */
  deepLink?: { page: string; runId: string };
  /** True once delivered to the OS notification center. */
  delivered: boolean;
}

export interface NotificationPrefs {
  /** Disable OS notifications for this workflow (in-app history still kept). */
  disableOs: boolean;
  /** Kinds to surface. */
  enabledKinds: NotificationKind[];
}

// ---------------------------------------------------------------------------
// Voice (pluggable STT boundary).
// ---------------------------------------------------------------------------

export type VoiceProviderKind = "local" | "remote";

export interface VoiceProviderDescriptor {
  id: string;
  kind: VoiceProviderKind;
  label: string;
  /** Whether raw audio is retained (must be false for the default local path). */
  retainsAudio: boolean;
  /** Setup/install message when the provider is unavailable. */
  setupHint?: string;
}

/** Discrete recording state for push-to-talk. */
export type VoiceRecordingState = "idle" | "recording" | "processing" | "review" | "error";

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
  | {
      type: "error";
      message: string;
      /**
       * Machine-readable error code for routing (e.g. "authentication" routes a
       * scheduled run to blocked-auth). Optional: backends that can't classify
       * leave it undefined and callers treat it as a generic failure.
       */
      code?: string;
      /** True when the failure is transient and a retry may succeed. */
      retryable?: boolean;
    }
  | { type: "cancelled" };

// ---------------------------------------------------------------------------
// Provider-neutral AgentBackend runtime contract.
//
// BackendAgentEvent (above) is the universal streaming surface every backend
// family speaks. The AgentBackend abstraction lets native-API, Codex app-server,
// ACP, Copilot SDK, and future local/subscription runtimes each implement one
// contract: run a prompt turn (streaming events), request tools/approvals,
// cancel, and expose models/capabilities. Native-API is the first concrete
// adapter — not the foundation. The other backends remain metadata-only until
// their adapter lands; the factory returns null for them.
//
// HARD SECRET INVARIANT: none of these types carry a key, token, or credential.
// Auth lives behind the Rust boundary or a provider-owned auth cache. An
// AgentBackend instance must never hold a secret in its fields.
// ---------------------------------------------------------------------------

/**
 * A normalized prompt turn for any agent backend. Shaped like the existing
 * key-free {@link NativeCompletionRequest}; carries NO key, NO token, NO URL.
 * Backend-specific shaping happens inside the adapter, never in this type.
 */
export interface AgentRunRequest {
  model: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; adapters clamp to the model's known ceiling. */
  maxTokens: number;
}

/**
 * Options for an agent run. Provider-neutral: the execute/shouldCancel/approval
 * seams are the same ones the native-API loop uses, so any backend that issues
 * tool calls routes through Fable's shared approval queue.
 */
export interface AgentRunOptions {
  /** Executes an approved tool. Backends call this for each tool-call event. */
  execute: (approval: ApprovalRequest, args: string) => Promise<string>;
  /** Cooperative cancellation hook, checked between events. */
  shouldCancel?: () => boolean;
  /** Optional system-context prefix (pinned memory/knowledge by trust level). */
  contextPrefix?: string;
  /** The composer's permission level, gating which tools may execute. */
  permissionMode?: PermissionMode;
  /** Stable run id used to bind approvals and reject cross-run/replayed calls. */
  runId?: string;
  /** Max turns before the backend stops (safety). */
  maxTurns?: number;
  /** Maximum accepted tool calls across the whole run. */
  maxToolCalls?: number;
  /** Maximum characters returned to model context by one tool. */
  maxToolOutputCharacters?: number;
  /**
   * Notifies the shell that the backend's transport is retrying after a
   * transient failure (e.g. HTTP 429/5xx backoff). Provider-neutral: any
   * egress-bound backend may retry. The shell uses this to mark the persisted
   * run as "retrying" and bump its retry count.
   */
  onRetry?: () => void;
}

// ---------------------------------------------------------------------------
// Mobile remote-control foundation.
//
// The mobile device is a SECOND approval / observation / control surface for
// the desktop, never an authority and never a cloud backend. The desktop is
// the only execution authority: every mobile-originated action still funnels
// through the existing approval + scheduler boundaries and their fingerprinted
// one-time execution permits, unchanged. There is no hosted Fable account;
// pairing is pairwise and LAN-local.
//
// See docs/architecture/mobile-remote.md for pairing, trust, transport, threat
// model, revocation, offline behavior, and the explicit non-cloud guarantees.
//
// HARD SECRET INVARIANT: none of these types carry a key, token, PSK,
// credential, or device secret. Pairing secrets and long-lived device keys
// live behind the Rust boundary (like backend credentials) and are never read
// back into JavaScript. The trust list and sessions below are non-secret
// metadata only. Wire types here mirror the protocol's existing secret-free
// contract.
// ---------------------------------------------------------------------------

/** The trust state of a paired device in the local trust list. */
export type RemoteDeviceTrustState = "pending" | "trusted" | "revoked";

/** Opaque id of a paired device. */
export type RemoteDeviceId = string;

/**
 * A paired device record held in the desktop trust list. Non-secret metadata
 * only — no PSK, no long-lived key. Those live behind the Rust boundary.
 */
export interface RemoteDevice {
  id: RemoteDeviceId;
  label: string;
  trustState: RemoteDeviceTrustState;
  /** ISO timestamp of first successful pairing. */
  firstPairedAt: string;
  /** ISO timestamp of the last frame seen from this device. */
  lastSeenAt: string;
  /** ISO timestamp when the device was revoked, if any. Terminal. */
  revokedAt?: string;
}

/** Lifecycle of a remote session bound to a trusted device. */
export type RemoteSessionState = "pairing" | "active" | "expired" | "revoked";

/**
 * A session between a trusted device and the desktop. Non-secret: only ids,
 * state, and bookkeeping timestamps. The desktop is the authority for whether
 * a session is live; a non-live session fails closed and applies no command.
 */
export interface RemoteSession {
  id: string;
  deviceId: RemoteDeviceId;
  state: RemoteSessionState;
  /** ISO timestamp of session creation. */
  createdAt: string;
  /** ISO timestamp after which an active session is treated as expired. */
  expiresAt: string;
  /** ISO timestamp of the last command/event activity on this session. */
  lastActivityAt: string;
}

/**
 * Desktop-issued pairing challenge. `confirmCode` is the short numeric code
 * the user types to prove physical presence — it is never the PSK. The PSK
 * proof material is computed and held in Rust; this object carries no secret.
 */
export interface RemotePairingChallenge {
  /** High-entropy nonce binding this challenge to a single pairing attempt. */
  challengeNonce: string;
  /** Short numeric confirmation code displayed on the desktop. */
  confirmCode: string;
  /** ISO timestamp the challenge was issued. */
  issuedAt: string;
  /** ISO timestamp after which the challenge is no longer valid. */
  expiresAt: string;
}

/**
 * Mobile response to a pairing challenge. `proofToken` is PSK-derived material
 * the Rust boundary verifies; it is opaque to JavaScript and is NOT the PSK.
 */
export interface RemotePairingProof {
  challengeNonce: string;
  confirmCode: string;
  /** PSK-derived proof material. Opaque to JS; verified behind the Rust boundary. */
  proofToken: string;
}

/** Outcome of a pairing attempt. */
export type RemotePairingResult =
  | { ok: true; device: RemoteDevice; session: RemoteSession }
  | { ok: false; code: RemoteErrorCode; message: string };

/** Version of the mobile remote-control wire protocol. */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

/**
 * The versioned envelope carrying one mobile-remote frame. PSK-mutual
 * authentication and replay protection are transport-layer concerns handled
 * in Rust; this envelope carries only version, session binding, a per-frame
 * nonce, and the typed payload.
 */
export interface RemoteEnvelopeV1 {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  /** Session id the frame belongs to. */
  sessionId: string;
  /** Per-frame high-entropy nonce for replay protection. */
  nonce: string;
  /** Typed observation event or control command. */
  payload: RemoteEvent | RemoteCommand;
}

/**
 * A read-only observation the desktop streams to the mobile device. Reuses
 * existing domain shapes verbatim so the mobile surface never invents a
 * parallel truth about runs, schedules, or approvals.
 */
export type RemoteEvent =
  | {
      type: "run-status";
      runId: string;
      status: WorkflowRunStatus;
      updatedAt: string;
    }
  | {
      type: "schedule-status";
      jobId: string;
      status: ScheduledJobStatus;
      nextRunAt: string;
    }
  | {
      type: "approval-requested";
      /** The existing approval shape, surfaced for a remote decision. */
      approval: ApprovalRequest;
    }
  | {
      type: "approval-resolved";
      approvalId: string;
      decision: ApprovalDecision;
      decidedAt: string;
    };

/**
 * A control command from the mobile device. These are *inputs* to the existing
 * approval and scheduler boundaries — never execution authority. Approve/deny
 * feeds the existing approval-resolution path, which still requires its own
 * fresh fingerprinted permit for any tool to fire. Schedule commands require an
 * exact matching job id or are rejected.
 */
export type RemoteCommand =
  | { type: "approve"; approvalId: string; decision: "once" | "session" | "rule" }
  | { type: "deny"; approvalId: string }
  | { type: "pause-schedule"; jobId: string }
  | { type: "resume-schedule"; jobId: string }
  | { type: "delete-schedule"; jobId: string };

/** Machine-readable failure codes for remote operations (all fail-closed). */
export type RemoteErrorCode =
  | "device-unpaired"
  | "session-expired"
  | "approval-not-found"
  | "approval-already-resolved"
  | "schedule-not-found"
  | "invalid-command"
  | "protocol-version-unsupported"
  | "unauthorized";

/** Result of applying (or refusing) a remote command. */
export type RemoteCommandResult =
  | { ok: true; appliedAt: string }
  | { ok: false; code: RemoteErrorCode; message: string };
