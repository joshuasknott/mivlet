//! Shared constants and wire-format models for the Arden runtime.
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

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub permission_mode: &'static str,
    pub offline_ready: bool,
    pub connector_boundaries: [&'static str; 7],
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
    pub saved_at: String,
}
