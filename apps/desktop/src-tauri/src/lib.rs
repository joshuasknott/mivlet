use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_LOCAL_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_FILE_PREVIEW_CHARACTERS: usize = 6_000;
const DEFAULT_RESULT_LIMIT: usize = 5;
const MAX_SNIPPET_CHARACTERS: usize = 240;
const MAX_APPROVAL_AUDIT_ENTRIES: usize = 200;
const MAX_APPROVAL_AUDIT_NOTE_CHARACTERS: usize = 240;
const MAX_APPROVAL_RULES: usize = 100;
const MAX_IMPORTED_KNOWLEDGE_SOURCES: usize = 100;
const MAX_MEMORY_RECORDS: usize = 200;
const MAX_MEMORY_TITLE_CHARACTERS: usize = 120;
const MAX_MEMORY_VALUE_CHARACTERS: usize = 2_000;
const MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS: usize = 20_000;
const MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS: usize = 160;
const MAX_RUNTIME_SNAPSHOT_IDS: usize = 200;
const MAX_RUNTIME_SNAPSHOT_AUTOMATIONS: usize = 100;
const RUNTIME_SNAPSHOT_VERSION: u8 = 1;
const MEMORY_KINDS: [&str; 4] = ["fact", "inference", "preference", "imported"];
const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];
const APPROVAL_DECISIONS: [&str; 5] = ["once", "session", "rule", "modify", "deny"];
const APPROVAL_MODES: [&str; 3] = ["read-only", "trusted-scope", "full-access"];
const APPROVAL_RISK_LEVELS: [&str; 4] = ["low", "medium", "high", "critical"];
const AUTOMATION_STATUSES: [&str; 3] = ["draft", "active", "paused"];

