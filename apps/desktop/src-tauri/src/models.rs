//! Shared constants and wire-format models for the Fable runtime.
//!
//! Every feature module (approvals, knowledge, memory, snapshot) reads from
//! this module so the validation caps and serde shapes stay in one place.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// Validation caps (shared across feature modules).
pub const MAX_LOCAL_FILE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LOCAL_FILE_PREVIEW_CHARACTERS: usize = 6_000;
pub const DEFAULT_RESULT_LIMIT: usize = 5;
pub const MAX_SNIPPET_CHARACTERS: usize = 240;
pub const MAX_APPROVAL_AUDIT_ENTRIES: usize = 200;
pub const MAX_APPROVAL_AUDIT_NOTE_CHARACTERS: usize = 240;
pub const MAX_APPROVAL_RULES: usize = 100;
pub const MAX_IMPORTED_KNOWLEDGE_SOURCES: usize = 100;
pub const MAX_MEMORY_RECORDS: usize = 200;
pub const MAX_MEMORY_TITLE_CHARACTERS: usize = 120;
pub const MAX_MEMORY_VALUE_CHARACTERS: usize = 2_000;
pub const MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS: usize = 20_000;
pub const MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS: usize = 160;
pub const MAX_RUNTIME_SNAPSHOT_IDS: usize = 200;
pub const MAX_RUNTIME_SNAPSHOT_AUTOMATIONS: usize = 100;
pub const MAX_RUNTIME_SNAPSHOT_SCHEDULES: usize = 100;
pub const MAX_SCHEDULE_FIELD_CHARACTERS: usize = 200;
pub const MAX_RUNTIME_SNAPSHOT_GOALS: usize = 100;
pub const MAX_RUNTIME_SNAPSHOT_PLANS: usize = 100;
pub const MAX_GOAL_FIELD_CHARACTERS: usize = 1_000;
pub const MAX_PLAN_TITLE_CHARACTERS: usize = 200;
pub const MAX_PLAN_STEP_DESCRIPTION_CHARACTERS: usize = 500;
pub const MAX_PLAN_STEPS: usize = 50;
pub const GOAL_STATUSES: [&str; 3] = ["active", "achieved", "archived"];
pub const PLAN_STATUSES: [&str; 3] = ["draft", "in-progress", "complete"];
pub const RUNTIME_SNAPSHOT_VERSION: u8 = 1;

// Controlled vocabularies used for validation.
pub const MEMORY_KINDS: [&str; 4] = ["fact", "inference", "preference", "imported"];
pub const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];
pub const APPROVAL_DECISIONS: [&str; 5] = ["once", "session", "rule", "modify", "deny"];
pub const APPROVAL_MODES: [&str; 3] = ["read-only", "trusted-scope", "full-access"];
pub const APPROVAL_RISK_LEVELS: [&str; 4] = ["low", "medium", "high", "critical"];
pub const AUTOMATION_STATUSES: [&str; 3] = ["draft", "active", "paused"];
pub const SCHEDULE_WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Agent-runtime backend vocabularies (controlled, used for validation).
pub const BACKEND_TYPES: [&str; 4] = ["codex-app-server", "acp", "copilot-sdk", "native-api"];
pub const BACKEND_AUTH_STATES: [&str; 11] = [
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
];
/// Backend auth states that fail closed: the adapter declares no capabilities
/// it cannot honor. Mirrors `BACKEND_AUTH_FAIL_CLOSED_STATES` in protocol. Kept
/// as a contract constant — asserted by the vocabulary test in `tests.rs` (which
/// is the only non-test reference), so it is allowed as dead code in the lib.
#[allow(dead_code)]
pub const BACKEND_AUTH_FAIL_CLOSED_STATES: [&str; 10] = [
    "needs-auth",
    "sign-in-required",
    "install-required",
    "connecting",
    "expired",
    "unsupported",
    "failed",
    "entitlement-pending",
    "ready",
    "unavailable",
];
/// Outcome vocabulary for backend credential verification (Rust round-trips the
/// stored key against the provider and returns exactly one of these). Asserted
/// by the vocabulary test in `tests.rs`; allowed as dead code in the lib.
#[allow(dead_code)]
pub const BACKEND_VERIFY_OUTCOMES: [&str; 5] =
    ["ready", "auth-failed", "offline", "unsupported", "failed"];
