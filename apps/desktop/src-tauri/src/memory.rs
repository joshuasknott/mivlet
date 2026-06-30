//! Durable memory state: normalize, read/write, export, and promotion from
//! approved knowledge sources.
//!
//! Public Tauri commands (names must stay stable): `list_memory_state`,
//! `save_memory_state`, `export_memory_state`,
//! `promote_knowledge_source_to_memory`.

use std::{fs, path::Path};

use crate::approvals::{normalize_approval_audit_entry, persist_approval_audit_entry};
use crate::models::ApprovalAuditEntry;
use crate::models::{
    MemoryControlState, MemoryExportEnvelope, MemoryPromotionRequest, MemoryPromotionResponse,
    MemoryRecord, MAX_MEMORY_RECORDS, MAX_MEMORY_TITLE_CHARACTERS, MAX_MEMORY_VALUE_CHARACTERS,
    MEMORY_KINDS,
};
use crate::paths::approval_audit_path;
use crate::paths::{file_slug, memory_state_path, normalize_spaces, truncate_characters};
use crate::store::repos::scope::{DataScope, DEFAULT_WORKSPACE_ID};

fn data_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<DataScope, String> {
    DataScope::new(
        workspace_id.unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
        project_id,
    )
    .map_err(|error| error.to_string())
}

fn default_memory_state() -> MemoryControlState {
    MemoryControlState {
        disabled: false,
        records: Vec::new(),
    }
}

pub(crate) fn normalize_memory_record(record: MemoryRecord) -> Result<MemoryRecord, String> {
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
            "Fable memory".to_string()
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

pub(crate) fn normalize_memory_state(
    state: MemoryControlState,
) -> Result<MemoryControlState, String> {
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

pub(crate) fn read_memory_state(path: &Path) -> Result<MemoryControlState, String> {
    if let Some(state) = crate::store::read_document(path)? {
        return normalize_memory_state(state);
    }
    if !path.exists() {
        return Ok(default_memory_state());
    }

    let contents =
        fs::read_to_string(path).map_err(|_| "Fable could not read memory state.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(default_memory_state());
    }

    let parsed = serde_json::from_str::<MemoryControlState>(&contents)
        .map_err(|_| "Fable could not parse memory state.".to_string())?;

    normalize_memory_state(parsed)
}

pub(crate) fn write_memory_state(
    path: &Path,
    state: MemoryControlState,
) -> Result<MemoryControlState, String> {
    let normalized = normalize_memory_state(state)?;
    if crate::store::write_document(path, &normalized)? {
        return Ok(normalized);
    }
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Fable could not encode memory state.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Fable could not save memory state.".to_string())?;

    Ok(normalized)
}

pub(crate) fn encode_memory_export(state: MemoryControlState) -> Result<String, String> {
    let normalized = normalize_memory_state(state)?;
    let envelope = MemoryExportEnvelope {
        // Compatibility contract for existing exported-memory consumers.
        format: "arden.memory.export.v1",
        disabled: normalized.disabled,
        records: normalized.records,
    };

    serde_json::to_string_pretty(&envelope)
        .map_err(|_| "Fable could not encode memory export.".to_string())
}

pub(crate) fn promote_knowledge_source(
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

    let source_id = truncate_characters(&normalize_spaces(&request.source.id), 160);
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
        note: format!("Fable Memory Approve {provenance} into durable memory"),
    })?;

    Ok(MemoryPromotionResponse {
        persisted: false,
        record,
        audit_entry,
        state,
    })
}

#[tauri::command]
pub fn list_memory_state(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<MemoryControlState, String> {
    let path = memory_state_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    if let Some(state) = crate::store::read_workspace_document(&path, &scope)? {
        return normalize_memory_state(state);
    }
    read_memory_state(&path)
}

#[tauri::command]
pub fn save_memory_state(
    app: tauri::AppHandle,
    state: MemoryControlState,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<MemoryControlState, String> {
    let path = memory_state_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    let normalized = normalize_memory_state(state)?;
    if crate::store::write_workspace_document(&path, &scope, &normalized)? {
        return Ok(normalized);
    }
    write_memory_state(&path, normalized)
}

#[tauri::command]
pub fn export_memory_state(state: MemoryControlState) -> Result<String, String> {
    encode_memory_export(state)
}

#[tauri::command]
pub fn promote_knowledge_source_to_memory(
    app: tauri::AppHandle,
    request: MemoryPromotionRequest,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<MemoryPromotionResponse, String> {
    let response = promote_knowledge_source(request)?;
    let memory_path = memory_state_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    let state = if crate::store::write_workspace_document(&memory_path, &scope, &response.state)? {
        response.state
    } else {
        write_memory_state(&memory_path, response.state)?
    };
    let audit_path = approval_audit_path(&app)?;
    let audit_response = persist_approval_audit_entry(&audit_path, response.audit_entry)?;

    Ok(MemoryPromotionResponse {
        persisted: true,
        record: response.record,
        audit_entry: audit_response.entry,
        state,
    })
}
