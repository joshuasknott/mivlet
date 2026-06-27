//! Runtime snapshot recovery, imported-knowledge persistence, runtime status,
//! and the file-import Tauri command.
//!
//! Public Tauri commands (names must stay stable): `runtime_status`,
//! `list_imported_knowledge_sources`, `import_local_knowledge_source`,
//! `load_runtime_snapshot`, `save_runtime_snapshot`.

use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

use crate::approvals::{normalize_approval_audit_entry, normalize_approval_grant};
use crate::knowledge::import_local_text_file;
use crate::memory::normalize_memory_state;
use crate::models::MemoryControlState;
use crate::models::{
    ApprovalAuditEntry, ApprovalGrant, LocalFileImport, LocalTextFileCandidate, RuntimeSnapshot,
    RuntimeStatus, AUTOMATION_STATUSES, MAX_APPROVAL_AUDIT_ENTRIES, MAX_IMPORTED_KNOWLEDGE_SOURCES,
    MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILE_PREVIEW_CHARACTERS, MAX_MEMORY_TITLE_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_AUTOMATIONS, MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_IDS, MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS, RUNTIME_SNAPSHOT_VERSION,
};
use crate::paths::{
    imported_knowledge_path, normalize_spaces, runtime_snapshot_path, truncate_characters,
};

#[tauri::command]
pub fn runtime_status() -> RuntimeStatus {
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

pub(crate) fn read_imported_knowledge_sources(path: &Path) -> Result<Vec<LocalFileImport>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read imported knowledge sources.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<LocalFileImport>>(&contents)
        .map_err(|_| "Fable could not parse imported knowledge sources.".to_string())
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

fn write_imported_knowledge_sources(
    path: &Path,
    sources: &[LocalFileImport],
) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(sources)
        .map_err(|_| "Fable could not encode imported knowledge sources.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Fable could not save imported knowledge sources.".to_string())
}

pub(crate) fn persist_imported_knowledge_source(
    path: &Path,
    source: LocalFileImport,
) -> Result<LocalFileImport, String> {
    let source = normalize_imported_knowledge_source(source)?;
    let sources = read_imported_knowledge_sources(path)?;
    let sources = append_imported_knowledge_source(sources, source.clone());
    write_imported_knowledge_sources(path, &sources)?;

    Ok(source)
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

pub(crate) fn normalize_runtime_snapshot(
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
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
        if approval_rules.len() >= 100 {
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
        // Provider ids only — secrets are never persisted into the snapshot.
        connected_backend_ids: normalize_snapshot_id_list(snapshot.connected_backend_ids),
        saved_at,
    })
}

pub(crate) fn read_runtime_snapshot(path: &Path) -> Result<Option<RuntimeSnapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read runtime snapshot.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<RuntimeSnapshot>(&contents)
        .map_err(|_| "Fable could not parse runtime snapshot.".to_string())?;

    normalize_runtime_snapshot(parsed).map(Some)
}

pub(crate) fn write_runtime_snapshot(
    path: &Path,
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    let normalized = normalize_runtime_snapshot(snapshot)?;
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Fable could not encode runtime snapshot.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Fable could not save runtime snapshot.".to_string())?;

    Ok(normalized)
}

#[tauri::command]
pub fn list_imported_knowledge_sources(
    app: tauri::AppHandle,
) -> Result<Vec<LocalFileImport>, String> {
    let path = imported_knowledge_path(&app)?;
    read_imported_knowledge_sources(&path)
}

#[tauri::command]
pub fn import_local_knowledge_source(
    app: tauri::AppHandle,
    candidate: LocalTextFileCandidate,
) -> Result<LocalFileImport, String> {
    let imported = import_local_text_file(candidate)?;
    let path = imported_knowledge_path(&app)?;
    persist_imported_knowledge_source(&path, imported)
}

#[tauri::command]
pub fn load_runtime_snapshot(app: tauri::AppHandle) -> Result<Option<RuntimeSnapshot>, String> {
    let path = runtime_snapshot_path(&app)?;
    read_runtime_snapshot(&path)
}

#[tauri::command]
pub fn save_runtime_snapshot(
    app: tauri::AppHandle,
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    let path = runtime_snapshot_path(&app)?;
    write_runtime_snapshot(&path, snapshot)
}