#[derive(Serialize)]
struct RuntimeStatus {
    permission_mode: &'static str,
    offline_ready: bool,
    connector_boundaries: [&'static str; 7],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTextFileCandidate {
    name: String,
    content: String,
    size_bytes: usize,
    imported_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileImport {
    id: String,
    title: String,
    kind: String,
    connector_id: String,
    provenance: String,
    freshness: String,
    pinned: bool,
    trust: String,
    content_preview: String,
    content_fingerprint: String,
    size_bytes: usize,
    imported_at: String,
    origin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSource {
    id: String,
    title: String,
    provenance: String,
    freshness: String,
    pinned: bool,
    trust: Option<String>,
    content_preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCitation {
    source_id: String,
    title: String,
    snippet: String,
    provenance: String,
    freshness: String,
    trust: String,
    pinned: bool,
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSearchResponse {
    query: String,
    mode: &'static str,
    citations: Vec<KnowledgeCitation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalAuditEntry {
    id: String,
    request_id: String,
    decision: String,
    decided_at: String,
    note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalAuditRecordResponse {
    persisted: bool,
    entry: ApprovalAuditEntry,
    audit_len: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    id: String,
    service: String,
    action: String,
    mode: String,
    risk_level: String,
    data_used: Vec<String>,
    consequence: String,
    requested_at: String,
    decisions: Vec<String>,
    confirmation_phrase: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalModification {
    mode: String,
    data_used: Vec<String>,
    consequence: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalGrant {
    id: String,
    request_id: String,
    scope: String,
    service: String,
    action: String,
    mode: String,
    data_used: Vec<String>,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResolutionRequest {
    request: ApprovalRequest,
    decision: String,
    decided_at: String,
    confirmation_text: Option<String>,
    modification: Option<ApprovalModification>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResolutionResponse {
    persisted: bool,
    audit_entry: ApprovalAuditEntry,
    effective_request: ApprovalRequest,
    dismissed: bool,
    grant: Option<ApprovalGrant>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryRecord {
    id: String,
    kind: String,
    title: String,
    value: String,
    source: String,
    freshness: String,
    approved: bool,
    pinned: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryControlState {
    disabled: bool,
    records: Vec<MemoryRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportEnvelope {
    format: &'static str,
    disabled: bool,
    records: Vec<MemoryRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPromotionRequest {
    source: KnowledgeSource,
    decision: String,
    decided_at: String,
    state: MemoryControlState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPromotionResponse {
    persisted: bool,
    record: MemoryRecord,
    audit_entry: ApprovalAuditEntry,
    state: MemoryControlState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshot {
    version: u8,
    active_item: String,
    composer_draft: String,
    voice_enabled: bool,
    approval_audit: Vec<ApprovalAuditEntry>,
    dismissed_approval_ids: Vec<String>,
    approval_rules: Vec<ApprovalGrant>,
    automation_statuses: BTreeMap<String, String>,
    pinned_source_ids: Vec<String>,
    imported_knowledge_sources: Vec<LocalFileImport>,
    memory_disabled: bool,
    memory_records: Vec<MemoryRecord>,
    saved_at: String,
}

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        permission_mode: "read-only",
        offline_ready: true,
        connector_boundaries: [
            "local-files",
            "github",
            "google-drive",
            "slack",
            "notion",
            "linear",
            "vercel",
        ],
    }
}

fn app_data_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Arden could not resolve the app data folder.".to_string())?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|_| "Arden could not prepare the app data folder.".to_string())?;

    Ok(app_data_dir.join(file_name))
}

fn approval_audit_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "approval-audit.json")
}

fn approval_rules_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "approval-rules.json")
}

fn imported_knowledge_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "imported-knowledge.json")
}

fn memory_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "memory-state.json")
}

fn runtime_snapshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "runtime-snapshot.json")
}

fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_characters(value: &str, max_characters: usize) -> String {
    if value.chars().count() <= max_characters {
        return value.to_string();
    }

    value.chars().take(max_characters).collect()
}

fn normalize_approval_audit_entry(entry: ApprovalAuditEntry) -> Result<ApprovalAuditEntry, String> {
    let id = normalize_spaces(&entry.id);
    let request_id = normalize_spaces(&entry.request_id);
    let decision = normalize_spaces(&entry.decision).to_ascii_lowercase();
    let decided_at = normalize_spaces(&entry.decided_at);
    let note = truncate_characters(
        &normalize_spaces(&entry.note),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );

    if id.is_empty() || request_id.is_empty() {
        return Err("Approval audit entries need stable request identifiers.".to_string());
    }

    if !APPROVAL_DECISIONS.contains(&decision.as_str()) {
        return Err("Approval decision is not recognized.".to_string());
    }

    if decided_at.is_empty() {
        return Err("Approval audit entries need a decision time.".to_string());
    }

    if note.is_empty() {
        return Err("Approval audit entries need a short note.".to_string());
    }

    Ok(ApprovalAuditEntry {
        id,
        request_id,
        decision,
        decided_at,
        note,
    })
}

fn read_approval_audit_entries(path: &Path) -> Result<Vec<ApprovalAuditEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Arden could not read the approval audit log.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<ApprovalAuditEntry>>(&contents)
        .map_err(|_| "Arden could not parse the approval audit log.".to_string())
}

fn append_approval_audit_entry(
    mut entries: Vec<ApprovalAuditEntry>,
    entry: ApprovalAuditEntry,
) -> Vec<ApprovalAuditEntry> {
    entries.retain(|existing| existing.id != entry.id);
    entries.insert(0, entry);
    entries.truncate(MAX_APPROVAL_AUDIT_ENTRIES);
    entries
}

fn write_approval_audit_entries(path: &Path, entries: &[ApprovalAuditEntry]) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(entries)
        .map_err(|_| "Arden could not encode the approval audit log.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Arden could not save the approval audit log.".to_string())
}

fn persist_approval_audit_entry(
    path: &Path,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let entry = normalize_approval_audit_entry(entry)?;
    let entries = read_approval_audit_entries(path)?;
    let entries = append_approval_audit_entry(entries, entry.clone());
    write_approval_audit_entries(path, &entries)?;

    Ok(ApprovalAuditRecordResponse {
        persisted: true,
        entry,
        audit_len: entries.len(),
    })
}

fn normalize_approval_data(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized_values = Vec::new();

    for value in values {
        let normalized = truncate_characters(
            &normalize_spaces(&value),
            MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
        );
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        normalized_values.push(normalized);
    }

    normalized_values
}

fn normalize_approval_request(request: ApprovalRequest) -> Result<ApprovalRequest, String> {
    let id = truncate_characters(
        &normalize_spaces(&request.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let service = truncate_characters(
        &normalize_spaces(&request.service),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let action = truncate_characters(
        &normalize_spaces(&request.action),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );
    let mode = normalize_spaces(&request.mode).to_ascii_lowercase();
    let risk_level = normalize_spaces(&request.risk_level).to_ascii_lowercase();
    let consequence = truncate_characters(
        &normalize_spaces(&request.consequence),
        MAX_MEMORY_VALUE_CHARACTERS,
    );
    let requested_at = normalize_spaces(&request.requested_at);
    let decisions = request
        .decisions
        .into_iter()
        .map(|decision| normalize_spaces(&decision).to_ascii_lowercase())
        .filter(|decision| APPROVAL_DECISIONS.contains(&decision.as_str()))
        .collect::<Vec<_>>();
    let confirmation_phrase = request
        .confirmation_phrase
        .map(|phrase| truncate_characters(&normalize_spaces(&phrase), 120))
        .filter(|phrase| !phrase.is_empty());

    if id.is_empty()
        || service.is_empty()
        || action.is_empty()
        || consequence.is_empty()
        || requested_at.is_empty()
    {
        return Err(
            "Approval requests need identity, service, action, consequence, and time.".to_string(),
        );
    }
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err("Approval mode is not recognized.".to_string());
    }
    if !APPROVAL_RISK_LEVELS.contains(&risk_level.as_str()) {
        return Err("Approval risk level is not recognized.".to_string());
    }
    if decisions.is_empty() {
        return Err("Approval requests need at least one available decision.".to_string());
    }

    Ok(ApprovalRequest {
        id,
        service,
        action,
        mode,
        risk_level,
        data_used: normalize_approval_data(request.data_used),
        consequence,
        requested_at,
        decisions,
        confirmation_phrase,
    })
}

fn normalize_approval_grant(grant: ApprovalGrant) -> Result<ApprovalGrant, String> {
    let id = truncate_characters(
        &normalize_spaces(&grant.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let request_id = truncate_characters(
        &normalize_spaces(&grant.request_id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let scope = normalize_spaces(&grant.scope).to_ascii_lowercase();
    let service = truncate_characters(
        &normalize_spaces(&grant.service),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let action = truncate_characters(
        &normalize_spaces(&grant.action),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );
    let mode = normalize_spaces(&grant.mode).to_ascii_lowercase();
    let created_at = normalize_spaces(&grant.created_at);

    if id.is_empty()
        || request_id.is_empty()
        || service.is_empty()
        || action.is_empty()
        || created_at.is_empty()
    {
        return Err("Approval grants need stable request and scope metadata.".to_string());
    }
    if scope != "session" && scope != "rule" {
        return Err("Approval grant scope is not recognized.".to_string());
    }
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err("Approval grant mode is not recognized.".to_string());
    }

    Ok(ApprovalGrant {
        id,
        request_id,
        scope,
        service,
        action,
        mode,
        data_used: normalize_approval_data(grant.data_used),
        created_at,
    })
}

fn read_approval_rules(path: &Path) -> Result<Vec<ApprovalGrant>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(path).map_err(|_| "Arden could not read approval rules.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<ApprovalGrant>>(&contents)
        .map_err(|_| "Arden could not parse approval rules.".to_string())?;
    parsed
        .into_iter()
        .map(normalize_approval_grant)
        .collect::<Result<Vec<_>, _>>()
}

fn write_approval_rules(path: &Path, rules: &[ApprovalGrant]) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(rules)
        .map_err(|_| "Arden could not encode approval rules.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Arden could not save approval rules.".to_string())
}

fn persist_approval_rule(path: &Path, grant: ApprovalGrant) -> Result<ApprovalGrant, String> {
    let grant = normalize_approval_grant(grant)?;
    if grant.scope != "rule" {
        return Err("Only standing rule grants can be persisted.".to_string());
    }

    let mut rules = read_approval_rules(path)?;
    rules.retain(|existing| {
        !(existing.service == grant.service
            && existing.action == grant.action
            && existing.mode == grant.mode)
    });
    rules.insert(0, grant.clone());
    rules.truncate(MAX_APPROVAL_RULES);
    write_approval_rules(path, &rules)?;
    Ok(grant)
}

fn resolve_approval(
    request: ApprovalResolutionRequest,
) -> Result<ApprovalResolutionResponse, String> {
    let original = normalize_approval_request(request.request)?;
    let decision = normalize_spaces(&request.decision).to_ascii_lowercase();
    let decided_at = normalize_spaces(&request.decided_at);

    if !APPROVAL_DECISIONS.contains(&decision.as_str()) || !original.decisions.contains(&decision) {
        return Err("Approval decision is not available for this request.".to_string());
    }
    if decided_at.is_empty() {
        return Err("Approval decisions need a decision time.".to_string());
    }

    let effective_request = if decision == "modify" {
        let modification = request
            .modification
            .ok_or_else(|| "Modified approvals need a narrowed permission scope.".to_string())?;
        let mode = normalize_spaces(&modification.mode).to_ascii_lowercase();
        if !APPROVAL_MODES.contains(&mode.as_str()) {
            return Err("Modified approval mode is not recognized.".to_string());
        }

        ApprovalRequest {
            mode,
            data_used: normalize_approval_data(modification.data_used),
            consequence: truncate_characters(
                &normalize_spaces(&modification.consequence),
                MAX_MEMORY_VALUE_CHARACTERS,
            ),
            ..original.clone()
        }
    } else {
        original.clone()
    };

    if effective_request.consequence.is_empty() {
        return Err("Modified approvals need a consequence explanation.".to_string());
    }

    let approving = matches!(decision.as_str(), "once" | "session" | "rule" | "modify");
    let high_risk = matches!(effective_request.risk_level.as_str(), "high" | "critical")
        || effective_request.mode == "full-access";
    if approving && high_risk {
        let expected = effective_request
            .confirmation_phrase
            .as_deref()
            .ok_or_else(|| "High-risk approvals need a confirmation phrase.".to_string())?;
        let provided = request
            .confirmation_text
            .as_deref()
            .map(normalize_spaces)
            .unwrap_or_default();
        if provided != expected {
            return Err("Confirmation phrase did not match.".to_string());
        }
    }

    let grant = match decision.as_str() {
        "session" | "rule" => Some(normalize_approval_grant(ApprovalGrant {
            id: format!(
                "approval-{}-{}",
                decision,
                file_slug(&format!(
                    "{}-{}",
                    effective_request.service, effective_request.action
                ))
            ),
            request_id: effective_request.id.clone(),
            scope: decision.clone(),
            service: effective_request.service.clone(),
            action: effective_request.action.clone(),
            mode: effective_request.mode.clone(),
            data_used: effective_request.data_used.clone(),
            created_at: decided_at.clone(),
        })?),
        _ => None,
    };
    let note = if decision == "modify" {
        format!(
            "{} {} modified to {} using {}",
            effective_request.service,
            effective_request.action,
            effective_request.mode,
            effective_request.data_used.join(", ")
        )
    } else {
        format!("{} {}", effective_request.service, effective_request.action)
    };
    let audit_entry = normalize_approval_audit_entry(ApprovalAuditEntry {
        id: format!(
            "{}-{}-{}",
            effective_request.id,
            decision,
            file_slug(&decided_at)
        ),
        request_id: effective_request.id.clone(),
        decision,
        decided_at,
        note,
    })?;

    Ok(ApprovalResolutionResponse {
        persisted: false,
        audit_entry,
        effective_request,
        dismissed: true,
        grant,
    })
}

fn read_imported_knowledge_sources(path: &Path) -> Result<Vec<LocalFileImport>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Arden could not read imported knowledge sources.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<LocalFileImport>>(&contents)
        .map_err(|_| "Arden could not parse imported knowledge sources.".to_string())
}

fn append_imported_knowledge_source(
    mut sources: Vec<LocalFileImport>,
    source: LocalFileImport,
) -> Vec<LocalFileImport> {
    sources.retain(|existing| existing.id != source.id);
    sources.insert(0, source);
    sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
    sources
}

fn normalize_imported_knowledge_source(source: LocalFileImport) -> Result<LocalFileImport, String> {
    let id = truncate_characters(
        &normalize_spaces(&source.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let title = truncate_characters(
        &normalize_spaces(&source.title),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let provenance = truncate_characters(
        &normalize_spaces(&source.provenance),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let freshness = truncate_characters(
        &normalize_spaces(&source.freshness),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let content_fingerprint = normalize_spaces(&source.content_fingerprint);
    let imported_at = normalize_spaces(&source.imported_at);

    if id.is_empty() || title.is_empty() || content_fingerprint.is_empty() || imported_at.is_empty()
    {
        return Err("Imported knowledge sources need stable identifiers and metadata.".to_string());
    }

    if source.kind != "document"
        || source.connector_id != "local-files"
        || source.trust != "untrusted"
        || source.origin != "local-import"
    {
        return Err(
            "Imported knowledge sources must stay local, document-shaped, and untrusted."
                .to_string(),
        );
    }

    if source.size_bytes > MAX_LOCAL_FILE_BYTES {
        return Err("Imported knowledge source is too large for local recovery.".to_string());
    }

    Ok(LocalFileImport {
        id,
        title,
        kind: "document".to_string(),
        connector_id: "local-files".to_string(),
        provenance: if provenance.is_empty() {
            "Local file".to_string()
        } else {
            provenance
        },
        freshness: if freshness.is_empty() {
            "Imported now".to_string()
        } else {
            freshness
        },
        pinned: source.pinned,
        trust: "untrusted".to_string(),
        content_preview: truncate_characters(
            &normalize_spaces(&source.content_preview),
            MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
        ),
        content_fingerprint,
        size_bytes: source.size_bytes,
        imported_at,
        origin: "local-import".to_string(),
    })
}

fn write_imported_knowledge_sources(
    path: &Path,
    sources: &[LocalFileImport],
) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(sources)
        .map_err(|_| "Arden could not encode imported knowledge sources.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Arden could not save imported knowledge sources.".to_string())
}

fn persist_imported_knowledge_source(
    path: &Path,
    source: LocalFileImport,
) -> Result<LocalFileImport, String> {
    let source = normalize_imported_knowledge_source(source)?;
    let sources = read_imported_knowledge_sources(path)?;
    let sources = append_imported_knowledge_source(sources, source.clone());
    write_imported_knowledge_sources(path, &sources)?;

    Ok(source)
}

fn default_memory_state() -> MemoryControlState {
    MemoryControlState {
        disabled: false,
        records: Vec::new(),
    }
}

fn normalize_memory_record(record: MemoryRecord) -> Result<MemoryRecord, String> {
    let id = normalize_spaces(&record.id);
    let kind = normalize_spaces(&record.kind).to_ascii_lowercase();
    let title = truncate_characters(
        &normalize_spaces(&record.title),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let value = truncate_characters(
        &normalize_spaces(&record.value),
        MAX_MEMORY_VALUE_CHARACTERS,
    );
    let source = truncate_characters(
        &normalize_spaces(&record.source),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let freshness = truncate_characters(
        &normalize_spaces(&record.freshness),
        MAX_MEMORY_TITLE_CHARACTERS,
    );

    if id.is_empty() || title.is_empty() || value.is_empty() {
        return Err("Memory records need stable identifiers, titles, and values.".to_string());
    }

    if !MEMORY_KINDS.contains(&kind.as_str()) {
        return Err("Memory kind is not recognized.".to_string());
    }

    Ok(MemoryRecord {
        id,
        kind,
        title,
        value,
        source: if source.is_empty() {
            "Arden memory".to_string()
        } else {
            source
        },
        freshness: if freshness.is_empty() {
            "Updated now".to_string()
        } else {
            freshness
        },
        approved: record.approved,
        pinned: record.pinned,
    })
}

fn normalize_memory_state(state: MemoryControlState) -> Result<MemoryControlState, String> {
    let mut records = Vec::new();

    for record in state.records {
        let normalized = normalize_memory_record(record)?;
        if !records
            .iter()
            .any(|existing: &MemoryRecord| existing.id == normalized.id)
        {
            records.push(normalized);
        }

        if records.len() >= MAX_MEMORY_RECORDS {
            break;
        }
    }

    Ok(MemoryControlState {
        disabled: state.disabled,
        records,
    })
}

fn read_memory_state(path: &Path) -> Result<MemoryControlState, String> {
    if !path.exists() {
        return Ok(default_memory_state());
    }

    let contents =
        fs::read_to_string(path).map_err(|_| "Arden could not read memory state.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(default_memory_state());
    }

    let parsed = serde_json::from_str::<MemoryControlState>(&contents)
        .map_err(|_| "Arden could not parse memory state.".to_string())?;

    normalize_memory_state(parsed)
}

fn write_memory_state(
    path: &Path,
    state: MemoryControlState,
) -> Result<MemoryControlState, String> {
    let normalized = normalize_memory_state(state)?;
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Arden could not encode memory state.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Arden could not save memory state.".to_string())?;

    Ok(normalized)
}

fn encode_memory_export(state: MemoryControlState) -> Result<String, String> {
    let normalized = normalize_memory_state(state)?;
    let envelope = MemoryExportEnvelope {
        format: "arden.memory.export.v1",
        disabled: normalized.disabled,
        records: normalized.records,
    };

    serde_json::to_string_pretty(&envelope)
        .map_err(|_| "Arden could not encode memory export.".to_string())
}

fn promote_knowledge_source(
    request: MemoryPromotionRequest,
) -> Result<MemoryPromotionResponse, String> {
    let decision = normalize_spaces(&request.decision).to_ascii_lowercase();
    if !["once", "session", "rule"].contains(&decision.as_str()) {
        return Err("Memory promotion requires once, session, or rule approval.".to_string());
    }

    let decided_at = normalize_spaces(&request.decided_at);
    if decided_at.is_empty() {
        return Err("Memory promotion needs an approval time.".to_string());
    }

    let source_id = truncate_characters(
        &normalize_spaces(&request.source.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let title = truncate_characters(
        &normalize_spaces(&request.source.title),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let provenance = truncate_characters(
        &normalize_spaces(&request.source.provenance),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let freshness = truncate_characters(
        &normalize_spaces(&request.source.freshness),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let trust = normalize_spaces(
        &request
            .source
            .trust
            .unwrap_or_else(|| "untrusted".to_string()),
    )
    .to_ascii_lowercase();
    let preview = request
        .source
        .content_preview
        .as_deref()
        .map(normalize_spaces)
        .unwrap_or_default();

    if source_id.is_empty() || title.is_empty() || provenance.is_empty() {
        return Err("Memory promotion needs source identity and provenance.".to_string());
    }

    if trust != "trusted" && trust != "untrusted" {
        return Err("Memory promotion source trust is not recognized.".to_string());
    }

    let current_state = normalize_memory_state(request.state)?;
    if current_state.disabled {
        return Err("Memory is disabled.".to_string());
    }

    let value = if preview.is_empty() {
        format!("{title} from {provenance}. Freshness: {freshness}.")
    } else {
        preview
    };
    let record_id = format!("memory-from-{}", file_slug(&source_id));
    let source_label = if trust == "untrusted" {
        format!("Approved from untrusted source: {provenance}")
    } else {
        format!("Approved from trusted source: {provenance}")
    };
    let record = normalize_memory_record(MemoryRecord {
        id: record_id.clone(),
        kind: "imported".to_string(),
        title,
        value,
        source: source_label,
        freshness: "Approved now".to_string(),
        approved: true,
        pinned: true,
    })?;

    let mut records = current_state.records;
    records.retain(|existing| existing.id != record_id);
    records.insert(0, record.clone());
    let state = normalize_memory_state(MemoryControlState {
        disabled: false,
        records,
    })?;
    let audit_entry = normalize_approval_audit_entry(ApprovalAuditEntry {
        id: format!(
            "memory-promotion-{}-{}",
            file_slug(&source_id),
            file_slug(&decided_at)
        ),
        request_id: format!("memory-promotion-{source_id}"),
        decision,
        decided_at,
        note: format!("Arden Memory Approve {provenance} into durable memory"),
    })?;

    Ok(MemoryPromotionResponse {
        persisted: false,
        record,
        audit_entry,
        state,
    })
}

fn normalize_snapshot_id_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized_values = Vec::new();

    for value in values {
        let normalized = truncate_characters(
            &normalize_spaces(&value),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }

        normalized_values.push(normalized);
        if normalized_values.len() >= MAX_RUNTIME_SNAPSHOT_IDS {
            break;
        }
    }

    normalized_values
}

fn normalize_runtime_automation_statuses(
    statuses: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut normalized_statuses = BTreeMap::new();

    for (id, status) in statuses {
        let normalized_id =
            truncate_characters(&normalize_spaces(&id), MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS);
        let normalized_status = normalize_spaces(&status).to_ascii_lowercase();

        if normalized_id.is_empty() {
            continue;
        }

        if !AUTOMATION_STATUSES.contains(&normalized_status.as_str()) {
            return Err("Automation status is not recognized.".to_string());
        }

        normalized_statuses.insert(normalized_id, normalized_status);
        if normalized_statuses.len() >= MAX_RUNTIME_SNAPSHOT_AUTOMATIONS {
            break;
        }
    }

    Ok(normalized_statuses)
}

fn normalize_runtime_snapshot(snapshot: RuntimeSnapshot) -> Result<RuntimeSnapshot, String> {
    if snapshot.version != RUNTIME_SNAPSHOT_VERSION {
        return Err("Runtime snapshot version is not supported.".to_string());
    }

    let active_item = truncate_characters(
        &normalize_spaces(&snapshot.active_item),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let composer_draft = truncate_characters(
        &snapshot.composer_draft,
        MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS,
    );
    let saved_at = normalize_spaces(&snapshot.saved_at);

    if active_item.is_empty() {
        return Err("Runtime snapshots need an active workspace item.".to_string());
    }

    if saved_at.is_empty() {
        return Err("Runtime snapshots need a saved time.".to_string());
    }

    let mut approval_audit = Vec::new();
    for entry in snapshot.approval_audit {
        let normalized = normalize_approval_audit_entry(entry)?;
        if !approval_audit
            .iter()
            .any(|existing: &ApprovalAuditEntry| existing.id == normalized.id)
        {
            approval_audit.push(normalized);
        }

        if approval_audit.len() >= MAX_APPROVAL_AUDIT_ENTRIES {
            break;
        }
    }

    let mut approval_rules = Vec::new();
    for grant in snapshot.approval_rules {
        let normalized = normalize_approval_grant(grant)?;
        if normalized.scope != "rule" {
            continue;
        }
        if !approval_rules.iter().any(|existing: &ApprovalGrant| {
            existing.service == normalized.service
                && existing.action == normalized.action
                && existing.mode == normalized.mode
        }) {
            approval_rules.push(normalized);
        }
        if approval_rules.len() >= MAX_APPROVAL_RULES {
            break;
        }
    }

    let mut imported_knowledge_sources = Vec::new();
    for source in snapshot.imported_knowledge_sources {
        let normalized = normalize_imported_knowledge_source(source)?;
        if !imported_knowledge_sources
            .iter()
            .any(|existing: &LocalFileImport| existing.id == normalized.id)
        {
            imported_knowledge_sources.push(normalized);
        }

        if imported_knowledge_sources.len() >= MAX_IMPORTED_KNOWLEDGE_SOURCES {
            break;
        }
    }

    let memory_state = normalize_memory_state(MemoryControlState {
        disabled: snapshot.memory_disabled,
        records: snapshot.memory_records,
    })?;

    Ok(RuntimeSnapshot {
        version: RUNTIME_SNAPSHOT_VERSION,
        active_item,
        composer_draft,
        voice_enabled: snapshot.voice_enabled,
        approval_audit,
        dismissed_approval_ids: normalize_snapshot_id_list(snapshot.dismissed_approval_ids),
        approval_rules,
        automation_statuses: normalize_runtime_automation_statuses(snapshot.automation_statuses)?,
        pinned_source_ids: normalize_snapshot_id_list(snapshot.pinned_source_ids),
        imported_knowledge_sources,
        memory_disabled: memory_state.disabled,
        memory_records: memory_state.records,
        saved_at,
    })
}

fn read_runtime_snapshot(path: &Path) -> Result<Option<RuntimeSnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Arden could not read runtime snapshot.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<RuntimeSnapshot>(&contents)
        .map_err(|_| "Arden could not parse runtime snapshot.".to_string())?;

    normalize_runtime_snapshot(parsed).map(Some)
}

fn write_runtime_snapshot(
    path: &Path,
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    let normalized = normalize_runtime_snapshot(snapshot)?;
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Arden could not encode runtime snapshot.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Arden could not save runtime snapshot.".to_string())?;

    Ok(normalized)
}

#[tauri::command]
fn list_approval_audit(app: tauri::AppHandle) -> Result<Vec<ApprovalAuditEntry>, String> {
    let path = approval_audit_path(&app)?;
    read_approval_audit_entries(&path)
}

#[tauri::command]
fn list_approval_rules(app: tauri::AppHandle) -> Result<Vec<ApprovalGrant>, String> {
    let path = approval_rules_path(&app)?;
    read_approval_rules(&path)
}

#[tauri::command]
fn record_approval_decision(
    app: tauri::AppHandle,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let path = approval_audit_path(&app)?;
    persist_approval_audit_entry(&path, entry)
}

#[tauri::command]
fn resolve_approval_request(
    app: tauri::AppHandle,
    request: ApprovalResolutionRequest,
) -> Result<ApprovalResolutionResponse, String> {
    let response = resolve_approval(request)?;
    let audit_path = approval_audit_path(&app)?;
    let audit = persist_approval_audit_entry(&audit_path, response.audit_entry)?;
    let grant = match response.grant {
        Some(grant) if grant.scope == "rule" => {
            let path = approval_rules_path(&app)?;
            Some(persist_approval_rule(&path, grant)?)
        }
        grant => grant,
    };

    Ok(ApprovalResolutionResponse {
        persisted: true,
        audit_entry: audit.entry,
        effective_request: response.effective_request,
        dismissed: response.dismissed,
        grant,
    })
}

#[tauri::command]
fn list_imported_knowledge_sources(app: tauri::AppHandle) -> Result<Vec<LocalFileImport>, String> {
    let path = imported_knowledge_path(&app)?;
    read_imported_knowledge_sources(&path)
}

#[tauri::command]
fn import_local_knowledge_source(
    app: tauri::AppHandle,
    candidate: LocalTextFileCandidate,
) -> Result<LocalFileImport, String> {
    let imported = import_local_text_file(candidate)?;
    let path = imported_knowledge_path(&app)?;
    persist_imported_knowledge_source(&path, imported)
}

#[tauri::command]
fn list_memory_state(app: tauri::AppHandle) -> Result<MemoryControlState, String> {
    let path = memory_state_path(&app)?;
    read_memory_state(&path)
}

#[tauri::command]
fn save_memory_state(
    app: tauri::AppHandle,
    state: MemoryControlState,
) -> Result<MemoryControlState, String> {
    let path = memory_state_path(&app)?;
    write_memory_state(&path, state)
}

#[tauri::command]
fn export_memory_state(state: MemoryControlState) -> Result<String, String> {
    encode_memory_export(state)
}

#[tauri::command]
fn promote_knowledge_source_to_memory(
    app: tauri::AppHandle,
    request: MemoryPromotionRequest,
) -> Result<MemoryPromotionResponse, String> {
    let response = promote_knowledge_source(request)?;
    let memory_path = memory_state_path(&app)?;
    let state = write_memory_state(&memory_path, response.state)?;
    let audit_path = approval_audit_path(&app)?;
    let audit_response = persist_approval_audit_entry(&audit_path, response.audit_entry)?;

    Ok(MemoryPromotionResponse {
        persisted: true,
        record: response.record,
        audit_entry: audit_response.entry,
        state,
    })
}

#[tauri::command]
fn load_runtime_snapshot(app: tauri::AppHandle) -> Result<Option<RuntimeSnapshot>, String> {
    let path = runtime_snapshot_path(&app)?;
    read_runtime_snapshot(&path)
}

#[tauri::command]
fn save_runtime_snapshot(
    app: tauri::AppHandle,
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    let path = runtime_snapshot_path(&app)?;
    write_runtime_snapshot(&path, snapshot)
}

fn extension_for(file_name: &str) -> String {
    file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_supported_local_file(file_name: &str) -> bool {
    let extension = extension_for(file_name);
    SUPPORTED_LOCAL_FILE_EXTENSIONS
        .iter()
        .any(|supported| *supported == extension)
}

fn file_slug(file_name: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in file_name.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }

        if slug.len() >= 40 {
            break;
        }
    }

    slug.trim_matches('-').to_string()
}

fn format_file_size(size_bytes: usize) -> String {
    if size_bytes < 1_024 {
        return format!("{size_bytes} B");
    }

    format!("{:.1} KB", size_bytes as f64 / 1_024.0)
}

fn local_file_fingerprint(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    let prime = 0x100000001b3_u64;

    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(prime);
    }

    format!("{hash:016x}")
}

fn preview_text(content: &str) -> String {
    content
        .chars()
        .take(MAX_LOCAL_FILE_PREVIEW_CHARACTERS)
        .collect()
}

#[tauri::command]
fn import_local_text_file(candidate: LocalTextFileCandidate) -> Result<LocalFileImport, String> {
    let file_name = candidate
        .name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();

    if file_name.is_empty() {
        return Err("Choose a file with a valid name.".to_string());
    }

    if !is_supported_local_file(&file_name) {
        return Err("Arden supports text, Markdown, JSON, CSV, and YAML files.".to_string());
    }

    let actual_size_bytes = candidate.content.len();
    if actual_size_bytes != candidate.size_bytes {
        return Err(
            "The selected file changed while Arden was reading it. Choose it again.".to_string(),
        );
    }

    if actual_size_bytes == 0 {
        return Err("The selected file is empty.".to_string());
    }

    if actual_size_bytes > MAX_LOCAL_FILE_BYTES {
        return Err("Choose a text file smaller than 2 MB.".to_string());
    }

    let fingerprint = local_file_fingerprint(&candidate.content);
    let short_fingerprint = &fingerprint[..8];

    Ok(LocalFileImport {
        id: format!("local-{}-{}", file_slug(&file_name), short_fingerprint),
        title: file_name,
        kind: "document".to_string(),
        connector_id: "local-files".to_string(),
        provenance: format!("Local file - {}", format_file_size(actual_size_bytes)),
        freshness: "Imported now".to_string(),
        pinned: true,
        trust: "untrusted".to_string(),
        content_preview: preview_text(&candidate.content),
        content_fingerprint: fingerprint,
        size_bytes: actual_size_bytes,
        imported_at: candidate
            .imported_at
            .unwrap_or_else(|| "runtime-generated".to_string()),
        origin: "local-import".to_string(),
    })
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            current.push(character);
        } else if current.len() > 1 {
            if !tokens.contains(&current) {
                tokens.push(current.clone());
            }
            current.clear();
        } else {
            current.clear();
        }
    }

    if current.len() > 1 && !tokens.contains(&current) {
        tokens.push(current);
    }

    tokens
}

fn count_matches(value: &str, tokens: &[String]) -> f64 {
    let normalized = value.to_ascii_lowercase();

    tokens
        .iter()
        .map(|token| normalized.matches(token).count() as f64)
        .sum()
}

fn source_score(source: &KnowledgeSource, tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return if source.pinned { 1.0 } else { 0.0 };
    }

    let title_score = count_matches(&source.title, tokens) * 4.0;
    let content_score = count_matches(
        source.content_preview.as_deref().unwrap_or_default(),
        tokens,
    );
    let provenance_score = count_matches(&source.provenance, tokens) * 0.75;
    let match_score = title_score + content_score + provenance_score;

    if match_score == 0.0 {
        return 0.0;
    }

    let pin_boost = if source.pinned { 0.75 } else { 0.0 };
    let freshness = source.freshness.to_ascii_lowercase();
    let freshness_boost = if ["now", "today", "current"]
        .iter()
        .any(|needle| freshness.contains(needle))
    {
        0.25
    } else {
        0.0
    };

    match_score + pin_boost + freshness_boost
}

fn source_snippet(source: &KnowledgeSource) -> String {
    let content = source
        .content_preview
        .as_deref()
        .unwrap_or(&source.provenance)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if content.chars().count() <= MAX_SNIPPET_CHARACTERS {
        return content;
    }

    let snippet: String = content.chars().take(MAX_SNIPPET_CHARACTERS).collect();
    format!("{snippet}...")
}

fn to_citation(source: KnowledgeSource, score: f64) -> KnowledgeCitation {
    let snippet = source_snippet(&source);

    KnowledgeCitation {
        source_id: source.id,
        title: source.title,
        snippet,
        provenance: source.provenance,
        freshness: source.freshness,
        trust: source.trust.unwrap_or_else(|| "untrusted".to_string()),
        pinned: source.pinned,
        score: (score * 100.0).round() / 100.0,
    }
}

#[tauri::command]
fn search_knowledge_sources(
    query: String,
    sources: Vec<KnowledgeSource>,
    limit: Option<usize>,
) -> KnowledgeSearchResponse {
    let normalized_query = query.trim().to_string();
    let tokens = tokenize(&normalized_query);
    let mut scored_sources = sources
        .into_iter()
        .filter_map(|source| {
            let score = source_score(&source, &tokens);
            (score > 0.0).then_some((source, score))
        })
        .collect::<Vec<_>>();

    scored_sources.sort_by(|(left_source, left_score), (right_source, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_source.title.cmp(&right_source.title))
    });

    let citations = scored_sources
        .into_iter()
        .take(limit.unwrap_or(DEFAULT_RESULT_LIMIT))
        .map(|(source, score)| to_citation(source, score))
        .collect();

    KnowledgeSearchResponse {
        query: normalized_query,
        mode: "lexical-fallback",
        citations,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            import_local_text_file,
            search_knowledge_sources,
            list_approval_audit,
            list_approval_rules,
            record_approval_decision,
            resolve_approval_request,
            list_imported_knowledge_sources,
            import_local_knowledge_source,
            list_memory_state,
            save_memory_state,
            export_memory_state,
            promote_knowledge_source_to_memory,
            load_runtime_snapshot,
            save_runtime_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Arden desktop runtime");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, content: &str) -> LocalTextFileCandidate {
        LocalTextFileCandidate {
            name: name.to_string(),
            content: content.to_string(),
            size_bytes: content.len(),
            imported_at: Some("2026-06-25T22:00:00.000Z".to_string()),
        }
    }

    #[test]
    fn imports_supported_local_text_file_without_full_path() {
        let imported = import_local_text_file(candidate(
            "C:\\Users\\Josh\\Documents\\market-research.md",
            "Launch notes and connector recovery plan",
        ))
        .expect("file should import");

        assert_eq!(imported.title, "market-research.md");
        assert_eq!(imported.connector_id, "local-files");
        assert_eq!(imported.trust, "untrusted");
        assert!(!imported.provenance.contains("Users\\Josh"));
        assert!(imported.id.starts_with("local-market-research-md-"));
    }

    #[test]
    fn rejects_unsupported_local_file_extension() {
        let error = import_local_text_file(candidate("deck.pdf", "not plain text"))
            .expect_err("pdf should be rejected");

        assert!(error.contains("text, Markdown, JSON, CSV, and YAML"));
    }

    #[test]
    fn rejects_changed_local_file_payloads() {
        let mut changed = candidate("brief.md", "changed");
        changed.size_bytes += 1;

        let error = import_local_text_file(changed).expect_err("changed file should be rejected");

        assert!(error.contains("changed while Arden was reading"));
    }

    #[test]
    fn knowledge_search_requires_actual_matches_before_boosts() {
        let sources = vec![
            KnowledgeSource {
                id: "memory".to_string(),
                title: "Launch plan".to_string(),
                provenance: "Approved memory".to_string(),
                freshness: "Current".to_string(),
                pinned: true,
                trust: Some("trusted".to_string()),
                content_preview: Some("Connector recovery and approval audit".to_string()),
            },
            KnowledgeSource {
                id: "design".to_string(),
                title: "Design direction".to_string(),
                provenance: "Product design".to_string(),
                freshness: "Today".to_string(),
                pinned: true,
                trust: Some("trusted".to_string()),
                content_preview: Some("Sidebar hierarchy and composer suggestions".to_string()),
            },
        ];

        let result = search_knowledge_sources("connector recovery".to_string(), sources, None);

        assert_eq!(result.mode, "lexical-fallback");
        assert_eq!(result.citations.len(), 1);
        assert_eq!(result.citations[0].source_id, "memory");
    }

    fn audit_entry(id: &str, decision: &str) -> ApprovalAuditEntry {
        ApprovalAuditEntry {
            id: id.to_string(),
            request_id: "weekly-digest-rule".to_string(),
            decision: decision.to_string(),
            decided_at: "2026-06-25T22:30:00.000Z".to_string(),
            note: "Arden Automations Enable weekly workspace digest".to_string(),
        }
    }

    fn temp_audit_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("arden-{name}-{}.json", std::process::id()))
    }

    fn approval_request(
        mode: &str,
        risk_level: &str,
        confirmation_phrase: Option<&str>,
    ) -> ApprovalRequest {
        ApprovalRequest {
            id: "github-draft-pr".to_string(),
            service: "GitHub".to_string(),
            action: "Create draft PR for feature-memory".to_string(),
            mode: mode.to_string(),
            risk_level: risk_level.to_string(),
            data_used: vec!["branch diff".to_string(), "test summary".to_string()],
            consequence: "Creates a private draft PR.".to_string(),
            requested_at: "2026-06-26T10:00:00.000Z".to_string(),
            decisions: APPROVAL_DECISIONS
                .iter()
                .map(|decision| decision.to_string())
                .collect(),
            confirmation_phrase: confirmation_phrase.map(str::to_string),
        }
    }

    fn approval_resolution(
        request: ApprovalRequest,
        decision: &str,
        confirmation_text: Option<&str>,
        modification: Option<ApprovalModification>,
    ) -> ApprovalResolutionRequest {
        ApprovalResolutionRequest {
            request,
            decision: decision.to_string(),
            decided_at: "2026-06-26T10:30:00.000Z".to_string(),
            confirmation_text: confirmation_text.map(str::to_string),
            modification,
        }
    }

    fn approval_rule() -> ApprovalGrant {
        ApprovalGrant {
            id: "approval-rule-github-create-draft-pr".to_string(),
            request_id: "github-draft-pr".to_string(),
            scope: "rule".to_string(),
            service: "GitHub".to_string(),
            action: "Create draft PR for feature-memory".to_string(),
            mode: "trusted-scope".to_string(),
            data_used: vec!["branch diff".to_string()],
            created_at: "2026-06-26T10:30:00.000Z".to_string(),
        }
    }

    #[test]
    fn creates_ephemeral_session_approval_grants() {
        let response = resolve_approval(approval_resolution(
            approval_request("trusted-scope", "medium", None),
            "session",
            None,
            None,
        ))
        .expect("session approval should resolve");
        let grant = response
            .grant
            .expect("session approval should create a grant");

        assert!(!response.persisted);
        assert!(response.dismissed);
        assert_eq!(grant.scope, "session");
        assert_eq!(grant.mode, "trusted-scope");
        assert_eq!(response.audit_entry.decision, "session");
    }

    #[test]
    fn persists_standing_approval_rules() {
        let path = temp_audit_path("approval-rules-persist");
        let _ = fs::remove_file(&path);
        let response = resolve_approval(approval_resolution(
            approval_request("trusted-scope", "medium", None),
            "rule",
            None,
            None,
        ))
        .expect("rule approval should resolve");
        let grant = response.grant.expect("rule approval should create a grant");

        persist_approval_rule(&path, grant).expect("rule should persist");
        let rules = read_approval_rules(&path).expect("rules should read");

        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].scope, "rule");
        assert_eq!(rules[0].service, "GitHub");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn applies_modified_approval_scope_before_auditing() {
        let response = resolve_approval(approval_resolution(
            approval_request("trusted-scope", "medium", None),
            "modify",
            None,
            Some(ApprovalModification {
                mode: "read-only".to_string(),
                data_used: vec!["branch diff".to_string()],
                consequence: "Reviews the branch without publishing.".to_string(),
            }),
        ))
        .expect("modified approval should resolve");

        assert_eq!(response.effective_request.mode, "read-only");
        assert_eq!(response.effective_request.data_used, vec!["branch diff"]);
        assert!(response.audit_entry.note.contains("modified to read-only"));
        assert!(response.grant.is_none());
    }

    #[test]
    fn requires_exact_confirmation_for_high_risk_approvals() {
        let wrong = resolve_approval(approval_resolution(
            approval_request("full-access", "high", Some("publish Arden")),
            "once",
            Some("publish preview"),
            None,
        ))
        .expect_err("wrong confirmation should fail closed");

        assert!(wrong.contains("did not match"));

        let response = resolve_approval(approval_resolution(
            approval_request("full-access", "high", Some("publish Arden")),
            "once",
            Some("publish Arden"),
            None,
        ))
        .expect("exact confirmation should resolve");

        assert_eq!(response.audit_entry.decision, "once");
    }

    #[test]
    fn denial_never_requires_high_risk_confirmation() {
        let response = resolve_approval(approval_resolution(
            approval_request("full-access", "critical", None),
            "deny",
            None,
            None,
        ))
        .expect("denial should always remain available");

        assert_eq!(response.audit_entry.decision, "deny");
        assert!(response.grant.is_none());
    }

    #[test]
    fn persists_approval_audit_entries_latest_first() {
        let path = temp_audit_path("approval-audit-latest-first");
        let _ = fs::remove_file(&path);

        persist_approval_audit_entry(&path, audit_entry("first", "once"))
            .expect("first entry should persist");
        let response = persist_approval_audit_entry(&path, audit_entry("second", "deny"))
            .expect("second entry should persist");
        let entries = read_approval_audit_entries(&path).expect("entries should read");

        assert!(response.persisted);
        assert_eq!(response.audit_len, 2);
        assert_eq!(entries[0].id, "second");
        assert_eq!(entries[1].id, "first");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rejects_unknown_approval_decisions() {
        let path = temp_audit_path("approval-audit-rejects-decision");
        let _ = fs::remove_file(&path);

        let error = persist_approval_audit_entry(&path, audit_entry("bad", "forever"))
            .expect_err("unknown decisions should be rejected");

        assert!(error.contains("not recognized"));
        assert!(!path.exists());
    }

    #[test]
    fn caps_approval_audit_entries() {
        let path = temp_audit_path("approval-audit-caps");
        let _ = fs::remove_file(&path);

        for index in 0..(MAX_APPROVAL_AUDIT_ENTRIES + 5) {
            persist_approval_audit_entry(&path, audit_entry(&format!("entry-{index}"), "session"))
                .expect("entry should persist");
        }

        let entries = read_approval_audit_entries(&path).expect("entries should read");

        assert_eq!(entries.len(), MAX_APPROVAL_AUDIT_ENTRIES);
        assert_eq!(entries[0].id, "entry-204");
        assert_eq!(entries[MAX_APPROVAL_AUDIT_ENTRIES - 1].id, "entry-5");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn persists_imported_knowledge_sources_latest_first() {
        let path = temp_audit_path("imported-knowledge-latest-first");
        let _ = fs::remove_file(&path);
        let first = import_local_text_file(candidate("first.md", "First launch source"))
            .expect("first source should import");
        let second = import_local_text_file(candidate("second.md", "Second launch source"))
            .expect("second source should import");

        persist_imported_knowledge_source(&path, first).expect("first source should persist");
        persist_imported_knowledge_source(&path, second).expect("second source should persist");
        let sources = read_imported_knowledge_sources(&path).expect("sources should read");

        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].title, "second.md");
        assert_eq!(sources[1].title, "first.md");
        assert_eq!(sources[0].origin, "local-import");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn deduplicates_and_caps_imported_knowledge_sources() {
        let path = temp_audit_path("imported-knowledge-caps");
        let _ = fs::remove_file(&path);

        for index in 0..(MAX_IMPORTED_KNOWLEDGE_SOURCES + 5) {
            let source = import_local_text_file(candidate(
                &format!("source-{index}.md"),
                &format!("Knowledge source {index}"),
            ))
            .expect("source should import");
            persist_imported_knowledge_source(&path, source).expect("source should persist");
        }

        let replacement =
            import_local_text_file(candidate("source-104.md", "Knowledge source 104"))
                .expect("replacement should import");
        persist_imported_knowledge_source(&path, replacement).expect("replacement should persist");

        let sources = read_imported_knowledge_sources(&path).expect("sources should read");

        assert_eq!(sources.len(), MAX_IMPORTED_KNOWLEDGE_SOURCES);
        assert_eq!(sources[0].title, "source-104.md");
        assert_eq!(sources[1].title, "source-103.md");
        assert_eq!(
            sources[MAX_IMPORTED_KNOWLEDGE_SOURCES - 1].title,
            "source-5.md"
        );

        let _ = fs::remove_file(&path);
    }

    fn memory_record(id: &str, value: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.to_string(),
            kind: "preference".to_string(),
            title: format!("Memory {id}"),
            value: value.to_string(),
            source: "Approved durable memory".to_string(),
            freshness: "Updated now".to_string(),
            approved: true,
            pinned: true,
        }
    }

    fn knowledge_source(id: &str, trust: &str, preview: Option<&str>) -> KnowledgeSource {
        KnowledgeSource {
            id: id.to_string(),
            title: "Launch notes".to_string(),
            provenance: "Imported source fixture".to_string(),
            freshness: "Added today".to_string(),
            pinned: true,
            trust: Some(trust.to_string()),
            content_preview: preview.map(str::to_string),
        }
    }

    fn promotion_request(
        source: KnowledgeSource,
        decision: &str,
        disabled: bool,
    ) -> MemoryPromotionRequest {
        MemoryPromotionRequest {
            source,
            decision: decision.to_string(),
            decided_at: "2026-06-26T10:45:00.000Z".to_string(),
            state: MemoryControlState {
                disabled,
                records: vec![memory_record("existing", "Existing approved memory.")],
            },
        }
    }

    #[test]
    fn saves_and_reads_memory_state() {
        let path = temp_audit_path("memory-state-saves");
        let _ = fs::remove_file(&path);
        let state = MemoryControlState {
            disabled: true,
            records: vec![memory_record("concise-updates", "Prefer concise updates.")],
        };

        let saved = write_memory_state(&path, state).expect("memory state should save");
        let read = read_memory_state(&path).expect("memory state should read");

        assert!(saved.disabled);
        assert_eq!(read.records.len(), 1);
        assert_eq!(read.records[0].id, "concise-updates");
        assert_eq!(read.records[0].kind, "preference");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rejects_unknown_memory_kinds() {
        let path = temp_audit_path("memory-state-rejects-kind");
        let _ = fs::remove_file(&path);
        let mut record = memory_record("bad-kind", "Invalid kind");
        record.kind = "rumor".to_string();

        let error = write_memory_state(
            &path,
            MemoryControlState {
                disabled: false,
                records: vec![record],
            },
        )
        .expect_err("unknown memory kinds should fail");

        assert!(error.contains("not recognized"));
        assert!(!path.exists());
    }

    #[test]
    fn deduplicates_and_caps_memory_records() {
        let path = temp_audit_path("memory-state-caps");
        let _ = fs::remove_file(&path);
        let mut records = (0..(MAX_MEMORY_RECORDS + 8))
            .map(|index| memory_record(&format!("memory-{index}"), &format!("Value {index}")))
            .collect::<Vec<_>>();
        records.insert(0, memory_record("memory-10", "Duplicate should be ignored"));

        let saved = write_memory_state(
            &path,
            MemoryControlState {
                disabled: false,
                records,
            },
        )
        .expect("memory state should save");

        assert_eq!(saved.records.len(), MAX_MEMORY_RECORDS);
        assert_eq!(saved.records[0].id, "memory-10");
        assert_eq!(saved.records[1].id, "memory-0");
        assert_eq!(saved.records[MAX_MEMORY_RECORDS - 1].id, "memory-199");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn exports_memory_state_with_stable_format() {
        let encoded = encode_memory_export(MemoryControlState {
            disabled: false,
            records: vec![memory_record("exported", "Exported value")],
        })
        .expect("memory export should encode");

        assert!(encoded.contains("arden.memory.export.v1"));
        assert!(encoded.contains("Exported value"));
        assert!(encoded.contains("\"disabled\": false"));
    }

    #[test]
    fn promotes_untrusted_source_to_approved_memory() {
        let response = promote_knowledge_source(promotion_request(
            knowledge_source(
                "market-research-pdf",
                "untrusted",
                Some("Market launch risk notes."),
            ),
            "once",
            false,
        ))
        .expect("approved source should promote to memory");

        assert!(!response.persisted);
        assert_eq!(response.record.id, "memory-from-market-research-pdf");
        assert_eq!(response.record.kind, "imported");
        assert!(response.record.approved);
        assert!(response.record.pinned);
        assert_eq!(response.record.value, "Market launch risk notes.");
        assert!(response.record.source.contains("untrusted source"));
        assert_eq!(response.audit_entry.decision, "once");
        assert_eq!(
            response.audit_entry.request_id,
            "memory-promotion-market-research-pdf"
        );
        assert_eq!(response.state.records[0].id, response.record.id);
        assert_eq!(response.state.records[1].id, "existing");
    }

    #[test]
    fn rejects_non_approval_memory_promotion_decisions() {
        let error = promote_knowledge_source(promotion_request(
            knowledge_source("market-research-pdf", "untrusted", None),
            "deny",
            false,
        ))
        .expect_err("denied source should not promote to memory");

        assert!(error.contains("requires once, session, or rule"));
    }

    #[test]
    fn rejects_memory_promotion_when_memory_is_disabled() {
        let error = promote_knowledge_source(promotion_request(
            knowledge_source("market-research-pdf", "untrusted", None),
            "session",
            true,
        ))
        .expect_err("disabled memory should block promotion");

        assert!(error.contains("disabled"));
    }

    fn imported_source(name: &str) -> LocalFileImport {
        import_local_text_file(candidate(name, "Recovered local knowledge"))
            .expect("source should import")
    }

    fn runtime_snapshot() -> RuntimeSnapshot {
        let mut automation_statuses = BTreeMap::new();
        automation_statuses.insert("weekly-digest".to_string(), "active".to_string());

        RuntimeSnapshot {
            version: RUNTIME_SNAPSHOT_VERSION,
            active_item: "Automations".to_string(),
            composer_draft: "/schedule weekly digest".to_string(),
            voice_enabled: true,
            approval_audit: vec![audit_entry("approval-one", "once")],
            dismissed_approval_ids: vec![
                "github-draft-pr".to_string(),
                "github-draft-pr".to_string(),
            ],
            approval_rules: vec![approval_rule()],
            automation_statuses,
            pinned_source_ids: vec![
                "codex-manual".to_string(),
                "codex-manual".to_string(),
                "product-brief".to_string(),
            ],
            imported_knowledge_sources: vec![imported_source("recovery-notes.md")],
            memory_disabled: false,
            memory_records: vec![memory_record(
                "recovery",
                "Recover the workspace after restart.",
            )],
            saved_at: "2026-06-26T10:30:00.000Z".to_string(),
        }
    }

    #[test]
    fn saves_and_reads_runtime_snapshot() {
        let path = temp_audit_path("runtime-snapshot-saves");
        let _ = fs::remove_file(&path);

        let saved =
            write_runtime_snapshot(&path, runtime_snapshot()).expect("snapshot should save");
        let read = read_runtime_snapshot(&path)
            .expect("snapshot should read")
            .expect("snapshot should exist");

        assert_eq!(saved.version, RUNTIME_SNAPSHOT_VERSION);
        assert_eq!(read.active_item, "Automations");
        assert_eq!(read.composer_draft, "/schedule weekly digest");
        assert!(read.voice_enabled);
        assert_eq!(read.approval_audit.len(), 1);
        assert_eq!(read.dismissed_approval_ids, vec!["github-draft-pr"]);
        assert_eq!(read.approval_rules.len(), 1);
        assert_eq!(read.approval_rules[0].scope, "rule");
        assert_eq!(
            read.automation_statuses.get("weekly-digest"),
            Some(&"active".to_string())
        );
        assert_eq!(
            read.pinned_source_ids,
            vec!["codex-manual", "product-brief"]
        );
        assert_eq!(
            read.imported_knowledge_sources[0].title,
            "recovery-notes.md"
        );
        assert_eq!(read.memory_records[0].id, "recovery");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rejects_unknown_runtime_automation_statuses() {
        let path = temp_audit_path("runtime-snapshot-rejects-status");
        let _ = fs::remove_file(&path);
        let mut snapshot = runtime_snapshot();
        snapshot
            .automation_statuses
            .insert("weekly-digest".to_string(), "running".to_string());

        let error = write_runtime_snapshot(&path, snapshot)
            .expect_err("unknown automation statuses should fail");

        assert!(error.contains("not recognized"));
        assert!(!path.exists());
    }

    #[test]
    fn caps_runtime_snapshot_recovery_lists() {
        let path = temp_audit_path("runtime-snapshot-caps");
        let _ = fs::remove_file(&path);
        let mut snapshot = runtime_snapshot();
        snapshot.dismissed_approval_ids = (0..(MAX_RUNTIME_SNAPSHOT_IDS + 5))
            .map(|index| format!("approval-{index}"))
            .collect();
        snapshot.pinned_source_ids = (0..(MAX_RUNTIME_SNAPSHOT_IDS + 8))
            .map(|index| format!("source-{index}"))
            .collect();

        let saved =
            write_runtime_snapshot(&path, snapshot).expect("snapshot should save with capped ids");

        assert_eq!(saved.dismissed_approval_ids.len(), MAX_RUNTIME_SNAPSHOT_IDS);
        assert_eq!(saved.pinned_source_ids.len(), MAX_RUNTIME_SNAPSHOT_IDS);
        assert_eq!(saved.dismissed_approval_ids[0], "approval-0");
        assert_eq!(
            saved.pinned_source_ids[MAX_RUNTIME_SNAPSHOT_IDS - 1],
            "source-199"
        );

        let _ = fs::remove_file(&path);
    }
}
