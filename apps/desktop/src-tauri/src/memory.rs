//! Durable memory state: normalize, read/write, export, and promotion from
//! approved knowledge sources.
//!
//! Public Tauri commands (names must stay stable): `list_memory_state`,
//! `save_memory_state`, `export_memory_state`,
//! `promote_knowledge_source_to_memory`.

use std::{fs, path::Path};

use crate::approvals::{
    normalize_approval_audit_entry, persist_approval_audit_entry,
    persist_approval_audit_entry_scoped,
};
use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::models::{ApprovalAuditEntry, KnowledgeSource, LocalFileImport};
use crate::models::{
    MemoryControlState, MemoryExportEnvelope, MemoryPromotionRequest, MemoryPromotionResponse,
    MemoryRecord, MAX_MEMORY_RECORDS, MAX_MEMORY_TITLE_CHARACTERS, MAX_MEMORY_VALUE_CHARACTERS,
    MEMORY_KINDS,
};
use crate::paths::approval_audit_path;
use crate::paths::{
    file_slug, imported_knowledge_path, memory_state_path, normalize_spaces, truncate_characters,
};

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
        scope: record.scope,
        confidence: record.confidence,
        provenance: record.provenance,
        approval_state: record.approval_state,
        run_id: record.run_id,
        created_at: record.created_at,
        updated_at: record.updated_at,
        forgotten_at: record.forgotten_at,
        disabled: record.disabled,
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

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn encode_memory_export(state: MemoryControlState) -> Result<String, String> {
    encode_memory_export_scoped(state, "default")
}

fn encode_memory_export_scoped(
    state: MemoryControlState,
    workspace_id: &str,
) -> Result<String, String> {
    let mut normalized = normalize_memory_state(state)?;
    normalized
        .records
        .retain(|record| record.forgotten_at.is_none() && !record.disabled);
    normalized
        .records
        .sort_by(|left, right| left.id.cmp(&right.id));
    let envelope = MemoryExportEnvelope {
        // Compatibility contract for existing exported-memory consumers.
        format: "arden.memory.export.v1",
        workspace_id: workspace_id.to_string(),
        disabled: normalized.disabled,
        disabled_records_included: false,
        forgotten_records_included: false,
        records: normalized.records,
    };
    let value = serde_json::to_value(envelope)
        .map_err(|_| "Fable could not encode memory export.".to_string())?;
    serde_json::to_string_pretty(&redact_export_value(&value))
        .map_err(|_| "Fable could not encode memory export.".to_string())
}

