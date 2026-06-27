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
pub const RUNTIME_SNAPSHOT_VERSION: u8 = 1;

// Controlled vocabularies used for validation.
pub const MEMORY_KINDS: [&str; 4] = ["fact", "inference", "preference", "imported"];
pub const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];
pub const APPROVAL_DECISIONS: [&str; 5] = ["once", "session", "rule", "modify", "deny"];
pub const APPROVAL_MODES: [&str; 3] = ["read-only", "trusted-scope", "full-access"];
pub const APPROVAL_RISK_LEVELS: [&str; 4] = ["low", "medium", "high", "critical"];
pub const AUTOMATION_STATUSES: [&str; 3] = ["draft", "active", "paused"];

// Agent-runtime backend vocabularies (controlled, used for validation).
pub const BACKEND_TYPES: [&str; 4] = ["codex-app-server", "acp", "copilot-sdk", "native-api"];
pub const BACKEND_AUTH_STATES: [&str; 5] = [
    "connected",
    "needs-auth",
    "install-required",
    "entitlement-pending",
    "unavailable",
];
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
pub const CONNECTOR_AUTH_STATES: [&str; 7] = [
    "fixture",
    "needs-auth",
    "configured",
    "connected",
    "expired",
    "error",
    "unavailable",
];
pub const CONNECTOR_ACTIONS: [&str; 25] = [
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
    "gmail.create-draft",
    "gmail.send",
    "slack.create-draft",
    "slack.post",
    "google-calendar.create-draft",
    "google-calendar.update-draft",
];
pub const MAX_CONNECTOR_QUERY_CHARACTERS: usize = 500;
pub const MAX_CONNECTOR_RESULT_LIMIT: usize = 50;
pub const MAX_CONNECTOR_PAYLOAD_FIELDS: usize = 32;
pub const MAX_AGENT_RUNS: usize = 100;
pub const MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS: usize = 200_000;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuthRequest {
    pub connector_id: String,
    pub redirect_uri: Option<String>,
    pub callback_url: Option<String>,
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
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentRun {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub status: String,
    pub transcript: String,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryControlState {
    pub disabled: bool,
    pub records: Vec<MemoryRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportEnvelope {
    pub format: &'static str,
    pub disabled: bool,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
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
    pub saved_at: String,
}

fn default_permission_mode() -> String {
    "read-only".to_string()
}
