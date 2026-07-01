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
    ApprovalAuditEntry, ApprovalGrant, LocalFileImport, LocalTextFileCandidate, PlanStep,
    RuntimeSnapshot, RuntimeStatus, Schedule, WorkspaceGoal, WorkspacePlan, APPROVAL_MODES,
    AUTOMATION_STATUSES, GOAL_STATUSES, MAX_APPROVAL_AUDIT_ENTRIES, MAX_GOAL_FIELD_CHARACTERS,
    MAX_IMPORTED_KNOWLEDGE_SOURCES, MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
    MAX_MEMORY_TITLE_CHARACTERS, MAX_PLAN_STEPS, MAX_PLAN_STEP_DESCRIPTION_CHARACTERS,
    MAX_PLAN_TITLE_CHARACTERS, MAX_RUNTIME_SNAPSHOT_AUTOMATIONS,
    MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS, MAX_RUNTIME_SNAPSHOT_GOALS, MAX_RUNTIME_SNAPSHOT_IDS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS, MAX_RUNTIME_SNAPSHOT_PLANS, MAX_RUNTIME_SNAPSHOT_SCHEDULES,
    MAX_SCHEDULE_FIELD_CHARACTERS, PLAN_STATUSES, RUNTIME_SNAPSHOT_VERSION, SCHEDULE_WEEKDAYS,
};
use crate::paths::{
    imported_knowledge_path, normalize_spaces, runtime_snapshot_path, truncate_characters,
};
use crate::store::repos::scope::DataScope;

fn data_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<DataScope, String> {
    let workspace_id = workspace_id.ok_or_else(|| "Workspace id is required.".to_string())?;
    DataScope::new(workspace_id, project_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        permission_mode: "read-only",
        offline_ready: true,
        connector_boundaries: [
            "local-files",
            "github",
            "vercel",
            "google-drive",
            "notion",
            "gmail",
            "slack",
            "google-calendar",
            "linear",
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
        scope: source.scope,
        account: source.account,
        disabled: source.disabled,
        deleted_at: source.deleted_at,
        status: source.status,
        status_message: source.status_message,
    })
}

pub(crate) fn read_imported_knowledge_sources(path: &Path) -> Result<Vec<LocalFileImport>, String> {
    if let Some(sources) = crate::store::read_document(path)? {
        return Ok(sources);
    }
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
) -> Result<Vec<LocalFileImport>, String> {
    if sources
        .iter()
        .any(|existing| existing.id == source.id && existing.deleted_at.is_some())
    {
        return Err("Deleted knowledge cannot be restored by routine import.".to_string());
    }
    sources.retain(|existing| existing.id != source.id);
    sources.insert(0, source);
    sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
    Ok(sources)
}

fn merge_deleted_imported_tombstones(
    mut sources: Vec<LocalFileImport>,
    existing: Vec<LocalFileImport>,
) -> Result<Vec<LocalFileImport>, String> {
    for tombstone in existing
        .into_iter()
        .filter(|source| source.deleted_at.is_some())
    {
        if let Some(incoming) = sources.iter().find(|source| source.id == tombstone.id) {
            if incoming.deleted_at.is_none() {
                return Err("Deleted knowledge cannot be restored by routine import.".to_string());
            }
            continue;
        }
        sources.push(tombstone);
    }

    while sources.len() > MAX_IMPORTED_KNOWLEDGE_SOURCES {
        if let Some(index) = sources
            .iter()
            .rposition(|source| source.deleted_at.is_none())
        {
            sources.remove(index);
        } else {
            sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
        }
    }

    Ok(sources)
}

fn write_imported_knowledge_sources(
    path: &Path,
    sources: &[LocalFileImport],
) -> Result<(), String> {
    if crate::store::write_document(path, &sources)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(sources)
        .map_err(|_| "Fable could not encode imported knowledge sources.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Fable could not save imported knowledge sources.".to_string())
}

