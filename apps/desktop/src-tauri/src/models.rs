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
pub const RUNTIME_SNAPSHOT_VERSION: u8 = 1;

// Controlled vocabularies used for validation.
pub const MEMORY_KINDS: [&str; 4] = ["fact", "inference", "preference", "imported"];
pub const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];
pub const APPROVAL_DECISIONS: [&str; 5] = ["once", "session", "rule", "modify", "deny"];
pub const APPROVAL_MODES: [&str; 3] = ["read-only", "trusted-scope", "full-access"];
pub const APPROVAL_RISK_LEVELS: [&str; 4] = ["low", "medium", "high", "critical"];

// Agent-runtime backend vocabularies (controlled, used for validation).
pub const BACKEND_TYPES: [&str; 7] = [
    "codex-app-server",
    "claude-agent",
    "cursor-acp",
    "grok-acp",
    "opencode-server",
    "antigravity-acp",
    "native-api",
];
pub const BACKEND_AUTH_STATES: [&str; 10] = [
    "connected",
    "needs-auth",
    "sign-in-required",
    "install-required",
    "connecting",
    "expired",
    "unsupported",
    "failed",
    "ready",
    "unavailable",
];
/// Backend auth states that fail closed: the adapter declares no capabilities
/// it cannot honor. Mirrors `BACKEND_AUTH_FAIL_CLOSED_STATES` in protocol. Kept
/// as a contract constant — asserted by the vocabulary test in `tests.rs` (which
/// is the only non-test reference), so it is allowed as dead code in the lib.
#[allow(dead_code)]
pub const BACKEND_AUTH_FAIL_CLOSED_STATES: [&str; 9] = [
    "needs-auth",
    "sign-in-required",
    "install-required",
    "connecting",
    "expired",
    "unsupported",
    "failed",
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
pub const SUPPORTED_BACKEND_PROVIDER_IDS: [&str; 10] = [
    "codex",
    "openai",
    "claude",
    "anthropic",
    "antigravity",
    "grok",
    "xai",
    "cursor",
    "opencode",
    "custom",
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

// Supported connector vocabularies.
pub const SUPPORTED_CONNECTOR_IDS: [&str; 8] = [
    "github",
    "vercel",
    "google-drive",
    "notion",
    "gmail",
    "slack",
    "google-calendar",
    "linear",
];
pub const CONNECTOR_AUTH_STATES: [&str; 9] = [
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
#[cfg(test)]
pub const MAX_EXECUTION_ATTEMPTS: usize = 100;
pub const MAX_EXECUTION_ATTEMPT_TRANSCRIPT_CHARACTERS: usize = 200_000;

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
    /// Renderer-facing connector DTOs carry the opaque Fable Connection id
    /// here for compatibility. Raw provider account ids remain native-only.
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
    /// Stable, workspace-bound Fable reference. Provider account ids are never
    /// accepted back as selection authority.
    pub connection_id: String,
    pub account: ConnectorAccountSummary,
    pub active: bool,
    pub lifecycle: String,
    pub authorization_state: String,
    pub health_state: String,
    pub credential_custody: String,
    pub credential_state: String,
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
pub struct ExecutionAttemptUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    #[serde(default)]
    pub cost_estimated: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionExchange {
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub ok: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextRanking {
    pub relevance: f64,
    pub recency: f64,
    pub authority: f64,
    pub pin: f64,
    pub feedback: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextScope {
    pub level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextCitation {
    pub source_id: String,
    pub title: String,
    pub snippet: String,
    pub provenance: String,
    pub freshness: String,
    pub trust: String,
    pub pinned: bool,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub ranking: ExecutionContextRanking,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ExecutionContextScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextAudience {
    pub authority: String,
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acting_member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acting_internal_user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextContribution {
    pub id: String,
    pub kind: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextReceipt {
    pub version: u32,
    #[serde(alias = "runId")]
    pub attempt_id: String,
    pub assembled_at: String,
    pub scope: ExecutionContextScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience: Option<ExecutionContextAudience>,
    pub citations: Vec<ExecutionContextCitation>,
    pub contributions: Vec<ExecutionContextContribution>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRouteObservationSnapshot {
    pub reference: String,
    pub sample_count: usize,
    pub median_latency_ms: u64,
    pub usage_sample_count: usize,
    pub latest_observed_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRouteQualitySnapshot {
    pub reference: String,
    pub policy_revision_ref: String,
    pub sample_count: usize,
    pub passed_count: usize,
    pub routing_score_basis_points: u16,
    pub latest_evaluated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRoutePricingEvidence {
    pub reference: String,
    pub currency_code: String,
    pub input_rate_minor_units: u64,
    pub output_rate_minor_units: u64,
    pub unit_tokens: u64,
    pub source_url: String,
    pub reviewed_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRouteCostSnapshot {
    pub reference: String,
    pub currency_code: String,
    pub input_rate_minor_units: u64,
    pub output_rate_minor_units: u64,
    pub unit_tokens: u64,
    pub source_url: String,
    pub reviewed_at: String,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
    pub estimated_cost_minor_units: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRouteSelection {
    pub provider_route_id: String,
    pub selected_at: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_from_provider_route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_policy_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<ProviderRouteObservationSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<ProviderRouteQualitySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ProviderRouteCostSnapshot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRouteExecutionBinding {
    pub workspace_id: String,
    pub selection: ProviderRouteSelection,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAttempt {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub status: String,
    pub transcript: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub exchanges: Vec<ExecutionExchange>,
    #[serde(default, alias = "parentRunId")]
    pub parent_attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_receipt: Option<ExecutionContextReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_route: Option<ProviderRouteExecutionBinding>,
    pub turn: usize,
    pub usage: Option<ExecutionAttemptUsage>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,
    pub id: String,
    pub title: String,
    pub kind: String,
    pub connector_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub provenance: String,
    pub freshness: String,
    pub pinned: bool,
    pub trust: String,
    pub content_preview: Option<String>,
    pub imported_at: String,
    pub origin: String,
    pub provider_metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
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
    /// Optional per-model capability ceiling. Present only when the runtime has
    /// inspected that specific model (for example, Ollama's local `/api/show`)
    /// and can state it truthfully.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<serde_json::Value>,
}

/// Describes a connected (or connectable) agent-runtime backend. The Rust
/// credential boundary returns this shape to JavaScript — auth state and
/// capabilities only, never raw tokens.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProvider {
    pub id: String,
    pub instance_id: String,
    pub driver_kind: String,
    pub backend_type: String,
    pub label: String,
    pub description: String,
    pub auth_state: String,
    pub capabilities: Vec<String>,
    pub models: Vec<BackendModel>,
    pub setup: ProviderSetup,
    pub install_hint: Option<String>,
    pub entitlements: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetup {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub recommended: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshLocalKnowledgeSourceFile {
    pub name: String,
    pub content: String,
    pub size_bytes: usize,
    pub selected_at: String,
    pub modified_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshLocalKnowledgeSourceRequest {
    pub source_id: String,
    pub expected_content_fingerprint: String,
    pub file: RefreshLocalKnowledgeSourceFile,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKnowledgeRefreshResponse {
    pub outcome: &'static str,
    pub source: LocalFileImport,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRecordAuthorityScope {
    pub authority: String,
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_internal_user_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileImport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
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
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
    #[serde(default)]
    pub scope: Option<serde_json::Value>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
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

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomApprovalSettings {
    #[serde(default)]
    pub allow_small_local_edits: bool,
    #[serde(default)]
    pub allow_powerful_commands: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FableAgentProfile {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub icon: String,
    #[serde(default)]
    pub icon_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_seed: Option<String>,
    #[serde(default)]
    pub icon_image_data_url: Option<String>,
    #[serde(default)]
    pub connector_ids: Vec<String>,
    #[serde(default)]
    pub knowledge_source_ids: Vec<String>,
    pub permission_label: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub learned_tasks: Vec<FableLearnedTask>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FableLearnedTask {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub created_at: String,
    pub updated_at: String,
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
    /// User-owned agent identities and their non-secret execution preferences.
    #[serde(default)]
    pub agents: Vec<FableAgentProfile>,
    #[serde(default)]
    pub active_agent_id: Option<String>,
    pub pinned_source_ids: Vec<String>,
    pub imported_knowledge_sources: Vec<LocalFileImport>,
    pub memory_disabled: bool,
    pub memory_records: Vec<MemoryRecord>,
    /// Provider ids of connected agent-runtime backends. Credentials themselves
    /// never live here — only *which* backends were connected, so the Rust
    /// boundary can re-resolve auth state on recovery.
    pub connected_backend_ids: Vec<String>,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub onboarding_version: u8,
    #[serde(default)]
    pub selected_model_id: String,
    #[serde(default)]
    pub hidden_model_ids: Vec<String>,
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