pub const BACKEND_CAPABILITIES: [&str; 9] = [
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "usage-cost",
    "model-availability",
    "cancellation",
];
pub const SUPPORTED_BACKEND_PROVIDER_IDS: [&str; 9] = [
    "codex",
    "cursor",
    "copilot",
    "grok",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "openrouter",
];
/// Marker that backend credential storage is pre-release. Now that the OS
/// keychain is wired (`backends::KeyringStore`, with an in-memory fallback),
/// this is `false` — secrets persist across restarts in the platform-secure
/// store rather than living only in process memory. The flag is retained so
/// any future pre-release window can re-enable the one-time warning.
pub const BACKENDS_PRE_RELEASE: bool = false;
pub const MAX_BACKEND_SECRET_CHARACTERS: usize = 8_000;
pub const MAX_BACKEND_MODELS: usize = 32;
pub const MAX_BACKEND_CAPABILITIES: usize = 16;

// First-wave connector vocabularies.
pub const FIRST_WAVE_CONNECTOR_IDS: [&str; 8] = [
    "github",
    "vercel",
    "google-drive",
    "notion",
    "gmail",
    "slack",
    "google-calendar",
    "linear",
];
pub const CONNECTOR_AUTH_STATES: [&str; 10] = [
    "fixture",
    "needs-auth",
    "unconfigured",
    "configured",
    "connected",
    "expired",
    "revoked",
    "provider-error",
    "error",
    "unavailable",
];
pub const CONNECTOR_ACTIONS: [&str; 45] = [
    "github.draft-pull-request",
    "github.comment",
    "vercel.promote",
    "vercel.rollback",
    "github.create-issue",
    "github.update-issue",
    "github.create-review",
    "github.update-file",
    "github.create-branch",
    "github.dispatch-workflow",
    "vercel.create-deployment",
    "vercel.cancel-deployment",
    "vercel.update-project",
    "vercel.create-domain",
    "vercel.update-domain",
    "vercel.delete-domain",
    "linear.create-issue",
    "linear.update-issue",
    "linear.comment",
    "google-drive.create-file",
    "google-drive.update-file",
    "google-drive.move-file",
    "google-drive.rename-file",
    "google-drive.share-file",
    "google-drive.delete-file",
    "gmail.create-draft",
    "gmail.send",
    "slack.create-draft",
    "slack.post",
    "slack.reply",
    "slack.edit",
    "slack.delete",
    "slack.react-add",
    "slack.react-remove",
    "notion.create-page",
    "notion.update-page",
    "notion.append-blocks",
    "notion.update-block",
    "notion.delete-block",
    "notion.create-comment",
    "notion.create-entry",
    "google-calendar.create-draft",
    "google-calendar.update-draft",
    "google-calendar.cancel-event",
    "google-calendar.delete-event",
];
pub const MAX_CONNECTOR_QUERY_CHARACTERS: usize = 500;
pub const MAX_CONNECTOR_RESULT_LIMIT: usize = 50;
pub const MAX_CONNECTOR_PAYLOAD_FIELDS: usize = 32;
pub const MAX_AGENT_RUNS: usize = 100;
pub const MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS: usize = 200_000;

// Scheduler constants (durable local automation engine).
pub const SCHEDULER_STORE_VERSION: u8 = 1;
pub const MAX_SCHEDULED_JOBS: usize = 100;
pub const MAX_SCHEDULER_QUEUE_ENTRIES: usize = 500;
pub const MAX_JOB_ATTEMPTS: usize = 20;
pub const SCHEDULER_TICK_SECS: u64 = 5;
pub const SCHEDULER_LEASE_MS: i64 = 30_000;
/// Lease extension granted when a run acknowledges `running`. Long enough that a
/// healthy long run is not re-queued by the five-second tick, short enough that a
/// crashed process recovers the entry within minutes.
pub const RUNNING_LEASE_MS: i64 = 15 * 60 * 1_000;
pub const SCHEDULER_MAX_RETRIES: u32 = 2;
/// Base backoff for transient retry. Each retry waits RETRY_BASE_MS * 2^(n-1).
pub const RETRY_BASE_MS: i64 = 30_000;
pub const RETRY_MAX_BACKOFF_MS: i64 = 15 * 60 * 1_000;
/// Bounded ledger of seen occurrence dedup keys, supplementing the in-queue
/// check so a completed-then-removed occurrence can never be re-queued.
pub const MAX_OCCURRENCE_LEDGER: usize = 200;
pub const SCHEDULED_JOB_STATUSES: [&str; 3] = ["active", "paused", "deleted"];
pub const MISSED_RUN_POLICIES: [&str; 3] = ["skip", "run-once", "run-all"];
pub const JOB_ATTEMPT_STATUSES: [&str; 5] = [
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "blocked-auth",
];
/// Full queue-entry state vocabulary. The Rust store is the authority (entry
/// states are never accepted from the wire — they are advanced by `run_tick`
/// and `report_job_attempt`). Kept as a named constant so the vocabulary is
/// discoverable and stays in lock-step with the TS `SchedulerJobState` mirror.
#[allow(dead_code)]
pub const SCHEDULER_QUEUE_STATES: [&str; 9] = [
    "queued",
    "leased",
    "running",
    "completed",
    "failed",
    "blocked-auth",
    "cancelled",
    "done",
    "dead",
];