fn redact_export_value(value: &serde_json::Value) -> serde_json::Value {
    const MARKERS: &[&str] = &[
        "bearer ",
        "authorization:",
        "access_token",
        "refresh_token",
        "client_secret",
        "github_pat_",
        "ghp_",
        "xoxb-",
        "xoxp-",
        "ya29.",
        "sk-",
    ];
    match value {
        serde_json::Value::String(text)
            if MARKERS
                .iter()
                .any(|marker| text.to_ascii_lowercase().contains(marker)) =>
        {
            serde_json::Value::String("[redacted secret-bearing memory data]".to_string())
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(redact_export_value).collect())
        }
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_export_value(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn live_memory_state(mut state: MemoryControlState) -> MemoryControlState {
    state.records.retain(|record| record.forgotten_at.is_none());
    state
}

fn project_scope_value(project_id: &str) -> serde_json::Value {
    serde_json::json!({ "level": "project", "projectId": project_id })
}

fn validate_existing_project_scope(
    scope: Option<&serde_json::Value>,
    workspace_id: &str,
    project_id: &str,
) -> Result<(), String> {
    let Some(scope) = scope else { return Ok(()) };
    let object = scope
        .as_object()
        .ok_or_else(|| "Project memory scope is malformed.".to_string())?;
    if object.get("level").and_then(serde_json::Value::as_str) != Some("project")
        || object.get("projectId").and_then(serde_json::Value::as_str) != Some(project_id)
        || object
            .get("workspaceId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value != workspace_id)
    {
        return Err("Memory records cannot cross project or workspace boundaries.".to_string());
    }
    Ok(())
}

fn canonicalize_project_memory_state(
    state: MemoryControlState,
    workspace_id: &str,
    project_id: &str,
) -> Result<MemoryControlState, String> {
    let mut state = normalize_memory_state(state)?;
    for record in &mut state.records {
        validate_existing_project_scope(record.scope.as_ref(), workspace_id, project_id)?;
        record.scope = Some(project_scope_value(project_id));
    }
    Ok(state)
}

fn validate_project_source(source: &LocalFileImport, project_id: &str) -> Result<(), String> {
    if source.disabled {
        return Err("Disabled knowledge cannot be promoted to memory.".to_string());
    }
    if source.deleted_at.is_some() {
        return Err("Deleted knowledge cannot be promoted to memory.".to_string());
    }
    if let Some(scope) = source.scope.as_ref() {
        let exact = scope.get("level").and_then(serde_json::Value::as_str) == Some("project")
            && scope.get("projectId").and_then(serde_json::Value::as_str) == Some(project_id);
        if !exact {
            return Err("Knowledge source does not belong to this project.".to_string());
        }
    }
    Ok(())
}

fn promote_project_knowledge_source(
    mut request: MemoryPromotionRequest,
    canonical_source: &LocalFileImport,
    current_state: MemoryControlState,
    workspace_id: &str,
    project_id: &str,
) -> Result<MemoryPromotionResponse, String> {
    validate_project_source(canonical_source, project_id)?;
    let requested_id = normalize_spaces(&request.source.id);
    if requested_id.is_empty() || requested_id != canonical_source.id {
        return Err("Knowledge source is unavailable in this project.".to_string());
    }
    let promoted_id = format!("memory-from-{}", file_slug(&canonical_source.id));
    if current_state
        .records
        .iter()
        .any(|record| record.id == promoted_id && record.forgotten_at.is_some())
    {
        return Err("Forgotten memory cannot be restored by promotion.".to_string());
    }
    request.source = KnowledgeSource {
        id: canonical_source.id.clone(),
        title: canonical_source.title.clone(),
        provenance: canonical_source.provenance.clone(),
        freshness: canonical_source.freshness.clone(),
        pinned: canonical_source.pinned,
        trust: Some(canonical_source.trust.clone()),
        content_preview: Some(canonical_source.content_preview.clone()),
        disabled: canonical_source.disabled,
        deleted_at: canonical_source.deleted_at.clone(),
        account: canonical_source.account.clone(),
    };
    request.state = current_state;
    let mut response = promote_knowledge_source(request)?;
    response.record.scope = Some(project_scope_value(project_id));
    response.record.provenance = Some(serde_json::json!({
        "origin": "source",
        "sourceId": canonical_source.id,
        "note": canonical_source.provenance,
        "title": canonical_source.title,
        "connectorId": canonical_source.connector_id,
        "contentFingerprint": canonical_source.content_fingerprint,
        "importedAt": canonical_source.imported_at,
        "trust": canonical_source.trust,
        "workspaceId": workspace_id,
        "projectId": project_id,
    }));
    if let Some(stored) = response
        .state
        .records
        .iter_mut()
        .find(|record| record.id == response.record.id)
    {
        *stored = response.record.clone();
    }
    response.state = canonicalize_project_memory_state(response.state, workspace_id, project_id)?;
    response.record = response
        .state
        .records
        .iter()
        .find(|record| record.id == response.record.id)
        .cloned()
        .ok_or_else(|| "Fable could not retain promoted memory.".to_string())?;
    Ok(response)
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
        scope: None,
        confidence: Some(1.0),
        provenance: Some(serde_json::json!({
            "origin": "source",
            "sourceId": source_id,
            "note": provenance,
        })),
        approval_state: Some("approved".to_string()),
        run_id: None,
        created_at: Some(decided_at.clone()),
        updated_at: Some(decided_at.clone()),
        forgotten_at: None,
        disabled: false,
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
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Read)?.data;
    if let Some(state) = crate::store::read_workspace_document(&path, &scope)? {
        let state = if let Some(project_id) = scope.project_id() {
            canonicalize_project_memory_state(state, scope.workspace_id(), project_id)?
        } else {
            normalize_memory_state(state)?
        };
        return Ok(live_memory_state(state));
    }
    if scope.project_id().is_some() {
        return Ok(default_memory_state());
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
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?.data;
    let mut normalized = if let Some(project_id) = scope.project_id() {
        canonicalize_project_memory_state(state, scope.workspace_id(), project_id)?
    } else {
        normalize_memory_state(state)?
    };
    if let Some(existing) =
        crate::store::read_workspace_document::<MemoryControlState>(&path, &scope)?
    {
        for record in existing
            .records
            .into_iter()
            .filter(|record| record.forgotten_at.is_some())
        {
            if let Some(candidate) = normalized
                .records
                .iter_mut()
                .find(|candidate| candidate.id == record.id)
            {
                if candidate.forgotten_at.is_none() {
                    return Err("Forgotten memory cannot be restored by routine save.".to_string());
                }
                *candidate = record;
            } else {
                normalized.records.push(record);
            }
        }
    }
    if let Some(project_id) = scope.project_id() {
        normalized =
            canonicalize_project_memory_state(normalized, scope.workspace_id(), project_id)?;
    }
    if crate::store::write_workspace_document(&path, &scope, &normalized)? {
        return Ok(live_memory_state(normalized));
    }
    write_memory_state(&path, normalized).map(live_memory_state)
}

#[tauri::command]
pub fn export_memory_state(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<String, String> {
    let path = memory_state_path(&app)?;
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Read)?.data;
    let state =
        crate::store::read_workspace_document(&path, &scope)?.unwrap_or_else(default_memory_state);
    let state = if let Some(project_id) = scope.project_id() {
        canonicalize_project_memory_state(state, scope.workspace_id(), project_id)?
    } else {
        normalize_memory_state(state)?
    };
    encode_memory_export_scoped(state, scope.workspace_id())
}

#[tauri::command]
pub fn promote_knowledge_source_to_memory(
    app: tauri::AppHandle,
    request: MemoryPromotionRequest,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<MemoryPromotionResponse, String> {
    let memory_path = memory_state_path(&app)?;
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?.data;
    let response = if let Some(project_id) = scope.project_id() {
        let source_id = normalize_spaces(&request.source.id);
        let knowledge_path = imported_knowledge_path(&app)?;
        let sources =
            crate::snapshot::read_imported_knowledge_sources_scoped(&knowledge_path, &scope)?;
        let canonical_source = sources
            .iter()
            .find(|source| source.id == source_id)
            .ok_or_else(|| "Knowledge source is unavailable in this project.".to_string())?;
        let current_state: MemoryControlState =
            crate::store::read_workspace_document(&memory_path, &scope)?
                .unwrap_or_else(default_memory_state);
        promote_project_knowledge_source(
            request,
            canonical_source,
            current_state,
            scope.workspace_id(),
            project_id,
        )?
    } else {
        promote_knowledge_source(request)?
    };
    let state = if crate::store::write_workspace_document(&memory_path, &scope, &response.state)? {
        response.state
    } else {
        write_memory_state(&memory_path, response.state)?
    };
    let audit_path = approval_audit_path(&app)?;
    let audit_response = if scope.project_id().is_some() {
        persist_approval_audit_entry_scoped(&audit_path, &scope, response.audit_entry)?
    } else {
        persist_approval_audit_entry(&audit_path, response.audit_entry)?
    };

    Ok(MemoryPromotionResponse {
        persisted: true,
        record: response.record,
        audit_entry: audit_response.entry,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str) -> LocalFileImport {
        LocalFileImport {
            id: id.into(),
            title: "Canonical title".into(),
            kind: "document".into(),
            connector_id: "local-files".into(),
            provenance: "Canonical file".into(),
            freshness: "Imported now".into(),
            pinned: false,
            trust: "untrusted".into(),
            content_preview: "Canonical content".into(),
            content_fingerprint: "fingerprint".into(),
            size_bytes: 17,
            imported_at: "2026-07-11T10:00:00Z".into(),
            origin: "local-import".into(),
            scope: Some(project_scope_value("project-a")),
            account: None,
            disabled: false,
            deleted_at: None,
            status: Some("ok".into()),
            status_message: None,
        }
    }

    fn request(id: &str) -> MemoryPromotionRequest {
        MemoryPromotionRequest {
            source: KnowledgeSource {
                id: id.into(),
                title: "Forged title".into(),
                provenance: "Forged source".into(),
                freshness: "Forged".into(),
                pinned: true,
                trust: Some("trusted".into()),
                content_preview: Some("Forged content".into()),
                disabled: false,
                deleted_at: None,
                account: None,
            },
            decision: "once".into(),
            decided_at: "2026-07-11T11:00:00Z".into(),
            state: MemoryControlState {
                disabled: false,
                records: vec![record("renderer-injected")],
            },
        }
    }

    fn record(id: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            kind: "fact".into(),
            title: "Title".into(),
            value: "Value".into(),
            source: "Manual".into(),
            freshness: "Now".into(),
            approved: true,
            pinned: false,
            scope: None,
            confidence: None,
            provenance: None,
            approval_state: Some("approved".into()),
            run_id: None,
            created_at: None,
            updated_at: None,
            forgotten_at: None,
            disabled: false,
        }
    }

    #[test]
    fn project_save_stamps_exact_scope_and_rejects_foreign_scope() {
        let state = canonicalize_project_memory_state(
            MemoryControlState {
                disabled: false,
                records: vec![record("one")],
            },
            "workspace-a",
            "project-a",
        )
        .unwrap();
        assert_eq!(
            state.records[0].scope,
            Some(project_scope_value("project-a"))
        );

        let mut foreign = record("foreign");
        foreign.scope = Some(project_scope_value("project-b"));
        assert!(canonicalize_project_memory_state(
            MemoryControlState {
                disabled: false,
                records: vec![foreign]
            },
            "workspace-a",
            "project-a",
        )
        .unwrap_err()
        .contains("cross"));
    }

    #[test]
    fn project_promotion_uses_canonical_source_and_authoritative_state() {
        let response = promote_project_knowledge_source(
            request("source-1"),
            &source("source-1"),
            MemoryControlState {
                disabled: false,
                records: vec![record("authoritative")],
            },
            "workspace-a",
            "project-a",
        )
        .unwrap();
        assert_eq!(response.record.title, "Canonical title");
        assert_eq!(response.record.value, "Canonical content");
        assert!(response
            .state
            .records
            .iter()
            .any(|record| record.id == "authoritative"));
        assert!(!response
            .state
            .records
            .iter()
            .any(|record| record.id == "renderer-injected"));
        assert_eq!(
            response.record.scope,
            Some(project_scope_value("project-a"))
        );
        let provenance = response.record.provenance.unwrap();
        assert_eq!(provenance["contentFingerprint"], "fingerprint");
        assert_eq!(provenance["projectId"], "project-a");
    }

    #[test]
    fn project_promotion_rejects_missing_disabled_deleted_and_foreign_sources() {
        assert!(promote_project_knowledge_source(
            request("forged-id"),
            &source("canonical-id"),
            default_memory_state(),
            "workspace-a",
            "project-a"
        )
        .unwrap_err()
        .contains("unavailable"));

        let mut disabled = source("source-1");
        disabled.disabled = true;
        assert!(promote_project_knowledge_source(
            request("source-1"),
            &disabled,
            default_memory_state(),
            "workspace-a",
            "project-a"
        )
        .unwrap_err()
        .contains("Disabled"));

        let mut deleted = source("source-1");
        deleted.deleted_at = Some("then".into());
        assert!(promote_project_knowledge_source(
            request("source-1"),
            &deleted,
            default_memory_state(),
            "workspace-a",
            "project-a"
        )
        .unwrap_err()
        .contains("Deleted"));

        let mut foreign = source("source-1");
        foreign.scope = Some(project_scope_value("project-b"));
        assert!(promote_project_knowledge_source(
            request("source-1"),
            &foreign,
            default_memory_state(),
            "workspace-a",
            "project-a"
        )
        .unwrap_err()
        .contains("does not belong"));

        let mut forgotten = record("memory-from-source-1");
        forgotten.forgotten_at = Some("then".into());
        assert!(promote_project_knowledge_source(
            request("source-1"),
            &source("source-1"),
            MemoryControlState {
                disabled: false,
                records: vec![forgotten],
            },
            "workspace-a",
            "project-a"
        )
        .unwrap_err()
        .contains("Forgotten"));
    }

    #[test]
    fn export_excludes_disabled_and_forgotten_but_keeps_provenance() {
        let mut live = record("live");
        live.provenance =
            Some(serde_json::json!({"origin":"source","sourceId":"source-1","note":"file"}));
        let mut disabled = record("disabled");
        disabled.disabled = true;
        let mut forgotten = record("forgotten");
        forgotten.forgotten_at = Some("then".into());
        let encoded = encode_memory_export_scoped(
            MemoryControlState {
                disabled: false,
                records: vec![live, disabled, forgotten],
            },
            "workspace-a",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["records"].as_array().unwrap().len(), 1);
        assert_eq!(value["records"][0]["provenance"]["sourceId"], "source-1");
    }
}