#[tauri::command]
pub fn save_imported_knowledge_sources(
    app: tauri::AppHandle,
    sources: Vec<LocalFileImport>,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<LocalFileImport>, String> {
    let mut normalized = Vec::new();
    for source in sources.into_iter().take(MAX_IMPORTED_KNOWLEDGE_SOURCES) {
        let source = normalize_imported_knowledge_source(source)?;
        if !normalized
            .iter()
            .any(|existing: &LocalFileImport| existing.id == source.id)
        {
            normalized.push(source);
        }
    }
    let path = imported_knowledge_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    let existing: Vec<LocalFileImport> =
        crate::store::read_workspace_document(&path, &scope)?.unwrap_or_default();
    let normalized = merge_deleted_imported_tombstones(normalized, existing)?;
    if !crate::store::write_workspace_document(&path, &scope, &normalized)? {
        write_imported_knowledge_sources(&path, &normalized)?;
    }
    Ok(normalized)
}

pub(crate) fn persist_imported_knowledge_source(
    path: &Path,
    source: LocalFileImport,
) -> Result<LocalFileImport, String> {
    let source = normalize_imported_knowledge_source(source)?;
    let sources = read_imported_knowledge_sources(path)?;
    let sources = append_imported_knowledge_source(sources, source.clone())?;
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

/// Validate and cap the user-created schedules carried by a runtime snapshot.
/// Schedules are non-secret (name/description/when only); this keeps the field
/// lengths, weekday vocabulary, and `HH:MM` time shape bounded so a malformed
/// or hostile snapshot never echoes unvalidated data back into the shell.
fn normalize_runtime_schedules(schedules: Vec<Schedule>) -> Result<Vec<Schedule>, String> {
    let mut normalized_schedules = Vec::new();

    for schedule in schedules {
        let id = truncate_characters(
            &normalize_spaces(&schedule.id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        let name = truncate_characters(
            &normalize_spaces(&schedule.name),
            MAX_SCHEDULE_FIELD_CHARACTERS,
        );
        let description = truncate_characters(
            &normalize_spaces(&schedule.description),
            MAX_SCHEDULE_FIELD_CHARACTERS,
        );
        let day = normalize_spaces(&schedule.day);
        let time = normalize_spaces(&schedule.time);
        let created_at = normalize_spaces(&schedule.created_at);

        if id.is_empty() || name.is_empty() || created_at.is_empty() {
            return Err("Schedules need stable identifiers, names, and timestamps.".to_string());
        }

        if !SCHEDULE_WEEKDAYS.contains(&day.as_str()) {
            return Err("Schedule day is not recognized.".to_string());
        }

        if !is_valid_schedule_time(&time) {
            return Err("Schedule time must be 24-hour HH:MM.".to_string());
        }

        if normalized_schedules
            .iter()
            .any(|existing: &Schedule| existing.id == id)
        {
            continue;
        }

        normalized_schedules.push(Schedule {
            id,
            name,
            description,
            day,
            time,
            enabled: schedule.enabled,
            created_at,
        });

        if normalized_schedules.len() >= MAX_RUNTIME_SNAPSHOT_SCHEDULES {
            break;
        }
    }

    Ok(normalized_schedules)
}

/// A valid schedule time is exactly `HH:MM` in 24-hour form (00:00–23:59).
fn is_valid_schedule_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }

    let hour = value[0..2].parse::<u32>().ok();
    let minute = value[3..5].parse::<u32>().ok();
    matches!((hour, minute), (Some(h), Some(m)) if h <= 23 && m <= 59)
}

/// Normalize workspace goals created by /goal. Non-secret: id/title/statement
/// and lifecycle bookkeeping, each capped and trimmed. Deduped by id, capped
/// at MAX_RUNTIME_SNAPSHOT_GOALS.
fn normalize_runtime_goals(goals: Vec<WorkspaceGoal>) -> Result<Vec<WorkspaceGoal>, String> {
    let mut normalized_goals = Vec::new();

    for goal in goals {
        let id = truncate_characters(
            &normalize_spaces(&goal.id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        let title = truncate_characters(&normalize_spaces(&goal.title), MAX_PLAN_TITLE_CHARACTERS);
        let statement = truncate_characters(
            &normalize_spaces(&goal.statement),
            MAX_GOAL_FIELD_CHARACTERS,
        );
        let status = normalize_spaces(&goal.status);
        let created_at = normalize_spaces(&goal.created_at);
        let updated_at = normalize_spaces(&goal.updated_at);

        if id.is_empty() || title.is_empty() || statement.is_empty() || created_at.is_empty() {
            return Err(
                "Goals need stable identifiers, titles, statements, and timestamps.".to_string(),
            );
        }

        if !GOAL_STATUSES.contains(&status.as_str()) {
            return Err("Goal status is not recognized.".to_string());
        }

        if normalized_goals
            .iter()
            .any(|existing: &WorkspaceGoal| existing.id == id)
        {
            continue;
        }

        normalized_goals.push(WorkspaceGoal {
            id,
            title,
            statement,
            status,
            created_at,
            updated_at,
        });

        if normalized_goals.len() >= MAX_RUNTIME_SNAPSHOT_GOALS {
            break;
        }
    }

    Ok(normalized_goals)
}

/// Normalize structured plans created by /plan. Non-secret: id/title/steps
/// and lifecycle bookkeeping. Steps are capped in count and description
/// length; plans are deduped by id and capped at MAX_RUNTIME_SNAPSHOT_PLANS.
fn normalize_runtime_plans(plans: Vec<WorkspacePlan>) -> Result<Vec<WorkspacePlan>, String> {
    let mut normalized_plans = Vec::new();

    for plan in plans {
        let id = truncate_characters(
            &normalize_spaces(&plan.id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        let title = truncate_characters(&normalize_spaces(&plan.title), MAX_PLAN_TITLE_CHARACTERS);
        let status = normalize_spaces(&plan.status);
        let created_at = normalize_spaces(&plan.created_at);
        let updated_at = normalize_spaces(&plan.updated_at);
        let goal_id = plan
            .goal_id
            .map(|raw| normalize_spaces(&raw))
            .filter(|raw| !raw.is_empty());

        if id.is_empty() || title.is_empty() || created_at.is_empty() {
            return Err("Plans need stable identifiers, titles, and timestamps.".to_string());
        }

        if !PLAN_STATUSES.contains(&status.as_str()) {
            return Err("Plan status is not recognized.".to_string());
        }

        let mut normalized_steps = Vec::new();
        for step in plan.steps {
            let step_id = truncate_characters(
                &normalize_spaces(&step.id),
                MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
            );
            let description = truncate_characters(
                &normalize_spaces(&step.description),
                MAX_PLAN_STEP_DESCRIPTION_CHARACTERS,
            );
            if step_id.is_empty() || description.is_empty() {
                continue;
            }
            normalized_steps.push(PlanStep {
                id: step_id,
                order: step.order,
                description,
                done: step.done,
            });
            if normalized_steps.len() >= MAX_PLAN_STEPS {
                break;
            }
        }

        if normalized_plans
            .iter()
            .any(|existing: &WorkspacePlan| existing.id == id)
        {
            continue;
        }

        normalized_plans.push(WorkspacePlan {
            id,
            goal_id,
            title,
            steps: normalized_steps,
            status,
            created_at,
            updated_at,
        });

        if normalized_plans.len() >= MAX_RUNTIME_SNAPSHOT_PLANS {
            break;
        }
    }

    Ok(normalized_plans)
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

    let schedules = normalize_runtime_schedules(snapshot.schedules)?;
    let goals = normalize_runtime_goals(snapshot.goals)?;
    let plans = normalize_runtime_plans(snapshot.plans)?;

    Ok(RuntimeSnapshot {
        version: RUNTIME_SNAPSHOT_VERSION,
        active_item,
        composer_draft,
        voice_enabled: snapshot.voice_enabled,
        approval_audit,
        dismissed_approval_ids: normalize_snapshot_id_list(snapshot.dismissed_approval_ids),
        approval_rules,
        automation_statuses: normalize_runtime_automation_statuses(snapshot.automation_statuses)?,
        schedules,
        goals,
        plans,
        pinned_source_ids: normalize_snapshot_id_list(snapshot.pinned_source_ids),
        imported_knowledge_sources,
        memory_disabled: memory_state.disabled,
        memory_records: memory_state.records,
        // Provider ids only — secrets are never persisted into the snapshot.
        connected_backend_ids: normalize_snapshot_id_list(snapshot.connected_backend_ids),
        selected_model_id: truncate_characters(
            &normalize_spaces(&snapshot.selected_model_id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        ),
        permission_mode: if APPROVAL_MODES.contains(&snapshot.permission_mode.as_str()) {
            snapshot.permission_mode
        } else {
            "read-only".to_string()
        },
        saved_at,
    })
}

pub(crate) fn read_runtime_snapshot(path: &Path) -> Result<Option<RuntimeSnapshot>, String> {
    if let Some(snapshot) = crate::store::read_document(path)? {
        return normalize_runtime_snapshot(snapshot).map(Some);
    }
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
    if crate::store::write_document(path, &normalized)? {
        return Ok(normalized);
    }
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Fable could not encode runtime snapshot.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Fable could not save runtime snapshot.".to_string())?;

    Ok(normalized)
}

#[tauri::command]
pub fn list_imported_knowledge_sources(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<LocalFileImport>, String> {
    let path = imported_knowledge_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    if let Some(sources) = crate::store::read_workspace_document(&path, &scope)? {
        return Ok(sources);
    }
    read_imported_knowledge_sources(&path)
}

#[tauri::command]
pub fn import_local_knowledge_source(
    app: tauri::AppHandle,
    candidate: LocalTextFileCandidate,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<LocalFileImport, String> {
    let imported = import_local_text_file(candidate)?;
    let path = imported_knowledge_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    if crate::store::try_global().is_some() {
        let mut sources: Vec<LocalFileImport> =
            crate::store::read_workspace_document(&path, &scope)?.unwrap_or_default();
        sources = append_imported_knowledge_source(sources, imported.clone())?;
        crate::store::write_workspace_document(&path, &scope, &sources)?;
        return Ok(imported);
    }
    persist_imported_knowledge_source(&path, imported)
}

#[tauri::command]
pub fn load_runtime_snapshot(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Option<RuntimeSnapshot>, String> {
    let path = runtime_snapshot_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    if let Some(snapshot) = crate::store::read_workspace_document(&path, &scope)? {
        return normalize_runtime_snapshot(snapshot).map(Some);
    }
    read_runtime_snapshot(&path)
}

#[tauri::command]
pub fn save_runtime_snapshot(
    app: tauri::AppHandle,
    snapshot: RuntimeSnapshot,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    let path = runtime_snapshot_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    let normalized = normalize_runtime_snapshot(snapshot)?;
    if crate::store::write_workspace_document(&path, &scope, &normalized)? {
        return Ok(normalized);
    }
    write_runtime_snapshot(&path, normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{PlanStep, WorkspaceGoal, WorkspacePlan};
    use std::collections::BTreeMap;

    /// Build a minimal valid RuntimeSnapshot, defaulting the unrelated fields
    /// so goal/plan normalization can be exercised in isolation.
    fn base_snapshot() -> RuntimeSnapshot {
        RuntimeSnapshot {
            version: RUNTIME_SNAPSHOT_VERSION,
            active_item: "chat".to_string(),
            composer_draft: String::new(),
            voice_enabled: false,
            approval_audit: Vec::new(),
            dismissed_approval_ids: Vec::new(),
            approval_rules: Vec::new(),
            automation_statuses: BTreeMap::new(),
            schedules: Vec::new(),
            goals: Vec::new(),
            plans: Vec::new(),
            pinned_source_ids: Vec::new(),
            imported_knowledge_sources: Vec::new(),
            memory_disabled: false,
            memory_records: Vec::new(),
            connected_backend_ids: Vec::new(),
            selected_model_id: String::new(),
            permission_mode: "read-only".to_string(),
            saved_at: "2026-06-29T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn deleted_local_source_cannot_be_resurrected_by_reimport() {
        let candidate = LocalTextFileCandidate {
            name: "deleted.md".to_string(),
            content: "same content".to_string(),
            size_bytes: "same content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        };
        let incoming = import_local_text_file(candidate).unwrap();
        let mut tombstone = incoming.clone();
        tombstone.deleted_at = Some("2026-07-01T01:00:00Z".to_string());
        assert!(append_imported_knowledge_source(vec![tombstone], incoming).is_err());
    }

    #[test]
    fn save_merge_preserves_deleted_source_tombstones() {
        let deleted = import_local_text_file(LocalTextFileCandidate {
            name: "deleted.md".to_string(),
            content: "deleted content".to_string(),
            size_bytes: "deleted content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        })
        .unwrap();
        let active = import_local_text_file(LocalTextFileCandidate {
            name: "active.md".to_string(),
            content: "active content".to_string(),
            size_bytes: "active content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        })
        .unwrap();
        let mut tombstone = deleted.clone();
        tombstone.deleted_at = Some("2026-07-01T01:00:00Z".to_string());

        let merged =
            merge_deleted_imported_tombstones(vec![active], vec![tombstone.clone()]).unwrap();
        assert!(merged
            .iter()
            .any(|source| source.id == tombstone.id && source.deleted_at.is_some()));
        assert!(merge_deleted_imported_tombstones(vec![deleted], vec![tombstone]).is_err());
    }

    #[test]
    fn normalizes_and_preserves_goals_through_round_trip() {
        let mut snapshot = base_snapshot();
        snapshot.goals = vec![WorkspaceGoal {
            id: "goal-1".to_string(),
            title: "Ship v2 onboarding".to_string(),
            statement: "Ship the v2 onboarding flow by July.".to_string(),
            status: "active".to_string(),
            created_at: "2026-06-29T12:00:00Z".to_string(),
            updated_at: "2026-06-29T12:00:00Z".to_string(),
        }];

        let normalized = normalize_runtime_snapshot(snapshot).expect("snapshot normalizes");

        assert_eq!(normalized.goals.len(), 1);
        assert_eq!(normalized.goals[0].id, "goal-1");
        assert_eq!(normalized.goals[0].title, "Ship v2 onboarding");
        assert_eq!(normalized.goals[0].status, "active");

        // A second normalization (the round trip through save/load) is stable.
        let twice = normalize_runtime_snapshot(normalized).expect("re-normalizes");
        assert_eq!(twice.goals.len(), 1);
        assert_eq!(twice.goals[0].id, "goal-1");
    }

    #[test]
    fn rejects_a_goal_with_an_unrecognized_status() {
        let mut snapshot = base_snapshot();
        snapshot.goals = vec![WorkspaceGoal {
            id: "goal-1".to_string(),
            title: "Bad status".to_string(),
            statement: "Statement.".to_string(),
            status: "unknown".to_string(),
            created_at: "2026-06-29T12:00:00Z".to_string(),
            updated_at: "2026-06-29T12:00:00Z".to_string(),
        }];

        assert!(normalize_runtime_snapshot(snapshot).is_err());
    }

    #[test]
    fn normalizes_and_preserves_plans_with_steps() {
        let mut snapshot = base_snapshot();
        snapshot.plans = vec![WorkspacePlan {
            id: "plan-1".to_string(),
            goal_id: Some("goal-1".to_string()),
            title: "Migration plan".to_string(),
            steps: vec![
                PlanStep {
                    id: "step-1".to_string(),
                    order: 1,
                    description: "Audit the current store.".to_string(),
                    done: false,
                },
                PlanStep {
                    id: "step-2".to_string(),
                    order: 2,
                    description: "Implement the encrypted repo.".to_string(),
                    done: false,
                },
            ],
            status: "draft".to_string(),
            created_at: "2026-06-29T12:00:00Z".to_string(),
            updated_at: "2026-06-29T12:00:00Z".to_string(),
        }];

        let normalized = normalize_runtime_snapshot(snapshot).expect("snapshot normalizes");

        assert_eq!(normalized.plans.len(), 1);
        assert_eq!(normalized.plans[0].steps.len(), 2);
        assert_eq!(normalized.plans[0].goal_id.as_deref(), Some("goal-1"));
    }

    #[test]
    fn defaults_goals_and_plans_when_absent_so_old_snapshots_parse() {
        // A snapshot serialized before goals/plans existed deserializes with the
        // serde defaults (empty vecs) and normalizes cleanly.
        let json = r#"{
            "version": 1,
            "activeItem": "chat",
            "composerDraft": "",
            "voiceEnabled": false,
            "approvalAudit": [],
            "dismissedApprovalIds": [],
            "approvalRules": [],
            "automationStatuses": {},
            "schedules": [],
            "pinnedSourceIds": [],
            "importedKnowledgeSources": [],
            "memoryDisabled": false,
            "memoryRecords": [],
            "connectedBackendIds": [],
            "selectedModelId": "",
            "permissionMode": "read-only",
            "savedAt": "2026-06-29T12:00:00Z"
        }"#;
        let snapshot: RuntimeSnapshot = serde_json::from_str(json).expect("parses old snapshot");
        assert!(snapshot.goals.is_empty());
        assert!(snapshot.plans.is_empty());

        let normalized = normalize_runtime_snapshot(snapshot).expect("normalizes");
        assert!(normalized.goals.is_empty());
        assert!(normalized.plans.is_empty());
    }

    #[test]
    fn dedupes_goals_by_id() {
        let mut snapshot = base_snapshot();
        snapshot.goals = vec![
            WorkspaceGoal {
                id: "goal-1".to_string(),
                title: "First".to_string(),
                statement: "One.".to_string(),
                status: "active".to_string(),
                created_at: "2026-06-29T12:00:00Z".to_string(),
                updated_at: "2026-06-29T12:00:00Z".to_string(),
            },
            WorkspaceGoal {
                id: "goal-1".to_string(),
                title: "Duplicate".to_string(),
                statement: "Two.".to_string(),
                status: "active".to_string(),
                created_at: "2026-06-29T12:00:00Z".to_string(),
                updated_at: "2026-06-29T12:00:00Z".to_string(),
            },
        ];

        let normalized = normalize_runtime_snapshot(snapshot).expect("snapshot normalizes");
        assert_eq!(normalized.goals.len(), 1);
        assert_eq!(normalized.goals[0].title, "First");
    }
}