// Workflow-run store constants.
pub const WORKFLOW_RUN_STORE_VERSION: u8 = 1;
pub const MAX_WORKFLOW_RUNS: usize = 200;
/// Legacy flat workflow-definition journal cap; migrated at most this many.
pub const MAX_WORKFLOW_DEFINITION_HISTORY: usize = 500;
pub const MAX_WORKFLOW_STEPS: usize = 24;
pub const WORKFLOW_RUN_STATUSES: [&str; 7] = [
    "queued",
    "running",
    "awaiting-approval",
    "completed",
    "failed",
    "blocked-auth",
    "cancelled",
];

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub permission_mode: &'static str,
    pub offline_ready: bool,
    pub connector_boundaries: [&'static str; 9],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorPermission {
    pub id: String,
    pub label: String,
    pub access: String,
    pub required: bool,
    pub granted: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorHealth {
    pub state: String,
    pub summary: String,
    pub checked_at: String,
    pub retry_after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccountSummary {
    pub id: String,
    pub display_name: String,
    pub handle: Option<String>,
    pub email: Option<String>,
    pub workspace: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccountOption {
    pub account: ConnectorAccountSummary,
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorManifest {
    pub id: String,
    pub name: String,
    pub status: String,
    pub permissions: Vec<String>,
    pub health_summary: String,
    pub last_checked_at: String,
    pub auth_mode: String,
    pub scopes: Vec<ConnectorPermission>,
    pub health: ConnectorHealth,
    pub account: Option<ConnectorAccountSummary>,
    pub setup_message: Option<String>,
    pub supports_search: bool,
    pub supports_import: bool,
    pub supported_actions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSyncRequest {
    pub connector_id: String,
    pub workspace_id: String,
    pub trigger: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSyncFailure {
    pub kind: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSyncState {
    pub connector_id: String,
    pub workspace_id: String,
    pub phase: String,
    pub trigger: Option<String>,
    pub attempt: u32,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub last_successful_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub cursor: Option<String>,
    pub items_processed: u64,
    pub stale_token_recovered: bool,
    pub failure: Option<ConnectorSyncFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuthRequest {
    pub connector_id: String,
    pub redirect_uri: Option<String>,
    pub callback_url: Option<String>,
    pub requested_scopes: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuthResult {
    pub connector_id: String,
    pub status: String,
    pub authorization_url: Option<String>,
    pub account: Option<ConnectorAccountSummary>,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    #[serde(default)]
    pub cost_estimated: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentExchange {
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub ok: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentRun {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub status: String,
    pub transcript: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub exchanges: Vec<PersistedAgentExchange>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    pub turn: usize,
    pub usage: Option<AgentRunUsage>,
    pub pending_approval_ids: Vec<String>,
    pub recoverable: bool,
    pub retry_count: usize,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorApprovalRecord {
    pub id: String,
    pub connector_id: String,
    pub account_id: String,
    pub proposed_action: String,
    pub target: String,
    pub preview: String,
    pub risk_level: String,
    pub result: String,
    pub request_id: String,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub executed_at: Option<String>,
    pub actor: String,
    pub run_id: Option<String>,
    pub error_code: Option<String>,
    pub action_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCommandError {
    pub code: String,
    pub connector_id: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSearchRequest {
    pub connector_id: String,
    pub query: String,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSearchItem {
    pub id: String,
    pub connector_id: String,
    pub title: String,
    pub kind: String,
    pub summary: String,
    pub provenance: String,
    pub freshness: String,
    pub trust: String,
    pub url: Option<String>,
    pub content_preview: Option<String>,
    pub provider_metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSearchResult {
    pub connector_id: String,
    pub query: String,
    pub items: Vec<ConnectorSearchItem>,
    pub next_cursor: Option<String>,
    pub source: String,
    pub searched_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCapabilityRequest {
    pub connector_id: String,
    pub capability: String,
    #[serde(default)]
    pub input: BTreeMap<String, serde_json::Value>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCapabilityResult {
    pub connector_id: String,
    pub capability: String,
    pub items: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
    pub rate_limit_remaining: Option<u64>,
    pub rate_limit_reset_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorImportRequest {
    pub connector_id: String,
    pub item: ConnectorSearchItem,
    pub imported_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorKnowledgeSource {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub connector_id: String,
    pub provenance: String,
    pub freshness: String,
    pub pinned: bool,
    pub trust: String,
    pub content_preview: Option<String>,
    pub imported_at: String,
    pub origin: String,
    pub provider_metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorImportResult {
    pub source: ConnectorKnowledgeSource,
    pub imported: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionRequest {
    pub id: String,
    pub connector_id: String,
    pub action: String,
    pub payload: BTreeMap<String, String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub permission_profile: Option<String>,
    pub approval: ApprovalRequest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionResult {
    pub request_id: String,
    pub connector_id: String,
    pub action: String,
    pub status: String,
    pub message: String,
    pub provider_resource_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionExecutionRequest {
    pub action: ConnectorActionRequest,
    pub approval: ApprovalResolutionRequest,
}

/// A selectable model exposed by a backend. `available` is resolved from auth
/// state; the secret itself never appears here.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendModel {
    pub id: String,
    pub label: String,
    pub available: bool,
}

/// Describes a connected (or connectable) agent-runtime backend. The Rust
/// credential boundary returns this shape to JavaScript — auth state and
/// capabilities only, never raw tokens.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProvider {
    pub id: String,
    pub backend_type: String,
    pub label: String,
    pub description: String,
    pub auth_state: String,
    pub capabilities: Vec<String>,
    pub models: Vec<BackendModel>,
    pub install_hint: Option<String>,
    pub entitlements: Option<Vec<String>>,
}

/// Request to store a backend credential. The secret is written to the
/// process-scoped store and never read back across the Tauri boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCredentialRequest {
    pub provider_id: String,
    pub secret: String,
}

/// Outcome of verifying a stored backend credential. Rust looks the key up
/// inside the credential boundary and round-trips it against the provider; the
/// secret never crosses to JavaScript. The outcome vocabulary is
/// `BACKEND_VERIFY_OUTCOMES`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendVerifyResult {
    pub provider_id: String,
    pub outcome: String,
    pub message: Option<String>,
}

/// A consequential action a backend wants to perform. Fable records it as an
/// approval audit entry rather than letting the backend execute it directly.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConsequentialEvent {
    pub provider_id: String,
    pub service: String,
    pub action: String,
    pub mode: String,
    pub risk_level: String,
    pub data_used: Vec<String>,
    pub consequence: String,
    pub backend_preapproved: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextFileCandidate {
    pub name: String,
    pub content: String,
    pub size_bytes: usize,
    pub imported_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileImport {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub connector_id: String,
    pub provenance: String,
    pub freshness: String,
    pub pinned: bool,
    pub trust: String,
    pub content_preview: String,
    pub content_fingerprint: String,
    pub size_bytes: usize,
    pub imported_at: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub id: String,
    pub title: String,
    pub provenance: String,
    pub freshness: String,
    pub pinned: bool,
    pub trust: Option<String>,
    pub content_preview: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCitation {
    pub source_id: String,
    pub title: String,
    pub snippet: String,
    pub provenance: String,
    pub freshness: String,
    pub trust: String,
    pub pinned: bool,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResponse {
    pub query: String,
    pub mode: &'static str,
    pub citations: Vec<KnowledgeCitation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAuditEntry {
    pub id: String,
    pub request_id: String,
    pub decision: String,
    pub decided_at: String,
    pub note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAuditRecordResponse {
    pub persisted: bool,
    pub entry: ApprovalAuditEntry,
    pub audit_len: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub service: String,
    pub action: String,
    pub mode: String,
    pub risk_level: String,
    pub data_used: Vec<String>,
    pub consequence: String,
    pub requested_at: String,
    pub decisions: Vec<String>,
    pub confirmation_phrase: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModification {
    pub mode: String,
    pub data_used: Vec<String>,
    pub consequence: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalGrant {
    pub id: String,
    pub request_id: String,
    pub scope: String,
    pub service: String,
    pub action: String,
    pub mode: String,
    pub data_used: Vec<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolutionRequest {
    pub request: ApprovalRequest,
    pub decision: String,
    pub decided_at: String,
    pub confirmation_text: Option<String>,
    pub modification: Option<ApprovalModification>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolutionResponse {
    pub persisted: bool,
    pub audit_entry: ApprovalAuditEntry,
    pub effective_request: ApprovalRequest,
    pub dismissed: bool,
    pub grant: Option<ApprovalGrant>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub value: String,
    pub source: String,
    pub freshness: String,
    pub approved: bool,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forgotten_at: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryControlState {
    pub disabled: bool,
    pub records: Vec<MemoryRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportEnvelope {
    pub format: &'static str,
    pub workspace_id: String,
    pub disabled: bool,
    pub disabled_records_included: bool,
    pub forgotten_records_included: bool,
    pub records: Vec<MemoryRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPromotionRequest {
    pub source: KnowledgeSource,
    pub decision: String,
    pub decided_at: String,
    pub state: MemoryControlState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPromotionResponse {
    pub persisted: bool,
    pub record: MemoryRecord,
    pub audit_entry: ApprovalAuditEntry,
    pub state: MemoryControlState,
}

/// A user-created schedule carried in the runtime snapshot. Non-secret: only
/// the task name/description, when it fires, and bookkeeping. Normalization
/// (weekday/time validation, field caps) lives in `snapshot.rs`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub day: String,
    pub time: String,
    pub enabled: bool,
    pub created_at: String,
}

/// A structured workspace goal created by the /goal command. Non-secret by
/// construction: only a title, the user's statement, and lifecycle bookkeeping.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGoal {
    pub id: String,
    pub title: String,
    pub statement: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A single step in a structured plan.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub order: u32,
    pub description: String,
    pub done: bool,
}

/// A structured plan created by the /plan command. Non-secret by construction.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePlan {
    pub id: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    pub title: String,
    pub steps: Vec<PlanStep>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomApprovalSettings {
    #[serde(default)]
    pub allow_small_local_edits: bool,
    #[serde(default)]
    pub allow_powerful_commands: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub version: u8,
    pub active_item: String,
    pub composer_draft: String,
    pub voice_enabled: bool,
    pub approval_audit: Vec<ApprovalAuditEntry>,
    pub dismissed_approval_ids: Vec<String>,
    pub approval_rules: Vec<ApprovalGrant>,
    pub automation_statuses: BTreeMap<String, String>,
    /// User-created schedules. Non-secret state persisted through the snapshot
    /// so it survives a desktop restart. Defaulted so existing v1 snapshot
    /// files written before this field existed still parse cleanly.
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    /// Structured workspace goals created by /goal. Non-secret state persisted
    /// through the snapshot. Defaulted for back-compat with pre-existing files.
    #[serde(default)]
    pub goals: Vec<WorkspaceGoal>,
    /// Structured plans created by /plan. Non-secret state persisted through
    /// the snapshot. Defaulted for back-compat with pre-existing files.
    #[serde(default)]
    pub plans: Vec<WorkspacePlan>,
    pub pinned_source_ids: Vec<String>,
    pub imported_knowledge_sources: Vec<LocalFileImport>,
    pub memory_disabled: bool,
    pub memory_records: Vec<MemoryRecord>,
    /// Provider ids of connected agent-runtime backends. Credentials themselves
    /// never live here — only *which* backends were connected, so the Rust
    /// boundary can re-resolve auth state on recovery.
    pub connected_backend_ids: Vec<String>,
    #[serde(default)]
    pub selected_model_id: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub permission_label: Option<String>,
    #[serde(default)]
    pub custom_approval_settings: Option<CustomApprovalSettings>,
    pub saved_at: String,
}

fn default_permission_mode() -> String {
    "trusted-scope".to_string()
}

// ---------------------------------------------------------------------------
// Scheduler wire models (durable local automation engine).
//
// The trigger is stored as a serde_json::Value (validated shallowly) because
// the recurrence math lives in the TypeScript layer; Rust only owns durable
// storage, the lease lock, and the in-process tick that prevents duplicate
// execution across multiple Fable windows.
// ---------------------------------------------------------------------------

/// The frozen, non-secret execution route captured when a schedule is created.
/// Carries only provider/model ids + permission mode — never keys or tokens.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledExecutionRoute {
    pub policy: String,
    pub backend_id: String,
    pub model_id: String,
    pub permission_mode: String,
    #[serde(default)]
    pub permission_profile: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff_ms: i64,
    pub backoff_multiplier: f64,
    pub max_backoff_ms: i64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: SCHEDULER_MAX_RETRIES + 1,
            initial_backoff_ms: RETRY_BASE_MS,
            backoff_multiplier: 2.0,
            max_backoff_ms: RETRY_MAX_BACKOFF_MS,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    #[serde(default = "default_workspace_id")]
    pub workspace_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub id: String,
    pub schema_version: u8,
    pub name: String,
    pub description: String,
    pub workflow_definition_id: String,
    /// ScheduleTrigger serialized as JSON (validated shallowly in Rust; the TS
    /// layer owns the recurrence/next-run math).
    pub trigger: serde_json::Value,
    pub missed_run_policy: String,
    pub status: String,
    pub next_run_at: String,
    pub last_run_at: String,
    pub last_run_id: String,
    pub created_at: String,
    pub updated_at: String,
    /// Frozen execution route (backend/model/permission). Optional for backward
    /// compatibility with jobs created before this field existed.
    #[serde(default)]
    pub execution: Option<ScheduledExecutionRoute>,
    #[serde(default)]
    pub retry_policy: RetryPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAttempt {
    pub run_id: String,
    pub status: String,
    pub attempt_number: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    /// Whether a failed attempt is transient (retry) or permanent (dead).
    #[serde(default)]
    pub retryable: Option<bool>,
    /// Fencing token proving this attempt corresponds to the current lease.
    #[serde(default)]
    pub lease_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerQueueEntry {
    #[serde(default = "default_workspace_id")]
    pub workspace_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub job_id: String,
    pub run_id: String,
    pub scheduled_at: String,
    pub state: String,
    pub lease_holder: String,
    pub lease_expires_at: String,
    pub attempts: Vec<JobAttempt>,
    pub deduplication_key: String,
    /// Fencing token proving a report/renew call corresponds to the current
    /// lease. Empty on pre-token entries; set whenever a lease is taken.
    #[serde(default)]
    pub lease_token: String,
    /// Earliest retry time (epoch ms ISO) after a transient failure; honored by
    /// the tick so retries respect exponential backoff.
    #[serde(default)]
    pub available_at: String,
    /// Last error message (truncated, no secrets) for failed/blocked entries.
    #[serde(default)]
    pub last_error: String,
    /// Snapshot of the job's execution route at enqueue time, so the entry is
    /// self-describing for the run-request event without a job lookup.
    #[serde(default)]
    pub execution: Option<ScheduledExecutionRoute>,
    #[serde(default)]
    pub retry_policy: RetryPolicy,
}

fn default_workspace_id() -> String {
    crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStore {
    pub schema_version: u8,
    pub jobs: Vec<ScheduledJob>,
    pub queue: Vec<SchedulerQueueEntry>,
    pub instance_id: String,
    pub updated_at: String,
    /// Bounded ledger of seen occurrence dedup keys. Supplements the in-queue
    /// check so a completed-then-removed occurrence can never be re-queued.
    #[serde(default)]
    pub occurrence_ledger: Vec<String>,
}

// ---------------------------------------------------------------------------
// Workflow-run wire models (durable workflow journal).
//
// The per-step records are stored as a serde_json::Value (the rich step record
// shape is owned by the TS protocol); Rust owns atomic persistence + restart
// recovery only.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRecord {
    pub id: String,
    pub definition_id: String,
    pub definition_version: u32,
    pub status: String,
    pub trigger: String,
    pub scheduled_job_id: Option<String>,
    #[serde(default)]
    pub permission_profile: Option<String>,
    pub input: serde_json::Value,
    /// Vec<WorkflowStepRecord> stored as JSON (the step shape is the TS layer's).
    pub steps: serde_json::Value,
    pub failure_reason: Option<String>,
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub attempt_number: Option<u32>,
    #[serde(default)]
    pub next_retry_at: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinitionRecord {
    pub schema_version: u8,
    pub id: String,
    pub version: u32,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub permission_profile: Option<String>,
    pub steps: serde_json::Value,
    pub notification_prefs: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}
